// Find sealPart txs on the benchmark and inspect their computation accounts.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");
const arcium = require("@arcium-hq/client");

const RPC = "https://api.devnet.solana.com";
const PID = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const BENCH = new PublicKey("2wwqt9Y9mL6tkKAdfrN5YcTHNG4r59sdZWou3k2hezg4");
const OFFSET = 456;
const conn = new Connection(RPC, "confirmed");

// anchor disc for seal_part
const { createHash } = await import("node:crypto");
const bs58 = require("bs58");
const disc = createHash("sha256").update("global:seal_part").digest().slice(0, 8);

const sigs = await conn.getSignaturesForAddress(BENCH, { limit: 50 });
for (const s of sigs) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys ?? msg.accountKeys;
  const ixs = msg.compiledInstructions ?? msg.instructions;
  for (const ix of ixs) {
    const prog = keys[ix.programIdIndex];
    if (!prog.equals(PID)) continue;
    const raw = typeof ix.data === "string" ? ix.data : ix.data;
    const data = raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(bs58.decode(raw));
    if (data.length < 19 || !data.slice(0, 8).equals(disc)) continue;
    const offset = data.readBigUInt64LE(8);
    const index = data.readUInt16LE(16);
    const part = data[18];
    const compAcc = arcium.getComputationAccAddress(OFFSET, { toBN: () => new (require("bn.js"))(offset.toString()) } );
    const info = await conn.getAccountInfo(compAcc);
    console.log(s.signature.slice(0, 20), "sealPart offset", offset.toString(), "chunk", index, "part", part,
      "-> compAcc", compAcc.toBase58(), info ? `${info.data.length}B` : "absent",
      "err:", JSON.stringify(s.err));
  }
}
