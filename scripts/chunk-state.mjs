// Dump AnswerChunk state for a benchmark chunk on the given RPC.
// usage: node scripts/chunk-state.mjs <rpc> <authority> <bankId> <chunkIndex>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");

const [rpc, auth, bankId, ci] = process.argv.slice(2);
const conn = new Connection(rpc, "confirmed");
const PID = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const id = Buffer.alloc(4); id.writeUInt32LE(Number(bankId));
const [bench] = PublicKey.findProgramAddressSync([Buffer.from("benchmark"), new PublicKey(auth).toBuffer(), id], PID);
const idx = Buffer.alloc(2); idx.writeUInt16LE(Number(ci));
const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), bench.toBuffer(), idx], PID);
console.log("benchmark", bench.toBase58());
console.log("chunk", chunk.toBase58());
const info = await conn.getAccountInfo(chunk);
if (!info) { console.log("chunk account missing"); process.exit(0); }
const d = info.data;
// layout: 8 disc + benchmark 32 + index u16 + bump + parts_staged + parts_sealed + sealing_part + author 32 + nonces + cts
console.log("len", d.length);
console.log("partsStaged", d[43], "partsSealed", d[44], "sealingPart", d[45]);
