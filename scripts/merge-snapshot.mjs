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
// Track the merge count honestly — each merge adds one ledger epoch to the
// bundle (the committed snapshot already contains every earlier epoch).
cur.meta.epochs = (cur.meta.epochs ?? 1) + 1;
cur.meta.note =
  `Merged across ${cur.meta.epochs} localnet ledger epochs (validator wipes between them). ` +
  `Old-epoch accounts are absent from the current chain by definition — every account still ` +
  `self-certifies via PDA re-derivation and MPC-signed fields; verify.mjs audits them all.`;
writeFileSync(target, JSON.stringify(cur) + "\n");
console.log(`wrote ${target}`);
