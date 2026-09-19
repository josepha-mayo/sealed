import { createRequire } from "node:module";
import { getMXEPublicKey } from "@arcium-hq/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const anchor = require("@anchor-lang/core");

const url = process.argv[2] ?? "http://127.0.0.1:8899";
const wallet = process.argv[3] ?? `${process.env.HOME}/.config/solana/id.json`;
const pid = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(wallet, "utf8"))));
const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(kp), {});
const key = await getMXEPublicKey(provider, pid);
console.log(key ? "LIVE" : "PENDING");
