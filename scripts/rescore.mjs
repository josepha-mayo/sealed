// Independent MPC-score verification on revealed positions.
//
// The chain of custody a judge can replay by hand:
//   plaintext answer (bank JSON)
//     → answerHash = trunc64(sha256("sealed/v1/answer\0" ‖ id ‖ idx ‖ canonical))
//     → Reveal.hashes on-chain (authority-declassified fingerprints)
//   model output (artifact JSON)
//     → outputHash u64s → chunkOutLeaf merkle → outputs_root
//     → Run.outputs_root on-chain (committed BEFORE scoring)
//   score_chunk (MPC) compared hash equality per position → Run.correct
//
// This script recomputes every layer with zero trust in the harness: bank →
// fingerprints → reveals → artifact → root → independent count → Run.correct.
//
// Usage:
//   node scripts/rescore.mjs --bank bank/cal-77007.json --run runs/artifact.json \
//        --benchmark <pk> [--rpc http://127.0.0.1:8899] [--run-pubkey <pk>]
//   node scripts/rescore.mjs --bank ... --run ... --benchmark ... --snapshot web/snapshot.json
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEALED_PID = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const DISC = { benchmark: "39fc2136718de9f7", run: "c7369b56eb73f6bd", reveal: "fbaa9323ea6c0e95" };

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const need = (k) => { if (!args[k]) { console.error(`missing --${k}`); process.exit(2); } return args[k]; };

const sha = (u8) => createHash("sha256").update(u8).digest();
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const b58 = (u8) => new PublicKey(u8).toBase58();
const utf8 = (s) => new TextEncoder().encode(s);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
const trunc64 = (d) => d.readBigUInt64LE(0);
const D_ANS = utf8("sealed/v1/answer\0"), D_ITEM = utf8("sealed/v1/item\0");
const D_OUT = utf8("sealed/v1/output\0"), D_COUT = utf8("sealed/v1/chunkout\0"), D_NODE = Buffer.from([1]);
const CHUNK = 32, PART = 8;

const answerHash = (id, i, canon) => trunc64(sha(cat(D_ANS, u32le(id), u32le(i), utf8(canon))));
const itemLeaf = (id, i, salt, prompt) => sha(cat(D_ITEM, u32le(id), u32le(i), salt, utf8(prompt)));
const chunkOutLeaf = (c, outs) => sha(cat(D_COUT, u32le(c).subarray(0, 2), ...outs.map(u64le)));
function merkleRoot(leaves) {
  if (!leaves.length) return Buffer.alloc(32);
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(sha(cat(D_NODE, level[i], level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, SEALED_PID)[0].toBase58();

let pass = 0, fail = 0, notes = 0;
const ok = (n, d = "") => { pass++; console.log(`  PASS  ${n}${d ? " — " + d : ""}`); };
const bad = (n, d = "") => { fail++; console.log(`  FAIL  ${n}${d ? " — " + d : ""}`); };
const note = (n, d = "") => { notes++; console.log(`  note  ${n}${d ? " — " + d : ""}`); };

// ---------- load ----------
const bank = JSON.parse(readFileSync(need("bank"), "utf8"));
const artifact = JSON.parse(readFileSync(need("run"), "utf8"));
const benchPk = need("benchmark");
console.log(`bank id=${bank.benchmarkId} items=${bank.items.length}  artifact model=${artifact.model}`);

// ---------- fetch accounts (RPC or snapshot bundle) ----------
let accounts = new Map(); // pubkey -> Buffer
if (args.snapshot) {
  // cwd-relative wins over repo-root-relative so `web/snapshot.json` works
  // identically from the repo root and from packages/harness
  const snapPath = existsSync(args.snapshot) ? args.snapshot : join(ROOT, args.snapshot);
  const snap = JSON.parse(readFileSync(snapPath, "utf8"));
  for (const a of [...(snap.sealed ?? []), ...(snap.market ?? []), ...(snap.accounts ?? [])])
    accounts.set(a.pubkey, Buffer.from(a.data, "base64"));
  note("source", `snapshot bundle (${accounts.size} accounts)`);
} else {
  const conn = new Connection(args.rpc || "http://127.0.0.1:8899", "confirmed");
  const pks = [new PublicKey(benchPk)];
  const reveals = [];
  for (let c = 0; c < bank.chunkCount; c++)
    for (let p = 0; p < 4; p++)
      reveals.push(pda([utf8("reveal"), new PublicKey(benchPk).toBuffer(), u32le(c).subarray(0, 2), new Uint8Array([p])]));
  pks.push(...reveals.map((r) => new PublicKey(r)));
  const infos = await conn.getMultipleAccountsInfo(pks);
  pks.forEach((k, i) => { if (infos[i]) accounts.set(k.toBase58(), infos[i].data); });
  // run account: passed explicitly or found by scanning for outputs_root match
  if (args["run-pubkey"]) {
    const ri = await conn.getAccountInfo(new PublicKey(args["run-pubkey"]));
    if (ri) accounts.set(args["run-pubkey"], ri.data);
  } else {
    const scan = await conn.getProgramAccounts(SEALED_PID);
    for (const { pubkey, account } of scan) accounts.set(pubkey.toBase58(), account.data);
  }
  note("source", `${args.rpc || "localnet"} (${accounts.size} accounts fetched)`);
}

// ---------- parse ----------
const bench = accounts.get(benchPk);
if (!bench || hex(bench.subarray(0, 8)) !== DISC.benchmark) { bad("benchmark account", "missing or wrong type"); process.exit(1); }
const bv = new DataView(bench.buffer, bench.byteOffset);
const onchainId = bv.getUint32(40, true);
const itemsRootChain = hex(bench.subarray(8 + 32 + 4 + 1 + 1 + 2 + 2, 8 + 32 + 4 + 1 + 1 + 2 + 2 + 32));

const revealsByPos = new Map(); // global index -> revealed u64
let revealCount = 0;
for (const [k, d] of accounts) {
  if (d.length < 116 || hex(d.subarray(0, 8)) !== DISC.reveal) continue;
  const v = new DataView(d.buffer, d.byteOffset);
  if (b58(d.subarray(8, 40)) !== benchPk) continue;
  const chunk = v.getUint16(40, true), part = d[42];
  const expected = pda([utf8("reveal"), new PublicKey(benchPk).toBuffer(), u32le(chunk).subarray(0, 2), new Uint8Array([part])]);
  if (k !== expected) { bad(`reveal pda ${chunk}/${part}`, `${k} != ${expected}`); continue; }
  for (let j = 0; j < PART; j++) {
    const g = chunk * CHUNK + part * PART + j;
    revealsByPos.set(g, v.getBigUint64(52 + j * 8, true));
  }
  revealCount++;
}

let run = null, runPk = null;
for (const [k, d] of accounts) {
  if (d.length < 148 || hex(d.subarray(0, 8)) !== DISC.run) continue;
  if (b58(d.subarray(8, 40)) !== benchPk) continue;
  const v = new DataView(d.buffer, d.byteOffset);
  const root = hex(d.subarray(8 + 32 + 32 + 8 + 1 + 1 + 2 + 8 + 8 + 4 + 8 + 8 + 32, 8 + 32 + 32 + 8 + 1 + 1 + 2 + 8 + 8 + 4 + 8 + 8 + 32 + 32));
  if (args["run-pubkey"] ? k === args["run-pubkey"] : root === artifact.outputsRoot) { run = d; runPk = k; }
}
if (!run) { bad("run account", `no run on ${benchPk} with outputs_root=${artifact.outputsRoot?.slice(0, 16)}…`); process.exit(1); }
{
  const v = new DataView(run.buffer, run.byteOffset); let o = 8 + 32;
  const runner = b58(run.subarray(o, o + 32)); o += 32;
  const index = v.getBigUint64(o, true); o += 8 + 1;
  const status = run[o++]; o += 2 + 8 + 8;
  const correct = v.getUint32(o, true); o += 4 + 8 + 8 + 32;
  const outputsRoot = hex(run.subarray(o, o + 32)); o += 32;
  const ml = v.getUint32(o, true); o += 4;
  const modelId = new TextDecoder().decode(run.subarray(o, o + ml)); o += ml;
  run = { runner, index, status, correct, outputsRoot, modelId };
}

// ---------- layer 1: plaintext → fingerprints ----------
let badHash = 0;
for (const it of bank.items) {
  const recomputed = answerHash(bank.benchmarkId, it.index, it.answer);
  if (recomputed !== BigInt(it.answerHash)) badHash++;
}
badHash === 0
  ? ok("answer fingerprints", `all ${bank.items.length} answerHash values recompute from plaintext`)
  : bad("answer fingerprints", `${badHash} mismatches`);

// ---------- layer 2: items_root (salted prompt commitment) ----------
const leaves = bank.items.map((it) => itemLeaf(bank.benchmarkId, it.index, Buffer.from(it.salt, "hex"), it.prompt));
const itemsRootRecomputed = hex(merkleRoot(leaves));
itemsRootRecomputed === bank.itemsRoot && itemsRootRecomputed === itemsRootChain
  ? ok("items_root", `${itemsRootRecomputed.slice(0, 16)}… == file == on-chain`)
  : bad("items_root", `recomputed ${itemsRootRecomputed.slice(0, 16)}… file ${bank.itemsRoot?.slice(0, 16)}… chain ${itemsRootChain.slice(0, 16)}…`);

// ---------- layer 3: reveals carry exactly the recomputed fingerprints ----------
let revealMismatch = 0, revealedPositions = 0;
for (const [pos, h] of revealsByPos) {
  const it = bank.items[pos];
  if (!it) { revealMismatch++; continue; }
  revealedPositions++;
  if (h !== answerHash(bank.benchmarkId, it.index, it.answer)) revealMismatch++;
}
if (revealCount === 0) note("reveals", "none on-chain — positions not yet declassified");
else revealMismatch === 0
  ? ok("revealed fingerprints", `${revealedPositions} positions: on-chain Reveal.hashes == recomputed answerHash`)
  : bad("revealed fingerprints", `${revealMismatch}/${revealedPositions} mismatches`);

// ---------- layer 4: artifact → outputs_root → run ----------
const outs = artifact.items.map((r) => BigInt(r.outputHash));
const outLeaves = [];
for (let c = 0; c * CHUNK < outs.length; c++) {
  const ch = outs.slice(c * CHUNK, (c + 1) * CHUNK);
  while (ch.length < CHUNK) ch.push(0n);
  outLeaves.push(chunkOutLeaf(c, ch));
}
const rootRecomputed = hex(merkleRoot(outLeaves));
rootRecomputed === artifact.outputsRoot && rootRecomputed === run.outputsRoot
  ? ok("outputs_root binding", `${rootRecomputed.slice(0, 16)}… == artifact == Run.outputs_root`)
  : bad("outputs_root binding", `recomputed ${rootRecomputed.slice(0, 16)}… artifact ${artifact.outputsRoot} run ${run.outputsRoot}`);

// ---------- layer 5: independent rescore ----------
let indep = 0, scorable = 0;
for (const it of bank.items) {
  if (!revealsByPos.has(it.index)) continue;
  scorable++;
  if (BigInt(artifact.items[it.index].outputHash) === revealsByPos.get(it.index)) indep++;
}
if (scorable === 0) note("rescore", "no revealed positions — cannot independently rescore yet");
else if (scorable === bank.items.length)
  indep === run.correct
    ? ok("FULL independent rescore", `recomputed ${indep}/${scorable} == MPC-written Run.correct ${run.correct}`)
    : bad("FULL independent rescore", `recomputed ${indep} != Run.correct ${run.correct}`);
else
  note("partial rescore", `${indep}/${scorable} revealed positions match (run total ${run.correct}/${bank.items.length})`);

run.status === 1 ? ok("run finalized", `status=1, post_reveal flag visible on-chain`) : bad("run finalized", `status=${run.status}`);
artifact.localCorrect === indep && scorable === bank.items.length
  ? ok("local pre-score consistency", `localCorrect ${artifact.localCorrect} == independent ${indep}`)
  : note("local pre-score", `localCorrect=${artifact.localCorrect} indep=${indep} (diff = positions MPC saw differently)`);

console.log(`\n${pass} PASS / ${fail} FAIL / ${notes} notes — run ${runPk} model=${run.modelId}`);
process.exit(fail ? 1 : 0);
