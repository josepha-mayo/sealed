#!/usr/bin/env node
// Resumable upgradeable-loader buffer writer — grinds `solana program
// write-buffer` down to per-offset Write instructions with deliberate
// pacing, so it survives free-tier devnet rate limits that kill the CLI's
// bursty all-or-nothing attempts.
//
//   node scripts/write-buffer-resumable.mjs target/deploy/sealed.so \
//     --buffer <BUFFER_PUBKEY> [--rpc <url>] [--chunk 976] [--pace 900]
//
// Resume: on start it downloads the buffer's current bytes, diffs against
// the local ELF, and skips every prefix region that already matches —
// interrupted runs continue where they stopped instead of rewriting.
// Buffer account layout: 4B variant(1=Buffer) + 1B Option tag + 32B
// authority + data — the 37-byte header is left untouched.
//
// After this completes, finalize with:
//   solana program deploy --buffer <buffer> --program-id <program keypair> -u <rpc>

import { readFileSync } from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const ELF = process.argv[2] ?? "target/deploy/sealed.so";
const BUF = arg("--buffer", null);
const RPC = arg("--rpc", process.env.SEALED_RPC_URL ?? "https://api.devnet.solana.com");
const CHUNK = Number(arg("--chunk", 976));
const PACE = Number(arg("--pace", 900));
const KEYPAIR = arg("--keypair", join(homedir(), ".config", "solana", "id.json"));
const HDR = 37;

if (!BUF) { console.error("--buffer <pubkey> required"); process.exit(2); }

const elf = readFileSync(ELF);
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const bufPk = new PublicKey(BUF);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcRetry(fn, label) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (i >= 24) throw new Error(`${label}: gave up after ${i} retries — ${msg}`);
      const wait = Math.min(2000 * 2 ** Math.min(i, 6), 60000) + Math.random() * 1000;
      if (i % 4 === 0) console.log(`  ${label}: retry ${i} (${msg.slice(0, 80)}) — waiting ${(wait / 1000).toFixed(0)}s`);
      await sleep(wait);
    }
  }
}

// the Write instruction (bincode): variant u32 LE = 1, offset u32 LE,
// bytes Vec<u8> (u64 len LE + payload). Keys: buffer(w), authority(signer).
function writeIx(offset, bytes) {
  const data = Buffer.alloc(4 + 4 + 8 + bytes.length);
  data.writeUInt32LE(1, 0);
  data.writeUInt32LE(offset, 4);
  data.writeBigUInt64LE(BigInt(bytes.length), 8);
  bytes.copy(data, 16);
  return new TransactionInstruction({
    programId: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    keys: [
      { pubkey: bufPk, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// 1. find the resume offset: fetch the buffer, diff data region vs ELF.
const info = await rpcRetry(() => conn.getAccountInfo(bufPk), "getAccountInfo");
if (!info) { console.error(`buffer ${BUF} does not exist — create it first via solana program write-buffer`); process.exit(1); }
if (info.data.length !== elf.length + HDR) {
  console.error(`buffer size ${info.data.length} != 37 + ELF ${elf.length} — recreate the buffer`); process.exit(1);
}
const onchain = info.data.subarray(HDR);
let start = 0;
while (start < elf.length && onchain[start] === elf[start]) start++;
// align to the last completed chunk boundary (a partial chunk's tail may
// be zeros that coincidentally match — rewrite the whole chunk for safety)
start = Math.floor(start / CHUNK) * CHUNK;
console.log(`buffer ${BUF} — ${onchain.length} bytes on-chain, ${start} already match; resuming at offset ${start}`);
if (start >= elf.length) { console.log("buffer already holds the exact ELF — nothing to write"); process.exit(0); }

// 2. fire-and-forget writes — sendRawTransaction costs ONE rpc call vs
// sendAndConfirm's ~10+ confirmation polls; under a per-IP cap that
// difference is the whole ballgame. Batch-status checks every ~40 sends;
// the final byte-diff catches any dropped tx and the outer loop rewrites
// just those ranges.
for (let round = 1; round <= 6; round++) {
  const info2 = await rpcRetry(() => conn.getAccountInfo(bufPk), "diff fetch");
  const cur = info2.data.subarray(HDR);
  const missing = [];
  for (let off = start; off < elf.length; off += CHUNK) {
    const end = Math.min(off + CHUNK, elf.length);
    if (!cur.subarray(off, end).equals(elf.subarray(off, end))) missing.push([off, end]);
  }
  if (!missing.length) break;
  console.log(`round ${round}: ${missing.length} chunk(s) missing`);
  const sent = [];
  for (const [off, end] of missing) {
    const bytes = elf.subarray(off, end);
    const sig = await rpcRetry(async () => {
      const tx = new Transaction().add(writeIx(off, bytes));
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.feePayer = kp.publicKey;
      tx.sign(kp);
      return conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    }, `send@${off}`);
    sent.push(sig);
    if (sent.length % 40 === 0) {
      // one batched status check per 40 sends — cheap progress signal
      const st = await rpcRetry(() => conn.getSignatureStatuses(sent.slice(-40)), "status batch").catch(() => null);
      const ok = st?.value?.filter(Boolean).filter((s) => !s.err).length ?? "?";
      console.log(`  sent ${sent.length}/${missing.length} — ${ok}/40 last batch confirmed`);
    }
    await sleep(PACE);
  }
  await sleep(15000); // let the last writes land before the next diff
}

// 3. verify the full bytes landed.
const after = await rpcRetry(() => conn.getAccountInfo(bufPk), "verify fetch");
const match = after && after.data.subarray(HDR).equals(elf);
console.log(match
  ? `BUFFER COMPLETE — ${elf.length} bytes verified on-chain. Finalize: solana program deploy --buffer ${BUF} --program-id <program keypair>`
  : `VERIFY FAILED — bytes still differ; re-run to resume`);
process.exit(match ? 0 : 1);
