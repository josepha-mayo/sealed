// Dump the Arcium-side infrastructure this deployment touches — the six
// computation-definition accounts, their raw-circuit bytecode accounts,
// the MXE, and the cluster — to web/arcium-infra.json. The circuit card
// binds CONTENT (sha256 of the bytes the cluster executes), not just
// identity (PDAs). Manifest-pinned so the bytes ride the bundle root.
// Usage: node scripts/arcium-infra.mjs [--rpc <url>] [--out <file>]
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const rpc = flag("--rpc") || "https://api.devnet.solana.com";
const out = flag("--out") || "web/arcium-infra.json";

const SEALED_PID = "FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ";
const ARCIUM_PID = "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ";
const CLUSTER_OFFSET = 456;
const CIRCUITS = ["seal_part", "score_chunk", "gen_part", "gen_part_private", "reveal_part", "reshare_part"];

const { createHash } = await import("node:crypto");
const { PublicKey } = await import("@solana/web3.js");

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const compDefOffset = (name) => createHash("sha256").update(Buffer.from(name, "utf8")).digest().readUInt32LE(0);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];

async function getMultiple(pubkeys) {
  const out = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const res = await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts",
        params: [pubkeys.slice(i, i + 100).map((p) => p.toBase58()), { encoding: "base64" }] }),
    });
    const j = await res.json();
    if (j.error) throw new Error("getMultipleAccounts: " + j.error.message);
    out.push(...j.result.value);
  }
  return out;
}

const arc = new PublicKey(ARCIUM_PID);
const sealed = new PublicKey(SEALED_PID);
const wanted = [];
for (const name of CIRCUITS) {
  const cd = pda([Buffer.from("ComputationDefinitionAccount"), sealed.toBuffer(), u32(compDefOffset(name))], arc);
  wanted.push({ what: "compdef:" + name, pk: cd });
  // RawCircuit accounts hold the bytecode — probe indices until absent.
  for (let i = 0; i < 16; i++)
    wanted.push({ what: "raw:" + name + ":" + i, pk: pda([Buffer.from("ComputationDefinitionRaw"), cd.toBuffer(), Buffer.from([i])], arc) });
}
wanted.push({ what: "mxe", pk: pda([Buffer.from("MXEAccount"), sealed.toBuffer()], arc) });
wanted.push({ what: "cluster", pk: pda([Buffer.from("Cluster"), u32(CLUSTER_OFFSET)], arc) });

const infos = await getMultiple(wanted.map((w) => w.pk));
const accounts = [];
const missing = [];
wanted.forEach((w, i) => {
  const a = infos[i];
  if (a) accounts.push({ pubkey: w.pk.toBase58(), what: w.what, data: a.data[0] });
  else if (w.what.indexOf("raw:") !== 0 || w.what.endsWith(":0")) missing.push(w.what); // absent raw i>0 just ends the list
});
if (missing.length) throw new Error("missing expected arcium accounts: " + missing.join(", "));

const doc = {
  kind: "sealed-arcium-infra/v1",
  takenAt: new Date().toISOString(),
  rpc,
  programs: { arcium: ARCIUM_PID, sealed: SEALED_PID },
  clusterOffset: CLUSTER_OFFSET,
  accounts: accounts.sort((a, b) => a.pubkey.localeCompare(b.pubkey)),
};
const { writeFileSync } = await import("node:fs");
writeFileSync(out, JSON.stringify(doc) + "\n");
const bytes = accounts.reduce((n, a) => n + Buffer.from(a.data, "base64").length, 0);
console.log("wrote " + out + " — " + accounts.length + " arcium accounts, " + (bytes / 1024).toFixed(0) + "KB raw (compdefs+bytecode+mxe+cluster)");
