// Sanity-check the explorer's account parsing against a live RPC.
// Usage: node scripts/explorer-check.mjs [rpc-url]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");

const SEALED_PID = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const MARKET_PID = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const DISC = { benchmark: "39fc2136718de9f7", run: "c7369b56eb73f6bd", itemChunk: "3ad5949e8388e23d", market: "dbbed53700e3c69a", position: "aabc8fe47a40f7d0" };
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
// disc8 + authority32 + run32 + benchmark32 + runIndex u64 + salt u64
// + nOutcomes u8 + edges[7]u32 + bump + status + outcome + totals[8]u64
// + resolvedScore u32 + createdAt i64 + resolvedAt i64  (same layout as web/index.html)
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
  return { run: b58(run), benchmark: b58(benchmark), runIndex, salt, nOutcomes, edges: edges.slice(0, Math.max(0, nOutcomes - 1)), status, outcome, totals: totals.slice(0, nOutcomes), resolvedScore };
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
}
for (const { pubkey, account } of mkt) {
  const d = new Uint8Array(account.data), disc = hex(d.slice(0, 8));
  if (disc === DISC.market) console.log("market  ", pubkey.toBase58(), J(parseMarket(d)));
}
