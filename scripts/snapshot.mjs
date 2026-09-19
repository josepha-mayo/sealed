// Dump every sealed + market program account to a snapshot JSON the explorer
// can render offline: web/index.html -> "load snapshot" or `?snapshot=<url>`.
// Usage: node scripts/snapshot.mjs [--rpc <url>] [--out <file>]
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const rpc = flag("--rpc") || process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const out = flag("--out");

const SEALED_PID = "FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ";
const MARKET_PID = "8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN";

async function gpa(programId) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getProgramAccounts",
      params: [programId, { encoding: "base64" }],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${programId}: ${j.error.message}`);
  if (!Array.isArray(j.result)) throw new Error(`${programId}: no result (RPC down?)`);
  return j.result
    .map(({ pubkey, account }) => ({ pubkey, data: account.data[0] }))
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey)); // stable order = clean diffs
}

const snap = {
  meta: {
    rpc, takenAt: new Date().toISOString(),
    programs: { sealed: SEALED_PID, market: MARKET_PID },
  },
  sealed: await gpa(SEALED_PID),
  market: await gpa(MARKET_PID).catch(() => []),
};
const json = JSON.stringify(snap);
if (out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, json + "\n");
  console.log(`wrote ${out} — ${snap.sealed.length} sealed + ${snap.market.length} market accounts`);
} else {
  console.log(json);
}
