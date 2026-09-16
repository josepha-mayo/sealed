// Decode computation account status via the arcium program's account coder.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");
const arcium = require("@arcium-hq/client");

const conn = new Connection(process.env.RPC || "http://127.0.0.1:8899", "confirmed");
const provider = {
  connection: conn,
  wallet: { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
};
const prog = arcium.getArciumProgram(provider);
const names = Object.keys(prog.account);
console.log("arcium accounts:", names.filter((n) => /comp|exec|mempool|queue/i.test(n)));
for (const addr of process.argv.slice(2)) {
  const info = await conn.getAccountInfo(new PublicKey(addr));
  if (!info) { console.log(addr, "absent"); continue; }
  for (const n of names) {
    try {
      const acc = prog.account[n].coder.accounts.decode(n, info.data);
      if (acc) { console.log(addr, "->", n, JSON.stringify(acc, (_, v) => (typeof v === "bigint" ? v.toString() : v))); break; }
    } catch {}
  }
}
