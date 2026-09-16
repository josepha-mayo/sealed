// Check whether the devnet comp defs have fully uploaded circuits.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");
const arcium = require("@arcium-hq/client");

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const PROG = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const conn = new Connection(RPC, "confirmed");
const arciumProg = arcium.getArciumProgram({ connection: conn, wallet: { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t } });

for (const name of ["seal_part", "score_chunk"]) {
  const compDef = arcium.getCompDefAccAddress(PROG, Buffer.from(arcium.getCompDefAccOffset(name)).readUInt32LE());
  const info = await conn.getAccountInfo(compDef);
  if (!info) { console.log(name, "comp def MISSING"); continue; }
  // Decode via the arcium program's account namespace if available
  try {
    const acc = await arciumProg.account.computationDefinitionAccount.fetch(compDef);
    const src = acc.circuitSource;
    console.log(name, "circuitSource:", JSON.stringify(src).slice(0, 400));
    if (src?.onChain?.[0]?.offset !== undefined) {
      const raw = arcium.getRawCircuitAccAddress(compDef, src.onChain[0].offset);
      const ri = await conn.getAccountInfo(raw);
      console.log("  raw acc", raw.toBase58(), ri ? `${ri.data.length} bytes` : "MISSING");
    }
  } catch (e) {
    console.log(name, "decode failed:", e.message, "size:", info.data.length);
  }
}
