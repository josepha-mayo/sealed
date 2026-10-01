// Offline cryptographic verification of the committed evidence snapshot.
// Re-derives every account's PDA from its own fields, replays items_root
// commitment folds, checks that every market resolution is a pure function
// of the linked MPC-scored run, and re-verifies bundled Merkle proofs —
// no RPC, no localnet. Usage: node scripts/verify.mjs [snapshot.json]
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { PublicKey } = require("@solana/web3.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.argv[2] || join(ROOT, "web", "snapshot.json");
const SEALED_PID = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const MARKET_PID = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const DISC = { benchmark: "39fc2136718de9f7", run: "c7369b56eb73f6bd", answerChunk: "9f457cb5a547c35a", itemChunk: "3ad5949e8388e23d", privItemChunk: "73f0ae62d80297f4", reveal: "fbaa9323ea6c0e95", shareGrant: "a47067c1839cb4c0", market: "dbbed53700e3c69a", ladder: "7d9223fe2a07ccde", position: "aabc8fe47a40f7d0", darkMarket: "94562c723ef98ba6", darkPosition: "d8c18faeae9d7715", bounty: "ed1069c61345f2ea" };

const sha = (u8) => createHash("sha256").update(u8).digest();
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const b58 = (u8) => new PublicKey(u8).toBase58();
const utf8 = (s) => new TextEncoder().encode(s);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
const D_COUT = utf8("sealed/v1/chunkout\0"), D_NODE = new Uint8Array([1]);
const D_GI = utf8("sealed/v1/genitems\0"), D_PI = utf8("sealed/v1/privitems\0");
const RUN_FINAL = 1, M_RESOLVED = 1, M_CANCELLED = 2;
const popcount64 = (n) => { let c = 0; while (n) { c += Number(n & 1n); n >>= 1n; } return c; };
const outcomeOf = (edges, n, score) => { let i = 0; while (i < n - 1 && score >= edges[i]) i++; return i; };

let pass = 0, fail = 0, skip = 0;
const ok = (name, detail = "") => { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); };
const bad = (name, detail = "") => { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); };
const note = (name, detail = "") => { skip++; console.log(`  note  ${name}${detail ? " — " + detail : ""}`); };
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0].toBase58();
const pk = (s) => new PublicKey(s).toBuffer();

// ---------- parsers (same layouts as web/index.html) ----------
function parseBenchmark(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  const authority = b58(d.slice(o, o + 32)); o += 32;
  const id = v.getUint32(o, true); o += 4; o += 1;
  const status = d[o++]; const chunkCount = v.getUint16(o, true); o += 2;
  const chunksSealed = v.getUint16(o, true); o += 2;
  const itemsRoot = hex(d.slice(o, o + 32)); o += 40; // root + fee u64
  o += 8; const createdAt = Number(v.getBigInt64(o, true)); o += 8;
  let kind = 0;
  const nlNew = o + 5 <= d.length ? v.getUint32(o + 1, true) : -1;
  if (o < d.length && d[o] <= 2 && nlNew >= 0 && nlNew <= 32 && o + 5 + nlNew <= d.length) { kind = d[o]; }
  return { authority, id, status, chunkCount, chunksSealed, itemsRoot, createdAt, kind };
}
function parseRun(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  const benchmark = b58(d.slice(o, o + 32)); o += 32;
  const runner = b58(d.slice(o, o + 32)); o += 32;
  const index = v.getBigUint64(o, true); o += 8; o += 1;
  const status = d[o++]; const chunkCount = v.getUint16(o, true); o += 2;
  const pendingMask = v.getBigUint64(o, true); o += 8;
  const scoredMask = v.getBigUint64(o, true); o += 8;
  const correct = v.getUint32(o, true); o += 4;
  const createdAt = Number(v.getBigInt64(o, true)); o += 8;
  const finalizedAt = Number(v.getBigInt64(o, true)); o += 8;
  o += 32; const outputsRoot = hex(d.slice(o, o + 32)); o += 32;
  const ml = v.getUint32(o, true); o += 4;
  const modelId = new TextDecoder().decode(d.slice(o, o + ml)); o += ml;
  let everQueuedMask = 0n, postReveal = false;
  if (o + 9 <= d.length) o += 9;
  if (o + 8 <= d.length) o += 8;
  if (o + 8 <= d.length) o += 8;
  if (o + 8 <= d.length) { everQueuedMask = v.getBigUint64(o, true); o += 8; }
  if (o + 8 <= d.length) o += 8;
  // F1 tail flag (post-upgrade accounts): run minted after a fingerprint
  // reveal on its bank — markets must refuse it. Absent on old layouts.
  if (o + 1 <= d.length) postReveal = d[o] !== 0;
  return { benchmark, runner, index, status, chunkCount, pendingMask, scoredMask, correct, createdAt, finalizedAt, outputsRoot, modelId, everQueuedMask, postReveal };
}
function parseMarket(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  o += 32; const run = b58(d.slice(o, o + 32)); o += 32;
  o += 32; const runIndex = v.getBigUint64(o, true); o += 8;
  const salt = v.getBigUint64(o, true); o += 8;
  const n = d[o++]; const edges = [];
  for (let i = 0; i < 7; i++) { edges.push(v.getUint32(o, true)); o += 4; }
  o += 1; const status = d[o++]; const outcome = d[o++];
  o += 64; const resolvedScore = v.getUint32(o, true);
  o += 4 + 16; const runB = o + 32 <= d.length ? b58(d.slice(o, o + 32)) : null;
  return { run, runIndex, salt, n, edges, status, outcome, resolvedScore, runB, duel: runB && runB !== "11111111111111111111111111111111" };
}
function parseLadder(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  o += 32; o += 32; // authority + benchmark
  const legs = []; for (let i = 0; i < 8; i++) { legs.push(b58(d.slice(o, o + 32))); o += 32; }
  const legCount = d[o++]; const salt = v.getBigUint64(o, true); o += 9;
  const status = d[o++]; const resultMask = d[o++];
  return { legs: legs.slice(0, legCount), legCount, salt, status, resultMask };
}
function parseDark(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  o += 32; const run = b58(d.slice(o, o + 32)); o += 32; o += 40;
  const salt = v.getBigUint64(o, true); o += 8;
  const n = d[o++]; const edges = [];
  for (let i = 0; i < 7; i++) { edges.push(v.getUint32(o, true)); o += 4; }
  o += 1; const status = d[o++]; const outcome = d[o++];
  const poolTotal = v.getBigUint64(o, true); o += 8;
  const winTotal = v.getBigUint64(o, true); o += 8;
  const revealedCount = v.getUint32(o, true); o += 4;
  const resolvedScore = v.getUint32(o, true);
  return { run, salt, n, edges, status, outcome, poolTotal, winTotal, revealedCount, resolvedScore };
}
function parseDarkPos(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  const market = b58(d.slice(o, o + 32)); o += 32;
  const bettor = b58(d.slice(o, o + 32)); o += 32; o += 1;
  const amount = v.getBigUint64(o, true); o += 8;
  const commitment = hex(d.slice(o, o + 32)); o += 32;
  const revealed = d[o++];
  return { market, bettor, amount, commitment, revealed: revealed === 255 ? null : revealed };
}

// ---------- load ----------
const snap = JSON.parse(readFileSync(FILE, "utf8"));
console.log(`verify.mjs — ${FILE}`);
console.log(`snapshot takenAt ${snap.meta?.takenAt}, ${snap.sealed.length} sealed + ${snap.market.length} market accounts\n`);

const benches = new Map(), runs = new Map(), itemChunks = [], privChunks = [], chunks = [], reveals = [], grants = [];
let signPda = null;
const markets = new Map(), ladders = [], darks = new Map(), darkPos = [], positions = [], bounties = [];

console.log("[1] decode + classify every account");
let unknown = 0;
for (const a of snap.sealed) {
  const d = Buffer.from(a.data, "base64"), disc = hex(d.subarray(0, 8));
  try {
    if (disc === DISC.benchmark) benches.set(a.pubkey, parseBenchmark(d));
    else if (disc === DISC.run) runs.set(a.pubkey, parseRun(d));
    else if (disc === DISC.itemChunk) { const v = new DataView(d.buffer, d.byteOffset); itemChunks.push({ pk: a.pubkey, bench: b58(d.subarray(8, 40)), index: v.getUint16(40, true), partsWritten: d[43], raw: d }); }
    else if (disc === DISC.privItemChunk) { const v = new DataView(d.buffer, d.byteOffset); privChunks.push({ pk: a.pubkey, bench: b58(d.subarray(8, 40)), index: v.getUint16(40, true), partsWritten: d[43], raw: d }); }
    else if (disc === DISC.reveal) { const v = new DataView(d.buffer, d.byteOffset); reveals.push({ pk: a.pubkey, bench: b58(d.subarray(8, 40)), chunk: v.getUint16(40, true), part: d[42], revealedAt: Number(v.getBigInt64(44, true)) }); }
    else if (disc === DISC.shareGrant) { const v = new DataView(d.buffer, d.byteOffset); grants.push({ pk: a.pubkey, bench: b58(d.subarray(8, 40)), chunk: v.getUint16(40, true), part: d[42], viewer: b58(d.subarray(44, 76)) }); }
    else if (disc === DISC.answerChunk) chunks.push({ pk: a.pubkey, bench: b58(d.subarray(8, 40)), index: new DataView(d.buffer, d.byteOffset).getUint16(40, true) });
    else if (disc === "d69d7a72752cd64a") signPda = a.pubkey; // Arcium SignPdaAccount (callback signer)
    else unknown++;
  } catch (e) { unknown++; console.log(`    ! unparseable sealed account ${a.pubkey}: ${e.message}`); }
}
for (const a of snap.market) {
  const d = Buffer.from(a.data, "base64"), disc = hex(d.subarray(0, 8));
  try {
    if (disc === DISC.market) markets.set(a.pubkey, parseMarket(d));
    else if (disc === DISC.ladder) ladders.push({ pk: a.pubkey, ...parseLadder(d) });
    else if (disc === DISC.darkMarket) darks.set(a.pubkey, parseDark(d));
    else if (disc === DISC.darkPosition) darkPos.push({ pk: a.pubkey, ...parseDarkPos(d) });
    else if (disc === DISC.bounty) {
      const v = new DataView(d.buffer, d.byteOffset);
      bounties.push({ pk: a.pubkey, sponsor: b58(d.subarray(8, 40)), bank: b58(d.subarray(40, 72)), salt: v.getBigUint64(72, true),
        status: d[81], threshold: v.getUint32(82, true), amount: v.getBigUint64(86, true), winnerRun: b58(d.subarray(94, 126)),
        winningScore: v.getUint32(126, true), createdAt: Number(v.getBigInt64(130, true)), deadline: Number(v.getBigInt64(138, true)) });
    }
    else if (disc === DISC.position) positions.push({ pk: a.pubkey, market: b58(d.subarray(8, 40)), bettor: b58(d.subarray(40, 72)) });
    else unknown++;
  } catch (e) { unknown++; console.log(`    ! unparseable market account ${a.pubkey}: ${e.message}`); }
}
unknown === 0 ? ok("account decode", `${benches.size} banks, ${runs.size} runs, ${itemChunks.length} gen chunks, ${privChunks.length} private chunks, ${reveals.length} reveals, ${grants.length} grants, ${markets.size} markets, ${ladders.length} ladders, ${darks.size} dark markets, ${darkPos.length} dark positions, ${bounties.length} bounties`)
  : bad("account decode", `${unknown} unknown/unparseable accounts`);

console.log("\n[2] PDA re-derivation — every account must sit at its seed-derived address");
let pdaBad = 0; const pdaCheck = (want, got, what) => { if (want !== got) { pdaBad++; console.log(`    ! ${what}: want ${want} got ${got}`); } };
for (const [pkk, b] of benches) pdaCheck(pkk, pda([utf8("benchmark"), pk(b.authority), u32le(b.id)], SEALED_PID), `benchmark ${b.id}`);
for (const c of itemChunks) pdaCheck(c.pk, pda([utf8("items"), pk(c.bench), u32le(c.index).subarray(0, 2)], SEALED_PID), `items ${c.index}`);
for (const c of privChunks) pdaCheck(c.pk, pda([utf8("pitems"), pk(c.bench), u32le(c.index).subarray(0, 2)], SEALED_PID), `pitems ${c.index}`);
for (const c of chunks) pdaCheck(c.pk, pda([utf8("chunk"), pk(c.bench), u32le(c.index).subarray(0, 2)], SEALED_PID), `chunk ${c.index}`);
for (const [pkk, r] of runs) pdaCheck(pkk, pda([utf8("run"), pk(r.benchmark), u64le(r.index)], SEALED_PID), `run ${r.index}`);
for (const r of reveals) pdaCheck(r.pk, pda([utf8("reveal"), pk(r.bench), u32le(r.chunk).subarray(0, 2), new Uint8Array([r.part])], SEALED_PID), `reveal ${r.chunk}/${r.part}`);
for (const g of grants) pdaCheck(g.pk, pda([utf8("grant"), pk(g.bench), u32le(g.chunk).subarray(0, 2), new Uint8Array([g.part]), pk(g.viewer)], SEALED_PID), `grant ${g.chunk}/${g.part}`);
for (const [pkk, m] of markets) {
  const plain = pda([utf8("market"), pk(m.run), u64le(m.salt)], MARKET_PID);
  const duel = m.duel ? pda([utf8("duel"), pk(m.run), pk(m.runB), u64le(m.salt)], MARKET_PID) : null;
  if (pkk !== plain && pkk !== duel) { pdaBad++; console.log(`    ! market ${pkk}: neither [market,run,salt] nor [duel,a,b,salt]`); }
}
for (const l of ladders) pdaCheck(l.pk, pda([utf8("ladder"), pk(l.legs[0]), u64le(l.salt)], MARKET_PID), `ladder`);
for (const [pkk, d] of darks) pdaCheck(pkk, pda([utf8("dark"), pk(d.run), u64le(d.salt)], MARKET_PID), `dark market`);
for (const b of bounties) pdaCheck(b.pk, pda([utf8("bounty"), pk(b.bank), pk(b.sponsor), u64le(b.salt)], MARKET_PID), `bounty`);
for (const p of darkPos) {
  let found = false;
  for (let s = 0; s <= 4095 && !found; s++) if (pda([utf8("darkpos"), pk(p.market), pk(p.bettor), u64le(s)], MARKET_PID) === p.pk) found = true;
  if (!found) { pdaBad++; console.log(`    ! darkpos ${p.pk}: no pos_salt 0..4095 derives it`); }
}
for (const p of positions) pdaCheck(p.pk, pda([utf8("position"), pk(p.market), pk(p.bettor)], MARKET_PID), `position`);
if (signPda) pdaCheck(signPda, pda([utf8("ArciumSignerAccount")], SEALED_PID), "SignPdaAccount");
pdaBad === 0 ? ok("PDA derivation", "every account re-derives to its own address") : bad("PDA derivation", `${pdaBad} mismatches — snapshot contains accounts the program could never have written`);

console.log("\n[3] run invariants");
let runBad = 0;
for (const [pkk, r] of runs) {
  if ((r.scoredMask & ~r.everQueuedMask) !== 0n && r.everQueuedMask !== 0n) { runBad++; console.log(`    ! run ${pkk}: scored bits never queued`); }
  if (r.correct > popcount64(r.scoredMask) * 32) { runBad++; console.log(`    ! run ${pkk}: correct ${r.correct} exceeds scored capacity`); }
  if (r.status === RUN_FINAL && r.pendingMask !== 0n) { runBad++; console.log(`    ! run ${pkk}: finalized with pending bits`); }
  if (!benches.has(r.benchmark)) { runBad++; console.log(`    ! run ${pkk}: parent benchmark absent`); }
}
runBad === 0 ? ok("run invariants", `${runs.size} runs: scored⊆queued, correct≤capacity, finalized⇒no pending`) : bad("run invariants", `${runBad} violations`);

console.log("\n[4] items_root commitment replay (gen + private banks)");
let foldBad = 0, folded = 0;
for (const [pkk, b] of benches) {
  if (b.kind === 0) continue;
  const st = [];
  if (b.kind === 1) {
    for (const c of itemChunks.filter((x) => x.bench === pkk)) {
      const d = c.raw, v = new DataView(d.buffer, d.byteOffset);
      for (let p = 0; p < 4; p++) {
        if (!(c.partsWritten & (1 << p))) continue;
        const bytes = new Uint8Array(40);
        for (let k = 0; k < 8; k++) bytes.set(d.subarray(44 + (p * 8 + k) * 5, 44 + (p * 8 + k) * 5 + 5), k * 5);
        st.push({ seq: v.getUint16(204 + p * 2, true), ci: c.index, part: p, bytes });
      }
    }
  } else {
    for (const c of privChunks.filter((x) => x.bench === pkk)) {
      const d = c.raw, v = new DataView(d.buffer, d.byteOffset);
      for (let p = 0; p < 4; p++) {
        if (!(c.partsWritten & (1 << p))) continue;
        const bytes = cat(d.subarray(140 + p * 64, 140 + p * 64 + 64), d.subarray(76 + p * 16, 76 + p * 16 + 16));
        st.push({ seq: v.getUint16(396 + p * 2, true), ci: c.index, part: p, bytes });
      }
    }
  }
  if (!st.length) { note(`bank ${pkk.slice(0, 8)}`, "no minted parts in snapshot"); continue; }
  let root = Buffer.alloc(32);
  for (const s of st.sort((a, b) => a.seq - b.seq || a.ci - b.ci || a.part - b.part))
    root = sha(cat(b.kind === 1 ? D_GI : D_PI, root, u32le(s.ci).subarray(0, 2), new Uint8Array([s.part]), s.bytes));
  if (hex(root) === b.itemsRoot) { folded++; } else { foldBad++; console.log(`    ! bank ${pkk}: fold ${hex(root).slice(0, 16)}… != stored ${b.itemsRoot.slice(0, 16)}…`); }
}
foldBad === 0 ? ok("items_root folds", `${folded} banks replayed bit-exact`) : bad("items_root folds", `${foldBad} mismatches`);

console.log("\n[5] market resolutions are pure functions of MPC scores");
let mBad = 0, checked = 0;
for (const [pkk, m] of markets) {
  const r = runs.get(m.run);
  if (!r) { note(`market ${pkk.slice(0, 8)}`, "run not in snapshot"); continue; }
  if (m.status === M_RESOLVED) {
    checked++;
    if (m.duel) {
      const rb = runs.get(m.runB);
      if (!rb) { note(`duel ${pkk.slice(0, 8)}`, "runB missing"); continue; }
      const expect = r.correct > rb.correct ? 0 : rb.correct > r.correct ? 1 : 2;
      const packed = (r.correct << 16) | rb.correct;
      if (m.outcome !== expect || m.resolvedScore !== packed) { mBad++; console.log(`    ! duel ${pkk}: outcome ${m.outcome}!=${expect} or packed ${m.resolvedScore}!=${packed}`); }
    } else {
      if (m.resolvedScore !== r.correct) { mBad++; console.log(`    ! market ${pkk}: resolvedScore ${m.resolvedScore} != run.correct ${r.correct}`); }
      if (m.outcome !== outcomeOf(m.edges, m.n, r.correct)) { mBad++; console.log(`    ! market ${pkk}: outcome ${m.outcome} != band ${outcomeOf(m.edges, m.n, r.correct)} for score ${r.correct}`); }
    }
  }
}
mBad === 0 ? ok("score-band + duel purity", `${checked} resolved markets re-derived`) : bad("market purity", `${mBad} resolutions don't match MPC scores`);

let lBad = 0, lChecked = 0;
for (const l of ladders) {
  if (l.status !== M_RESOLVED) continue;
  lChecked++;
  const scores = l.legs.map((lp) => runs.get(lp)?.correct ?? null);
  if (scores.includes(null)) { note(`ladder ${l.pk.slice(0, 8)}`, "leg run missing from snapshot"); continue; }
  const max = Math.max(...scores);
  const expect = scores.reduce((m2, s, i) => (s === max ? m2 | (1 << i) : m2), 0);
  if (l.resultMask !== expect) { lBad++; console.log(`    ! ladder ${l.pk}: mask ${l.resultMask} != argmax ${expect} over ${scores}`); }
}
lBad === 0 ? ok("ladder argmax masks", `${lChecked} ladders re-derived`) : bad("ladder masks", `${lBad} mismatches`);

let dBad = 0, dChecked = 0;
for (const [pkk, dm] of darks) {
  if (dm.status !== M_RESOLVED && dm.status !== M_CANCELLED) continue;
  const r = runs.get(dm.run);
  const pos = darkPos.filter((p) => p.market === pkk);
  if (dm.status === M_RESOLVED && r) {
    dChecked++;
    if (dm.resolvedScore !== r.correct || dm.outcome !== outcomeOf(dm.edges, dm.n, r.correct)) { dBad++; console.log(`    ! dark ${pkk}: outcome/score mismatch`); }
  }
  const rev = pos.filter((p) => p.revealed !== null);
  // positions close on claim — open revealed positions can only ever be a
  // subset of the lifetime revealed_count.
  if (rev.length > dm.revealedCount) { dBad++; console.log(`    ! dark ${pkk}: ${rev.length} open revealed > lifetime revealedCount ${dm.revealedCount}`); }
  for (const p of rev) if (p.revealed >= dm.n) { dBad++; console.log(`    ! darkpos ${p.pk}: revealed outcome ${p.revealed} >= n ${dm.n}`); }
  if (dm.winTotal > dm.poolTotal) { dBad++; console.log(`    ! dark ${pkk}: winTotal > pool`); }
}
dBad === 0 ? ok("dark-market accounting", `${dChecked} resolved darks re-derived; revealedCount/wintotal consistent`) : bad("dark markets", `${dBad} violations`);

// Claimed under the pre-guard binary (epoch 2 — the self-deal guard
// `runner != sponsor` shipped after this claim landed). Grandfathered as
// historical evidence; any NEW self-deal claim fails hard.
const GRANDFATHERED_BOUNTIES = new Set([
  "EJzXf3q4pRddNcqHWFiSWfBEntwaKGUqPx8cWH1aiBSc",
]);
let bBad = 0, bChecked = 0;
for (const b of bounties) {
  if (b.status !== 1) continue; // only claimed bounties carry assertions
  bChecked++;
  const r = runs.get(b.winnerRun);
  if (!r) { bBad++; console.log(`    ! bounty ${b.pk}: winner_run ${b.winnerRun} absent`); continue; }
  if (r.benchmark !== b.bank) { bBad++; console.log(`    ! bounty ${b.pk}: winner run is on a different bank`); }
  if (r.correct < b.threshold) { bBad++; console.log(`    ! bounty ${b.pk}: winning score ${r.correct} < threshold ${b.threshold}`); }
  if (b.winningScore !== r.correct) { bBad++; console.log(`    ! bounty ${b.pk}: winningScore ${b.winningScore} != run.correct ${r.correct}`); }
  if (r.createdAt < b.createdAt) { bBad++; console.log(`    ! bounty ${b.pk}: winner run predates the bounty (retroactive claim)`); }
  if (r.runner === b.sponsor) {
    if (GRANDFATHERED_BOUNTIES.has(b.pk)) {
      console.log(`    note bounty ${b.pk}: self-claimed under pre-guard binary — rejected by current code`);
    } else {
      bBad++; console.log(`    ! bounty ${b.pk}: winner run's runner IS the sponsor (self-deal)`);
    }
  }
}
bBad === 0 ? ok("bounty claims", `${bChecked} claimed bounties re-verified against winner runs`) : bad("bounties", `${bBad} violations`);

console.log("\n[6] cross-references");
let xBad = 0;
for (const [pkk, m] of markets) if (!runs.has(m.run)) xBad++;
for (const b of bounties) { if (!benches.has(b.bank)) xBad++; if (b.status === 1 && !runs.has(b.winnerRun)) xBad++; }
for (const l of ladders) for (const leg of l.legs) if (!runs.has(leg)) xBad++;
for (const c of [...itemChunks, ...privChunks, ...chunks]) if (!benches.has(c.bench)) xBad++;
for (const r of reveals) if (!benches.has(r.bench)) xBad++;
xBad === 0 ? ok("referential integrity", "every market/chunk/reveal link resolves") : bad("referential integrity", `${xBad} dangling links`);

console.log("\n[7] Merkle proof files (docs/evidence/prove-*.json)");
let pfBad = 0, pfOk = 0;
const proofDir = join(ROOT, "docs", "evidence");
let proofs = [];
try { proofs = readdirSync(proofDir).filter((f) => f.startsWith("prove-") && f.endsWith(".json")); } catch {}
for (const f of proofs) {
  try {
    const p = JSON.parse(readFileSync(join(proofDir, f), "utf8"));
    const outs = p.chunkOutputs.slice(); while (outs.length < 32) outs.push(0);
    let h = sha(cat(D_COUT, u32le(p.chunkIndex).subarray(0, 2), ...outs.map(u64le)));
    let i = p.chunkIndex;
    for (const s of p.proof.map((x) => Buffer.from(x, "hex"))) { h = sha(cat(D_NODE, i % 2 === 0 ? h : s, i % 2 === 0 ? s : h)); i >>= 1; }
    const rootOk = hex(h) === p.outputsRoot;
    const slotOk = BigInt(p.outputHash) === BigInt(p.chunkOutputs[p.itemIndex % 32]);
    const run = runs.get(p.runPda);
    const chainOk = run ? run.outputsRoot === p.outputsRoot : null;
    if (rootOk && slotOk && chainOk !== false) { pfOk++; } else { pfBad++; console.log(`    ! ${f}: root=${rootOk} slot=${slotOk} chain=${chainOk}`); }
  } catch (e) { pfBad++; console.log(`    ! ${f}: ${e.message}`); }
}
pfBad === 0 ? ok("merkle proofs", `${pfOk} proof files verify end-to-end`) : bad("merkle proofs", `${pfBad} failed`);

console.log("\n[8] reveal-burn (F1) report — on-chain flag vs timestamp inference");
const revealByBench = new Map();
for (const r of reveals) { const l = revealByBench.get(r.bench) || []; l.push(r); revealByBench.set(r.bench, l); }
let flagBad = 0;
for (const [bench, rs] of revealByBench) {
  const minT = Math.min(...rs.map((r) => r.revealedAt));
  const benchRuns = [...runs.entries()].filter(([, r]) => r.benchmark === bench);
  const inferred = benchRuns.filter(([, r]) => r.createdAt > minT);
  const flagged = benchRuns.filter(([, r]) => r.postReveal);
  // On post-upgrade accounts the flag is authoritative: it must agree with
  // the timestamp inference exactly. (Pre-upgrade runs lack the byte —
  // inference alone covers them; the sets can only diverge on old data.)
  const flagSet = new Set(flagged.map(([p]) => p));
  const inferredSet = new Set(inferred.map(([p]) => p));
  const disagree = [...flagSet].filter((p) => !inferredSet.has(p)).length;
  if (disagree) { flagBad++; console.log(`    ! bank ${bench}: ${disagree} flagged run(s) not explainable by timestamps`); }
  note(`bank ${bench.slice(0, 8)}`, `${rs.length} reveal(s) — ${flagged.length} flagged on-chain, ${inferred.length} inferred`);
}
flagBad === 0 ? ok("post_reveal flags", "on-chain flags consistent with reveal timestamps") : bad("post_reveal flags", `${flagBad} inconsistencies`);

console.log(`\n═══ ${pass} PASS / ${fail} FAIL / ${skip} notes ═══`);
process.exit(fail ? 1 : 0);
