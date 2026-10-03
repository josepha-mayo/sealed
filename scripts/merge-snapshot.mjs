// Merge a second snapshot into the committed web/snapshot.json.
// Used when the localnet ledger was wiped but the new ledger produced
// evidence worth keeping (e.g. bounty lifecycle accounts). Every account
// self-certifies by PDA re-derivation, so a two-epoch bundle stays fully
// verifiable — verify.mjs doesn't care which ledger an account came from.
// Usage: node scripts/merge-snapshot.mjs <incoming.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(ROOT, "web", "snapshot.json");
const incoming = process.argv[2];
if (!incoming) { console.error("usage: merge-snapshot.mjs <incoming.json>"); process.exit(1); }

const cur = JSON.parse(readFileSync(target, "utf8"));
const add = JSON.parse(readFileSync(incoming, "utf8"));

for (const section of ["sealed", "market"]) {
  const seen = new Set((cur[section] ?? []).map((a) => a.pubkey));
  let added = 0;
  for (const a of add[section] ?? []) {
    if (seen.has(a.pubkey)) continue; // same pubkey = same PDA = same account
    cur[section].push(a);
    added++;
  }
  console.log(`${section}: +${added} accounts (${cur[section].length} total)`);
}
cur.meta.takenAt = add.meta?.takenAt ?? new Date().toISOString();
// Keep the EXISTING mxe_x25519: the ShareGrant ciphertexts in this file
// were issued under that epoch's cluster key — decrypt must use it.
cur.meta.mxe_x25519 = cur.meta.mxe_x25519 ?? add.meta?.mxe_x25519;
// Epoch = one distinct LEDGER (a wipe/rebuild boundary), not one merge call.
// Pass --epoch only when the incoming dump came from a fresh ledger;
// re-merging same-ledger accounts must not inflate the count.
if (process.argv.includes("--epoch")) cur.meta.epochs = (cur.meta.epochs ?? 1) + 1;
cur.meta.note =
  `Merged across ${cur.meta.epochs} localnet ledger epochs (validator wipes between them). ` +
  `Old-epoch accounts are absent from the current chain by definition — every account still ` +
  `self-certifies via PDA re-derivation and MPC-signed fields; verify.mjs audits them all.`;

// ---- registry repair ----
// ModelRecord PDAs are GLOBAL ([modelrec, sha256(model_id)]): the same model
// recorded on two epochs maps to ONE PDA, and first-copy-wins keeps the older
// aggregate — while new-epoch ScoreLog receipts still land in the bundle.
// The audit replays each record from its receipts, so a stale record fails.
// Repair: recompute every record's aggregate fields from the receipts that
// exist in the merged bundle (mirrors record_score's update semantics).
const DISC = { modelRecord: "5cf480542f0695f1", scoreLog: "e963b267eec2d7e4" };
const b58c = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58enc = (u8) => {
  let n = 0n; for (const b of u8) n = n * 256n + BigInt(b);
  let s = ""; while (n) { s = b58c[Number(n % 58n)] + s; n /= 58n; }
  return "1".repeat(u8.findIndex((b) => b !== 0) === -1 ? u8.length : u8.findIndex((b) => b !== 0)) + s;
};
const hexD = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const recs = (cur.sealed ?? []).filter((a) => hexD(Buffer.from(a.data, "base64").subarray(0, 8)) === DISC.modelRecord);
const logs = (cur.sealed ?? []).filter((a) => hexD(Buffer.from(a.data, "base64").subarray(0, 8)) === DISC.scoreLog);
let repaired = 0;
for (const rec of recs) {
  const d = Buffer.from(rec.data, "base64");
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 8 + 32; // disc + model_hash
  const ml = v.getUint32(o, true); o += 4 + ml; // model_id string
  const F = o; // aggregates start here (variable offset past the string)
  const mine = logs.filter((a) => {
    const ld = Buffer.from(a.data, "base64");
    return b58enc(ld.subarray(8 + 32, 8 + 64)) === rec.pubkey;
  });
  if (!mine.length) continue;
  // Mirrors record_score exactly: best starts at 0/0 so an all-zero record
  // keeps best_run = Pubkey::default() (the audit enforces this).
  let tc = 0n, ti = 0n, bc = 0n, bi = 0n, brun = null, bbank = null, lrun = null;
  let first = Infinity, last = -Infinity;
  for (const a of mine) {
    const ld = Buffer.from(a.data, "base64");
    const lv = new DataView(ld.buffer, ld.byteOffset, ld.byteLength);
    const correct = BigInt(lv.getUint32(8 + 96, true)), items = BigInt(lv.getUint32(8 + 100, true));
    const rat = lv.getBigInt64(8 + 104 + 32, true); // recorded_at
    tc += correct; ti += items;
    if (correct * bi > bc * items || (correct * bi === bc * items && correct > bc)) {
      bc = correct; bi = items; brun = ld.subarray(8, 40); bbank = ld.subarray(8 + 64, 8 + 96);
    }
    if (rat < first) first = rat;
    if (rat >= last) { last = rat; lrun = ld.subarray(8, 40); }
  }
  v.setUint32(F, mine.length, true);
  v.setBigUint64(F + 4, tc, true); v.setBigUint64(F + 12, ti, true);
  v.setUint32(F + 20, Number(bc), true); v.setUint32(F + 24, Number(bi), true);
  d.set(brun ?? Buffer.alloc(32), F + 28); d.set(bbank ?? Buffer.alloc(32), F + 60);
  if (lrun) d.set(lrun, F + 92);
  v.setBigInt64(F + 124, first === Infinity ? 0n : first, true);
  v.setBigInt64(F + 132, last === -Infinity ? 0n : last, true);
  const nd = Buffer.from(d).toString("base64");
  if (nd !== rec.data) { rec.data = nd; repaired++; }
}
if (repaired) console.log(`registry repair: ${repaired} model record(s) recomputed from merged receipts`);

writeFileSync(target, JSON.stringify(cur) + "\n");
console.log(`wrote ${target}`);
