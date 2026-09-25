// Sanity-check the explorer's account parsing against a live RPC.
// Usage: node scripts/explorer-check.mjs [rpc-url]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");

const SEALED_PID = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const MARKET_PID = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const DISC = { benchmark: "39fc2136718de9f7", run: "c7369b56eb73f6bd", itemChunk: "3ad5949e8388e23d", privItemChunk: "73f0ae62d80297f4", reveal: "fbaa9323ea6c0e95", shareGrant: "a47067c1839cb4c0", market: "dbbed53700e3c69a", ladder: "7d9223fe2a07ccde", position: "aabc8fe47a40f7d0", darkMarket: "94562c723ef98ba6", darkPosition: "d8c18faeae9d7715" };
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const b58 = (u8) => new PublicKey(u8).toBase58();

function parseBenchmark(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  const authority = d.slice(o, o + 32); o += 32;
  const id = v.getUint32(o, true); o += 4;
  o += 1; const status = d[o++];
  const chunkCount = v.getUint16(o, true); o += 2;
  const chunksSealed = v.getUint16(o, true); o += 2;
  const itemsRoot = d.slice(o, o + 32); o += 32;
  o += 8 + 8 + 8;
  const kind = o < d.length ? d[o++] : 0;
  const nl = v.getUint32(o, true); o += 4;
  const name = new TextDecoder().decode(d.slice(o, o + nl));
  return { authority: b58(authority), id, status, chunkCount, chunksSealed, itemsRoot: hex(itemsRoot), kind, name };
}
function parseItemChunk(d) {
  const specs = [];
  for (let i = 0; i < 32; i++) { const o = 44 + i * 5; specs.push([d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4]].join(",")); }
  return { index: new DataView(d.buffer, d.byteOffset).getUint16(40, true), partsWritten: d[43], specs: specs.slice(0, 3) };
}
function parseRun(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  const benchmark = d.slice(o, o + 32); o += 32;
  const runner = d.slice(o, o + 32); o += 32;
  const index = v.getBigUint64(o, true); o += 8;
  o += 1; const status = d[o++];
  const chunkCount = v.getUint16(o, true); o += 2;
  o += 8 + 8;
  const correct = v.getUint32(o, true); o += 4;
  o += 8 + 8 + 32;
  const outputsRoot = d.slice(o, o + 32); o += 32;
  const ml = v.getUint32(o, true); o += 4;
  const modelId = new TextDecoder().decode(d.slice(o, o + ml));
  return { benchmark: b58(benchmark), runner: b58(runner), index, status, chunkCount, correct, outputsRoot: hex(outputsRoot), modelId };
}
function parsePrivItemChunk(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { index: v.getUint16(40, true), partsWritten: d[43], encryptionKey: b58(d.slice(44, 76)), cts0: hex(d.slice(140, 204)) };
}
function parseReveal(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { chunk: v.getUint16(40, true), part: d[42], revealedAt: v.getBigInt64(44, true).toString(), hashes: Array.from({ length: 8 }, (_, i) => v.getBigUint64(52 + i * 8, true).toString(16)) };
}
// ShareGrant: disc8 + benchmark32 + chunk u16 + part u8 + bump + viewer32
// + encryption_key32 + nonce16 + ciphertexts[2][32] + shared_at i64.
function parseShareGrant(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { chunk: v.getUint16(40, true), part: d[42], viewer: b58(d.slice(44, 76)), encKey: b58(d.slice(76, 108)), cts: hex(d.slice(124, 188)), sharedAt: v.getBigInt64(188, true).toString() };
}
// disc8 + authority32 + run32 + benchmark32 + runIndex u64 + salt u64
// + nOutcomes u8 + edges[7]u32 + bump + status + outcome + totals[8]u64
// + resolvedScore u32 + createdAt i64 + resolvedAt i64 + runB 32
// + feeBps u16 + feesAccrued u64 + closesAt i64 + resolveBy i64
// (same layout as web/index.html)
function parseMarket(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  o += 32;
  const run = d.slice(o, o + 32); o += 32;
  const benchmark = d.slice(o, o + 32); o += 32;
  const runIndex = v.getBigUint64(o, true); o += 8;
  const salt = v.getBigUint64(o, true); o += 8;
  const nOutcomes = d[o++];
  const edges = []; for (let i = 0; i < 7; i++) { edges.push(v.getUint32(o, true)); o += 4; }
  o += 1; const status = d[o++]; const outcome = d[o++];
  const totals = []; for (let i = 0; i < 8; i++) { totals.push(v.getBigUint64(o, true)); o += 8; }
  const resolvedScore = v.getUint32(o, true); o += 4;
  o += 16; // created_at + resolved_at
  // run_b appended for duel markets; absent on pre-duel accounts.
  const runB = o + 32 <= d.length ? b58(d.slice(o, o + 32)) : null;
  o += 32;
  const duel = runB && runB !== "11111111111111111111111111111111";
  // fee/deadline tail appended in the market-economics upgrade.
  let feeBps, feesAccrued, closesAt, resolveBy;
  if (o + 26 <= d.length) {
    feeBps = v.getUint16(o, true); o += 2;
    feesAccrued = v.getBigUint64(o, true); o += 8;
    closesAt = v.getBigInt64(o, true); o += 8;
    resolveBy = v.getBigInt64(o, true); o += 8;
  }
  return { run: b58(run), runB: duel ? runB : undefined, benchmark: b58(benchmark), runIndex, salt, nOutcomes, edges: edges.slice(0, Math.max(0, nOutcomes - 1)), status, outcome, totals: totals.slice(0, nOutcomes), resolvedScore: duel ? `${resolvedScore >> 16}-${resolvedScore & 0xffff}` : resolvedScore, feeBps, feesAccrued, closesAt, resolveBy };
}
// Ladder: disc8 + authority32 + benchmark32 + legs[8]×32 + legCount u8
// + salt u64 + bump + status + resultMask u8 + resolvedScore u32
// + totals[8]u64 + created/resolved i64 + feeBps u16 + feesAccrued u64
// + closesAt/resolveBy i64
function parseLadder(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  const authority = b58(d.slice(o, o + 32)); o += 32;
  const benchmark = b58(d.slice(o, o + 32)); o += 32;
  const legs = []; for (let i = 0; i < 8; i++) { legs.push(b58(d.slice(o, o + 32))); o += 32; }
  const legCount = d[o++];
  const salt = v.getBigUint64(o, true); o += 8;
  o += 1; const status = d[o++];
  const resultMask = d[o++];
  const resolvedScore = v.getUint32(o, true); o += 4;
  const totals = []; for (let i = 0; i < 8; i++) { totals.push(v.getBigUint64(o, true)); o += 8; }
  o += 16; const feeBps = v.getUint16(o, true); o += 2;
  const feesAccrued = v.getBigUint64(o, true); o += 8;
  const closesAt = v.getBigInt64(o, true); o += 8;
  const resolveBy = v.getBigInt64(o, true); o += 8;
  return { authority, benchmark, legs: legs.slice(0, legCount), legCount, salt, status, resultMask: "0b" + resultMask.toString(2), resolvedScore, totals: totals.slice(0, legCount), feeBps, feesAccrued, closesAt, resolveBy };
}

// DarkMarket: disc8 + authority32 + run32 + benchmark32 + runIndex u64 + salt u64
// + nOutcomes u8 + edges[7]u32 + bump + status + outcome + pool u64 + winTotal u64
// + revealedCount u32 + resolvedScore u32 + created/resolved/revealSecs/revealUntil
// i64s + feeBps u16 + feesAccrued u64 + closesAt/resolveBy i64 + tallied bool
function parseDarkMarket(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  o += 32;
  const run = d.slice(o, o + 32); o += 32;
  const benchmark = d.slice(o, o + 32); o += 32;
  const runIndex = v.getBigUint64(o, true); o += 8;
  const salt = v.getBigUint64(o, true); o += 8;
  const n = d[o++];
  const edges = []; for (let i = 0; i < 7; i++) { edges.push(v.getUint32(o, true)); o += 4; }
  o += 1; const status = d[o++]; const outcome = d[o++];
  const poolTotal = v.getBigUint64(o, true); o += 8;
  const winTotal = v.getBigUint64(o, true); o += 8;
  const revealedCount = v.getUint32(o, true); o += 4;
  const resolvedScore = v.getUint32(o, true); o += 4;
  o += 16; // created_at + resolved_at
  const revealSecs = v.getBigInt64(o, true); o += 8;
  const revealUntil = v.getBigInt64(o, true); o += 8;
  const feeBps = v.getUint16(o, true); o += 2;
  const feesAccrued = v.getBigUint64(o, true); o += 8;
  const closesAt = v.getBigInt64(o, true); o += 8;
  const resolveBy = v.getBigInt64(o, true); o += 8;
  const tallied = d[o++] === 1;
  return { run: b58(run), benchmark: b58(benchmark), runIndex, salt, nOutcomes: n, edges: edges.slice(0, Math.max(0, n - 1)), status, outcome, poolTotal, winTotal, revealedCount, resolvedScore, revealSecs, revealUntil, feeBps, feesAccrued, closesAt, resolveBy, tallied };
}
// DarkPosition: disc8 + market32 + bettor32 + bump + amount u64 + commitment[32] + revealed u8
function parseDarkPosition(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let o = 8;
  const market = b58(d.slice(o, o + 32)); o += 32;
  const bettor = b58(d.slice(o, o + 32)); o += 32;
  o += 1;
  const amount = v.getBigUint64(o, true); o += 8;
  const commitment = hex(d.slice(o, o + 32)); o += 32;
  const revealed = d[o++];
  return { market, bettor, amount, commitment, revealed: revealed === 255 ? "sealed" : revealed };
}

const url = process.argv[2] || "http://127.0.0.1:8899";
const J = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const conn = new Connection(url, "confirmed");
const sealed = await conn.getProgramAccounts(SEALED_PID);
const mkt = await conn.getProgramAccounts(MARKET_PID);
console.log(`sealed accounts: ${sealed.length}, market accounts: ${mkt.length}`);
for (const { pubkey, account } of sealed) {
  const d = new Uint8Array(account.data), disc = hex(d.slice(0, 8));
  if (disc === DISC.benchmark) console.log("benchmark", pubkey.toBase58(), J(parseBenchmark(d)));
  else if (disc === DISC.run) console.log("run     ", pubkey.toBase58(), J(parseRun(d)));
  else if (disc === DISC.itemChunk) console.log("itmchunk", pubkey.toBase58(), J(parseItemChunk(d)));
  else if (disc === DISC.privItemChunk) console.log("privitm ", pubkey.toBase58(), J(parsePrivItemChunk(d)));
  else if (disc === DISC.reveal) console.log("reveal  ", pubkey.toBase58(), J(parseReveal(d)));
  else if (disc === DISC.shareGrant) console.log("grant   ", pubkey.toBase58(), J(parseShareGrant(d)));
}
for (const { pubkey, account } of mkt) {
  const d = new Uint8Array(account.data), disc = hex(d.slice(0, 8));
  if (disc === DISC.market) console.log("market  ", pubkey.toBase58(), J(parseMarket(d)));
  else if (disc === DISC.ladder) console.log("ladder  ", pubkey.toBase58(), J(parseLadder(d)));
  else if (disc === DISC.darkMarket) console.log("darkmkt ", pubkey.toBase58(), J(parseDarkMarket(d)));
  else if (disc === DISC.darkPosition) console.log("darkpos ", pubkey.toBase58(), J(parseDarkPosition(d)));
}
