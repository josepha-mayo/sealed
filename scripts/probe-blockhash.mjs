// probe-blockhash.mjs — reproduce the "Blockhash not found" flake pattern:
// idle for ~80s (mimicking an MPC wait), then fire rapid program txs.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));

const fire = async (label) => {
  const to = Keypair.generate().publicKey;
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: 1_000_000 })
    ), [kp], { preflightCommitment: "processed", commitment: "confirmed" });
    console.log(`${label} OK ${sig.slice(0, 16)}`);
    return true;
  } catch (e) {
    console.log(`${label} FAIL ${String(e).slice(0, 120)}`);
    return false;
  }
};

await fire("t0");
const bh = await conn.getLatestBlockhash("confirmed");
console.log(`getLatestBlockhash -> ${bh.blockhash.slice(0, 16)} lastValid=${bh.lastValidBlockHeight} slot=${await conn.getSlot()}`);

console.log("sleeping 80s (mimicking an MPC callback wait)...");
await new Promise((r) => setTimeout(r, 80000));

let ok = 0, fail = 0;
for (let i = 0; i < 10; i++) (await fire(`post-wait #${i}`)) ? ok++ : fail++;
console.log(`post-wait: ${ok} ok / ${fail} fail`);
