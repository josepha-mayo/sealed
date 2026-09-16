// Slow-path diagnostics: find sealPart txs on the benchmark, extract computation
// offsets, then read each computation account's status on devnet.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");
const BN = require("bn.js");
const { createHash } = await import("node:crypto");
const arcium = require("@arcium-hq/client");

const RPC = "https://api.devnet.solana.com";
const PID = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const BENCH = new PublicKey("2wwqt9Y9mL6tkKAdfrN5YcTHNG4r59sdZWou3k2hezg4");
const OFFSET = 456;
const conn = new Connection(RPC, "confirmed");
const disc = createHash("sha256").update("global:seal_part").digest().slice(0, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sigs = await conn.getSignaturesForAddress(BENCH, { limit: 30 });
console.log(`${sigs.length} signatures on benchmark`);
const found = [];
for (const s of sigs) {
  await sleep(1500);
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!tx) continue;
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys ?? msg.accountKeys;
  const ixs = msg.compiledInstructions ?? msg.instructions;
  for (const ix of ixs) {
    const prog = keys[ix.programIdIndex];
    if (!prog || !prog.equals(PID)) continue;
    const raw = ix.data instanceof Uint8Array ? ix.data : typeof ix.data === "string" ? bs58.decode(ix.data) : null;
    if (!raw) continue;
    const data = Buffer.from(raw);
    if (data.length < 19 || !data.slice(0, 8).equals(disc)) continue;
    found.push({ sig: s.signature, offset: data.readBigUInt64LE(8), index: data.readUInt16LE(16), part: data[18], err: s.err });
  }
}
for (const f of found) {
  await sleep(1500);
  const compAcc = arcium.getComputationAccAddress(OFFSET, new BN(f.offset.toString()));
  const info = await conn.getAccountInfo(compAcc).catch(() => null);
  console.log(`sealPart chunk=${f.index} part=${f.part} offset=${f.offset} txErr=${JSON.stringify(f.err)}`);
  console.log(`  comp ${compAcc.toBase58()}: ${info ? `${info.data.length}B data` : "account absent"}`);
  if (info && info.data.length > 16) {
    console.log("  raw status bytes:", info.data.slice(8, 40).toString("hex"));
  }
}
