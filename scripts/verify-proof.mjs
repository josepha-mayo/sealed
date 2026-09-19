// Recompute a Merkle root from a prove artifact and compare with outputsRoot.
// Two-level commitment (same as score_chunk on-chain):
//   leaf = sha256("sealed/v1/chunkout\0" || u16le(chunkIndex) || 32×u64le outputs)
//   node = sha256(0x01 || left || right)
//
// Usage:
//   node scripts/verify-proof.mjs <artifact.json> [--run <pubkey>] [--rpc <url>]
// With --run, the expected root is read from the on-chain Run account (owner +
// discriminator verified); without it, the artifact's own outputsRoot is used
// (internal consistency only — weaker).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
  return v;
};
const file = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
if (!file) throw new Error("usage: verify-proof.mjs <artifact.json> [--run <pubkey>] [--rpc <url>]");
const p = JSON.parse(readFileSync(file, "utf8"));
// NB: `sealed prove --run <file>` takes a run ARTIFACT; here `--run`/`--run-pda`
// takes the on-chain run PDA pubkey — different argument kinds, kept distinct
// in usage text.
const runPk = flag("--run") || flag("--run-pda");
const rpc = flag("--rpc") || process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";

const SEALED_PID = "FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ";
const RUN_DISC = "c7369b56eb73f6bd"; // anchor discriminator of the Run account
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const D_COUT = Buffer.from("sealed/v1/chunkout\0");
const D_NODE = Buffer.from([1]);

const outputs = [...(p.chunkOutputs ?? [p.outputHash])]; // tolerate a single-output artifact
if (!Number.isInteger(p.itemIndex) || p.itemIndex < 0 || !Number.isInteger(p.chunkIndex) || p.chunkIndex < 0)
  throw new Error("malformed proof: itemIndex/chunkIndex must be non-negative integers");
if (outputs.length === 0 || outputs.length > 32)
  throw new Error("malformed proof: chunkOutputs must be 1..32 values");
if (Math.floor(p.itemIndex / 32) !== p.chunkIndex)
  throw new Error(`item ${p.itemIndex} lives in chunk ${Math.floor(p.itemIndex / 32)}, not chunk ${p.chunkIndex} — proof is for a different item`);
const slot = p.itemIndex % 32;
const toU64 = (x) => { try { return BigInt(x); } catch { throw new Error(`malformed proof: ${x} is not an integer`); } };
if (slot >= outputs.length || toU64(p.outputHash) !== toU64(outputs[slot]))
  throw new Error("outputHash does not match the committed output at that item index");
if (!Array.isArray(p.proof) || p.proof.some((s) => !/^[0-9a-fA-F]{64}$/.test(s)))
  throw new Error("malformed proof: proof must be an array of 32-byte hex strings");
while (outputs.length < 32) outputs.push(0); // chunkOutLeaf zero-pads short tails
let h = sha(D_COUT, u32(p.chunkIndex).subarray(0, 2), ...outputs.map(u64));
let i = p.chunkIndex;
for (const s of p.proof.map((x) => Buffer.from(x, "hex"))) {
  h = sha(D_NODE, i % 2 === 0 ? h : s, i % 2 === 0 ? s : h);
  i >>= 1;
}
const root = h.toString("hex");

let expected = p.outputsRoot;
let mode = "supplied artifact root (internal consistency only — pass --run to bind on-chain)";
if (runPk) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [runPk, { encoding: "base64" }] }),
  }).then((r) => r.json());
  const acct = res.result?.value;
  if (!acct) throw new Error("run account not found at " + runPk);
  if (acct.owner !== SEALED_PID) throw new Error("account is not owned by the sealed program — not a Run");
  const data = Buffer.from(acct.data[0], "base64");
  if (data.length < 192 || data.subarray(0, 8).toString("hex") !== RUN_DISC)
    throw new Error("account is not a sealed Run (discriminator mismatch)");
  expected = data.subarray(152, 184).toString("hex"); // outputs_root offset in Run
  mode = "on-chain Run.outputs_root";
}

console.log(`item ${p.itemIndex} (chunk ${p.chunkIndex}), ${outputs.length} outputs in leaf`);
console.log("recomputed:", root);
console.log(`expected (${mode}):`, expected);
console.log(root === expected ? "VERIFIED" : "MISMATCH");
