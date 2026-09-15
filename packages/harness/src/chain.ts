/**
 * Chain client: drives the Sealed program from a bank file (seal) and a run
 * artifact (score), and prints leaderboards (status).
 *
 * Env: ANCHOR_PROVIDER_URL (default http://127.0.0.1:8899), ANCHOR_WALLET
 *      (default ~/.config/solana/id.json), SEALED_CLUSTER_OFFSET (Arcium cluster
 *      offset; localnet value comes from `arcium` env, devnet is 456).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@anchor-lang/core";
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  x25519,
  getComputationAccAddress,
  getMXEPublicKey,
  getClusterAccAddress,
  RescueCipher,
  deserializeLE,
} from "@arcium-hq/client";
import { randomBytes } from "node:crypto";
import { type Bank, CHUNK, PART, chunkHashes } from "./bank.js";
import { type RunArtifact, runChunkOutputs } from "./run.js";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Args = Record<string, string | boolean>;

interface Ctx {
  provider: anchor.AnchorProvider;
  program: anchor.Program;
  wallet: Keypair;
  clusterOffset: number;
}

function setup(): Ctx {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const walletPath = process.env.ANCHOR_WALLET ?? join(homedir(), ".config", "solana", "id.json");
  const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const idl = require(join(ROOT, "target", "idl", "sealed.json"));
  if (process.env.SEALED_PROGRAM_ID) idl.address = process.env.SEALED_PROGRAM_ID;
  const program = new anchor.Program(idl, provider);
  let clusterOffset: number;
  if (process.env.SEALED_CLUSTER_OFFSET) clusterOffset = Number(process.env.SEALED_CLUSTER_OFFSET);
  else {
    try {
      clusterOffset = getArciumEnv().arciumClusterOffset;
    } catch {
      throw new Error("set SEALED_CLUSTER_OFFSET (devnet: 456) or run inside `arcium` env");
    }
  }
  return { provider, program, wallet, clusterOffset };
}

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

function pdas(ctx: Ctx, authority: PublicKey, benchmarkId: number) {
  const pid = ctx.program.programId;
  const [benchmark] = PublicKey.findProgramAddressSync([Buffer.from("benchmark"), authority.toBuffer(), u32le(benchmarkId)], pid);
  const chunk = (i: number) => PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(i)], pid)[0];
  const run = (i: bigint) => PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(i)], pid)[0];
  return { benchmark, chunk, run };
}

function arciumAccounts(ctx: Ctx, offset: anchor.BN, ix: string) {
  return {
    computationAccount: getComputationAccAddress(ctx.clusterOffset, offset),
    clusterAccount: getClusterAccAddress(ctx.clusterOffset),
    mxeAccount: getMXEAccAddress(ctx.program.programId),
    mempoolAccount: getMempoolAccAddress(ctx.clusterOffset),
    executingPool: getExecutingPoolAccAddress(ctx.clusterOffset),
    compDefAccount: getCompDefAccAddress(ctx.program.programId, Buffer.from(getCompDefAccOffset(ix)).readUInt32LE()),
  };
}

async function fetchOrNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ seal

export async function seal(bank: Bank, feeLamports: bigint, ctx = setup()) {
  const { program, provider, wallet } = ctx;
  const { benchmark, chunk } = pdas(ctx, wallet.publicKey, bank.benchmarkId);
  const acct = program.account as any;

  let b = await fetchOrNull(acct.benchmark.fetch(benchmark));
  if (!b) {
    console.log(`create_benchmark id=${bank.benchmarkId} chunks=${bank.chunkCount} root=${bank.itemsRoot}`);
    await program.methods
      .createBenchmark(bank.benchmarkId, `sealed-v${bank.benchmarkId}`, bank.chunkCount, Array.from(Buffer.from(bank.itemsRoot, "hex")), new anchor.BN(feeLamports.toString()))
      .accounts({ authority: wallet.publicKey })
      .rpc({ commitment: "confirmed" });
    b = await acct.benchmark.fetch(benchmark);
  } else if (Buffer.from(b.itemsRoot).toString("hex") !== bank.itemsRoot) {
    throw new Error(`benchmark ${benchmark.toBase58()} exists with a different items_root; bump the id`);
  }
  console.log(`benchmark ${benchmark.toBase58()} status=${b.status} sealed=${b.chunksSealed}/${b.chunkCount}`);

  const mxePublicKey = await getMXEPublicKey(provider, program.programId);
  if (!mxePublicKey) throw new Error("MXE public key unavailable (is the MXE initialized on this cluster?)");
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxePublicKey));

  const PARTS = CHUNK / PART;
  const ALL = (1 << PARTS) - 1;
  for (let i = 0; i < bank.chunkCount; i++) {
    const c = chunk(i);
    let state = await fetchOrNull(acct.answerChunk.fetch(c));
    if (state?.partsSealed === ALL) {
      console.log(`chunk ${i}: already sealed`);
      continue;
    }
    if (!state) {
      await program.methods.initChunk(i).accounts({ authority: wallet.publicKey, benchmark }).rpc({ commitment: "confirmed" });
      state = await acct.answerChunk.fetch(c);
    }
    const hashes = chunkHashes(bank, i);
    for (let p = 0; p < PARTS; p++) {
      if (state.partsSealed & (1 << p)) continue;
      const nonce = randomBytes(16);
      const cts = cipher.encrypt(hashes.slice(p * PART, (p + 1) * PART), nonce);
      await program.methods
        .stagePart(i, p, Array.from(pub), new anchor.BN(deserializeLE(nonce).toString()), cts.map((x) => Array.from(x)))
        .accounts({ authority: wallet.publicKey, benchmark, chunk: c })
        .rpc({ commitment: "confirmed" });
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .sealPart(offset, i, p)
        .accountsPartial({ payer: wallet.publicKey, benchmark, chunk: c, ...arciumAccounts(ctx, offset, "seal_part") })
        .rpc({ commitment: "confirmed" });
      process.stdout.write(`chunk ${i} part ${p}: staged, sealing in MPC...`);
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
      state = await acct.answerChunk.fetch(c);
      console.log(state.partsSealed & (1 << p) ? " sealed" : " NOT sealed?!");
    }
  }
  // The author key is dropped here; nothing can decrypt the staged ciphertexts again.
  priv.fill(0);
  b = await acct.benchmark.fetch(benchmark);
  console.log(`benchmark ${benchmark.toBase58()} status=${b.status === 1 ? "LIVE" : b.status} sealed=${b.chunksSealed}/${b.chunkCount}`);
  return benchmark;
}

// ------------------------------------------------------------------ score

export async function score(bank: Bank, run: RunArtifact, authority: PublicKey, ctx = setup()) {
  const { program, provider, wallet } = ctx;
  if (run.benchmarkId !== bank.benchmarkId) throw new Error("run/bank benchmark id mismatch");
  const { benchmark, chunk, run: runPda } = pdas(ctx, authority, bank.benchmarkId);
  const acct = program.account as any;
  const b = await acct.benchmark.fetch(benchmark);
  if (b.status !== 1) throw new Error(`benchmark not live (status ${b.status})`);

  const runIndex = BigInt(b.runCount.toString());
  const r = runPda(runIndex);
  console.log(`create_run #${runIndex} model=${run.model} fee=${Number(b.feeLamports) / LAMPORTS_PER_SOL} SOL`);
  await program.methods
    .createRun(run.model, Array.from(Buffer.from(run.harnessHash, "hex")), Array.from(Buffer.from(run.outputsRoot, "hex")))
    .accountsPartial({ runner: wallet.publicKey, authority, benchmark, run: r })
    .rpc({ commitment: "confirmed" });

  let correct = 0;
  for (let i = 0; i < bank.chunkCount; i++) {
    const outputs = runChunkOutputs(run, i).map((h) => new anchor.BN(h.toString()));
    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .scoreChunk(offset, new anchor.BN(runIndex.toString()), i, outputs)
      .accountsPartial({ payer: wallet.publicKey, run: r, runner: wallet.publicKey, chunk: chunk(i), ...arciumAccounts(ctx, offset, "score_chunk") })
      .rpc({ commitment: "confirmed" });
    process.stdout.write(`chunk ${i}: scoring in MPC...`);
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    const state = await acct.run.fetch(r);
    const delta = Number(state.correct) - correct;
    correct = Number(state.correct);
    console.log(` +${delta} (total ${correct})`);
  }
  const final = await acct.run.fetch(r);
  const items = bank.chunkCount * CHUNK;
  console.log(
    `run ${r.toBase58()} ${final.status === 1 ? "FINALIZED" : "pending"}: ${final.correct}/${items} = ${((100 * Number(final.correct)) / items).toFixed(1)}%` +
      (run.localCorrect !== Number(final.correct) ? `  (local pre-score ${run.localCorrect} DIFFERS)` : "  (matches local pre-score)"),
  );
  return r;
}

// ------------------------------------------------------------------ status

export async function status(benchmark: PublicKey, ctx = setup()) {
  const acct = ctx.program.account as any;
  const b = await acct.benchmark.fetch(benchmark);
  const items = b.chunkCount * CHUNK;
  console.log(`benchmark ${benchmark.toBase58()} "${b.name}" status=${b.status} items=${items} runs=${b.runCount} root=${Buffer.from(b.itemsRoot).toString("hex")}`);
  const runs = await acct.run.all([{ memcmp: { offset: 8, bytes: benchmark.toBase58() } }]);
  const rows = runs
    .map((x: any) => x.account)
    .filter((r: any) => r.status === 1)
    .sort((p: any, q: any) => Number(q.correct) - Number(p.correct));
  console.log("rank  score      model                                   run");
  rows.forEach((r: any, i: number) => {
    const pct = ((100 * Number(r.correct)) / items).toFixed(1).padStart(5);
    console.log(`${String(i + 1).padStart(4)}  ${pct}%  ${String(Number(r.correct)).padStart(4)}/${items}  ${r.modelId.padEnd(38)} #${r.index}`);
  });
}

// ------------------------------------------------------------------ cli glue

export async function chainMain(cmd: string[], args: Args) {
  const loadJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const [sub] = cmd;
  if (sub === "seal") {
    const bank = loadJson(String(args.bank)) as Bank;
    const fee = BigInt(String(args["fee-lamports"] ?? 0));
    await seal(bank, fee);
    return;
  }
  if (sub === "score") {
    const bank = loadJson(String(args.bank)) as Bank;
    const run = loadJson(String(args.run)) as RunArtifact;
    const ctx = setup();
    const authority = args.authority ? new PublicKey(String(args.authority)) : ctx.wallet.publicKey;
    await score(bank, run, authority, ctx);
    return;
  }
  if (sub === "status") {
    await status(new PublicKey(String(args.benchmark)));
    return;
  }
  throw new Error(`unknown chain command: ${sub}`);
}
