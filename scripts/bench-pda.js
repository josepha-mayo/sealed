const { PublicKey, Keypair } = require("@solana/web3.js");
const { readFileSync } = require("fs");
const { homedir } = require("os");
const id = Number(process.argv[2]);
const w = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`, "utf8"))),
).publicKey;
const b = Buffer.alloc(4);
b.writeUInt32LE(id);
console.log(
  PublicKey.findProgramAddressSync(
    [Buffer.from("benchmark"), w.toBuffer(), b],
    new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ"),
  )[0].toBase58(),
);
