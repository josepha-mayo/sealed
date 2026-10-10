#!/usr/bin/env node
// mini-resolver — a THIRD-PARTY consumer of Sealed's scored outputs.
// Nothing here imports the sealed codebase, its IDL, or its SDK: this file
// implements the integrator contract from docs/integrate.md from scratch —
// owner+discriminator gate, fixed-offset field reads, honesty flags — to
// prove the read surface composes without trust and without permission.
//
//   node examples/mini-resolver.mjs [snapshot.json]
//
// What it does: scans the committed evidence snapshot for `Run` accounts
// (the sealed program's scored-output record), applies the resolver gates
// a real venue must honor, then settles a toy two-bettor parimutuel escrow
// off the MPC-written `correct` field — the same field the bundled market
// program reads on-chain.
//
// Why this exists: "composable" is claimed a lot. This is a runnable
// consumer that is NOT the bundled market program — a venue that didn't
// exist when these scores were written still settles on them correctly.
//
// It also re-derives each Run's PDA from its own fields — a fabricated
// account would land on a different address — with zero dependencies:
// ed25519 off-curve check via the Legendre symbol, base58 in ~20 lines.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SNAP = process.argv[2] ?? "web/snapshot.json";
const SEALED_PROGRAM = "FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ";
// sha256("account:Run")[:8] — the Anchor discriminator, derived not copied
const RUN_DISC = createHash("sha256").update("account:Run").digest().subarray(0, 8);

// --- the integrate.md contract, reimplemented ------------------------------
// Run layout (programs/sealed/src/lib.rs `pub struct Run`):
//   disc(8) benchmark(32) runner(32) index(8) bump(1) status(1)
//   chunk_count(2) pending_mask(8) scored_mask(8) correct(4) created_at(8)
//   finalized_at(8) harness_hash(32) outputs_root(32)
//   model_id(4B len + bytes) attested(1) attested_at(8) pending_since(8)
//   first_pending_at(8) all_queued_at(8) ... post_reveal(1) @ 229+modelLen
const OFF_STATUS = 81, OFF_PENDING = 84, OFF_SCORED = 92, OFF_CORRECT = 100;
const OFF_OUTPUTS = 152, OFF_MLEN = 184;
const RUN_FINALIZED = 1;

// --- PDA re-derivation, dependency-free -------------------------------------
// Solana PDA = sha256(seeds || program_id || "ProgramDerivedAddress"), valid
// only if the 32 bytes do NOT decompress to an ed25519 point. The off-curve
// test is the Legendre symbol of x² = (y²−1)/(d·y²+1) over Fp, p = 2²⁵⁵−19.
const FP = (1n << 255n) - 19n;
const modpow = (b, e, m = FP) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
const ED_D = (FP - 121665n) * modpow(121666n, FP - 2n) % FP;
const isOnCurve = (bytes) => {
  const y = BigInt("0x" + Buffer.from(bytes).reverse().toString("hex")) & ((1n << 255n) - 1n);
  const y2 = y * y % FP;
  const x2 = (y2 - 1n + FP) % FP * modpow((ED_D * y2 + 1n) % FP, FP - 2n) % FP;
  return x2 === 0n || modpow(x2, (FP - 1n) / 2n) === 1n;
};
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58dec = (s) => {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let h = n.toString(16); if (h.length % 2) h = "0" + h;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(h, "hex");
  const zeros = s.length - s.replace(/^1+/, "").length; // each leading "1" = one zero byte
  return Buffer.concat([Buffer.alloc(zeros), body]);
};
const b58enc = (buf) => {
  let n = BigInt("0x" + buf.toString("hex")); let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of buf) { if (byte === 0) s = "1" + s; else break; }
  return s;
};
const PID = b58dec(SEALED_PROGRAM);
// Run PDA seeds (programs/sealed/src/lib.rs): ["run", benchmark, index_u64le]
const OFF_BENCH = 8, OFF_INDEX = 72, OFF_BUMP = 80;
const rederivePda = (data) => {
  const hash = createHash("sha256").update(Buffer.concat([
    Buffer.from("run"), data.subarray(OFF_BENCH, OFF_BENCH + 32),
    data.subarray(OFF_INDEX, OFF_INDEX + 8), data.subarray(OFF_BUMP, OFF_BUMP + 1),
    PID, Buffer.from("ProgramDerivedAddress"),
  ])).digest();
  return isOnCurve(hash) ? null : b58enc(hash); // on-curve hash ⇒ not a valid PDA
};

function decodeRun(data) {
  if (data.length < 232) return null;
  if (!data.subarray(0, 8).equals(RUN_DISC)) return null;          // discriminator gate
  const ml = data.readUInt32LE(OFF_MLEN);
  const model = data.subarray(OFF_MLEN + 4, OFF_MLEN + 4 + ml).toString("utf8");
  return {
    status: data.readUInt8(OFF_STATUS),
    pendingMask: data.readBigUInt64LE(OFF_PENDING),
    scoredMask: data.readBigUInt64LE(OFF_SCORED),
    correct: data.readUInt32LE(OFF_CORRECT),
    outputsRoot: data.subarray(OFF_OUTPUTS, OFF_OUTPUTS + 32).toString("hex"),
    modelId: model,
    attested: data.readUInt8(OFF_MLEN + 4 + ml) === 1,              // @ 188+ml
    postReveal: (data[229 + ml] ?? 0) !== 0,                        // tail byte
  };
}

// --- load + gate -----------------------------------------------------------
// owner gate, honestly: the snapshot's `sealed` section already groups by
// owning program — reading it is the owner check. Over RPC you'd additionally
// require account.owner === SEALED_PROGRAM before decoding anything.
const snap = JSON.parse(readFileSync(SNAP, "utf8"));
const runs = [];
for (const e of snap.sealed ?? []) {
  const data = Buffer.from(e.data, "base64");
  const r = decodeRun(data);
  if (!r) continue;
  // PDA gate: the account's own seeds must re-derive its address — a
  // fabricated run lands on a different pubkey and is dropped here.
  if (rederivePda(data) !== e.pubkey) continue;
  // honesty gates a resolver MUST honor (docs/integrate.md):
  // - status must be RUN_FINALIZED — pending scores are not final
  // - post_reveal runs are burned: the exam was declassified mid-scoring,
  //   so correctness no longer attests knowledge of a hidden key
  // - pending_mask must be 0 — a stuck chunk is not "unlucky", it's unscored
  const eligible = r.status === RUN_FINALIZED && !r.postReveal && r.pendingMask === 0n;
  runs.push({ pubkey: e.pubkey, ...r, eligible });
}
console.log(`mini-resolver — third-party consumer, no sealed code, no trust`);
console.log(`snapshot: ${SNAP} · sealed accounts scanned: ${(snap.sealed ?? []).length}`);
console.log(`gate: discriminator sha256("account:Run")[:8]=${RUN_DISC.toString("hex")} · program ${SEALED_PROGRAM.slice(0, 8)}…`);
console.log(`runs decoded: ${runs.length} · every address re-derived from its seeds · finalized+eligible: ${runs.filter((r) => r.eligible).length}`);

// pick the LOWEST-scoring eligible run — the cheat-catch is the headline:
// a model whose operator claimed a strong score, where the MPC count says
// otherwise. `correct` counts ITEMS; scored_mask is a chunk bitmap.
const eligible = runs.filter((r) => r.eligible).sort((a, b) => a.correct - b.correct);
if (!eligible.length) { console.error("no eligible runs"); process.exit(1); }
const run = eligible[0];
const chunks = run.scoredMask.toString(2).split("").filter((c) => c === "1").length;
console.log(`\nsettlement input — run ${run.pubkey.slice(0, 8)}…`);
console.log(`  model          ${run.modelId}`);
console.log(`  correct        ${run.correct} items (MPC count, across ${chunks} scored chunk${chunks === 1 ? "" : "s"})`);
console.log(`  outputs_root   ${run.outputsRoot.slice(0, 24)}…`);
console.log(`  attested       ${run.attested} · post_reveal ${run.postReveal} · pending_mask ${run.pendingMask}`);

// --- a toy parimutuel escrow settling on the MPC-written number ------------
// real venues quote absolute item thresholds ("score ≥ 32"), not fractions —
// same contract here.
const THRESHOLD = 32;
const bettors = [
  { name: "alice", side: `score ≥ ${THRESHOLD}`, stake: 0.6 },
  { name: "bob",   side: `score < ${THRESHOLD}`,  stake: 0.4 },
];
const pool = bettors.reduce((s, b) => s + b.stake, 0);
const winners = bettors.filter((b) => b.side.startsWith("score ≥") === (run.correct >= THRESHOLD));
console.log(`\ntoy escrow — ${bettors.map((b) => `${b.name} stakes ${b.stake}◎ on "${b.side}"`).join(" · ")}`);
console.log(`  pool ${pool.toFixed(3)}◎ · MPC count ${run.correct} → outcome "${run.correct >= THRESHOLD ? `score ≥ ${THRESHOLD}` : `score < ${THRESHOLD}`}"`);
for (const w of winners) {
  const payout = pool * (w.stake / winners.reduce((s, x) => s + x.stake, 0));
  console.log(`  payout         ${w.name} ← ${payout.toFixed(3)}◎ (proportional, no referee involved)`);
}
console.log(`\nverdict: a venue that didn't exist when this score was written`);
console.log(`settled on it correctly — owner+discriminator gate, honesty flags`);
console.log(`honored, zero trust in Sealed-the-team. The integrator contract`);
console.log(`in docs/integrate.md is all you need to build this yourself.`);
