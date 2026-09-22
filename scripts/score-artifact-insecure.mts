/**
 * Deliberately score a STALE/UNBOUND run artifact — bypassing the items_root
 * guard — to prove that client-side validation is a UX convenience, NOT the
 * security boundary. The MPC cluster compares each submitted output hash to
 * the sealed on-chain answer fingerprints, so a stale artifact still gets
 * scored honestly (and low). This recreates the 1/64 anti-cheat run.
 *
 * Usage:
 *   npx tsx scripts/score-artifact-insecure.mts \
 *     --bank packages/harness/bank/gen-25864.json \
 *     --run docs/evidence/run-25864-stale-artifact.json \
 *     --authority <bank-authority-pubkey>
 */
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { score } from "../packages/harness/src/chain.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const bankPath = arg("bank");
const runPath = arg("run");
const authority = arg("authority");
if (!bankPath || !runPath || !authority) {
  console.error("usage: score-artifact-insecure.mts --bank <file> --run <file> --authority <pubkey>");
  process.exit(2);
}

const bank = JSON.parse(readFileSync(bankPath, "utf8"));
const run = JSON.parse(readFileSync(runPath, "utf8"));

console.log("== insecure score: bypassing items_root binding ==");
console.log(`artifact itemsRoot: ${run.itemsRoot ?? "(missing)"}`);
const r = await score(bank, run, new PublicKey(authority), false, undefined, undefined, true);
console.log(`scored (dishonestly or not — the MPC tally stands): ${r.toBase58()}`);
