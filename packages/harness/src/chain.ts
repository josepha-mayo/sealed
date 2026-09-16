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
import type * as AnchorTypes from "@anchor-lang/core";
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
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  getLookupTableAddress,
  uploadCircuit,
  RescueCipher,
  deserializeLE,
} from "@arcium-hq/client";
import { randomBytes } from "node:crypto";
import { type Bank, CHUNK, PART, chunkHashes } from "./bank.js";
import { type RunArtifact, runChunkOutputs } from "./run.js";

const require = createRequire(import.meta.url);
// @anchor-lang/core is CommonJS; loading it through require keeps `BN`, `Program`, etc.
// as real constructors under ESM loaders.
const anchor: typeof AnchorTypes = require("@anchor-lang/core");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Args = Record<string, string | boolean>;

interface Ctx {
  provider: AnchorTypes.AnchorProvider;
  program: AnchorTypes.Program;
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

function arciumAccounts(ctx: Ctx, offset: AnchorTypes.BN, ix: string) {
  return {
    computationAccount: getComputationAccAddress(ctx.clusterOffset, offset),
    clusterAccount: getClusterAccAddress(ctx.clusterOffset),
    mxeAccount: getMXEAccAddress(ctx.program.programId),
    mempoolAccount: getMempoolAccAddress(ctx.clusterOffset),
    executingPool: getExecutingPoolAccAddress(ctx.clusterOffset),
    compDefAccount: getCompDefAccAddress(ctx.program.programId, Buffer.from(getCompDefAccOffset(ix)).readUInt32LE()),
  };
}

/** Poll an account until `done` (default cap 10 min) — devnet MPC callbacks lag finalization. */
async function waitFor(account: any, addr: PublicKey, done: (s: any) => boolean, timeoutMs = 10 * 60_000) {
  const t0 = Date.now();
  let s: any = await account.fetch(addr);
  while (!done(s) && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    s = await account.fetch(addr);
  }
  return s;
}

async function fetchOrNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ init

/** Initialize both computation definitions and upload the compiled circuits. Once per deployment. */
export async function init(ctx = setup()) {
  const { program, provider, wallet } = ctx;
  const arciumProgram = getArciumProgram(provider);
  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lut = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
  for (const [name, method] of [
    ["seal_part", "initSealPartCompDef"],
    ["score_chunk", "initScoreChunkCompDef"],
  ] as const) {
    const compDef = PublicKey.findProgramAddressSync(
      [getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), getCompDefAccOffset(name)],
      getArciumProgramId(),
    )[0];
    if (await provider.connection.getAccountInfo(compDef)) {
      const arciumProgram = getArciumProgram(provider);
      const def: any = await arciumProgram.account.computationDefinitionAccount.fetch(compDef);
      const uploaded = def.circuitSource?.onChain?.[0]?.isCompleted === true;
      console.log(`${name}: comp def exists (${compDef.toBase58()})${uploaded ? "" : " — circuit incomplete, resuming upload"}`);
      if (uploaded) continue;
      await uploadCircuit(provider, name, program.programId, readFileSync(join(ROOT, "build", `${name}.arcis`)), true);
      console.log(`${name}: circuit uploaded`);
      continue;
    }
    const sig = await (program.methods as any)[method]()
      .accounts({ compDefAccount: compDef, payer: wallet.publicKey, mxeAccount, addressLookupTable: lut })
      .rpc({ commitment: "confirmed" });
    console.log(`${name}: comp def initialized ${sig}`);
    await uploadCircuit(provider, name, program.programId, readFileSync(join(ROOT, "build", `${name}.arcis`)), true);
    console.log(`${name}: circuit uploaded`);
  }
}

// ------------------------------------------------------------------ seal

export async function seal(bank: Bank, feeLamports: bigint, ctx = setup()) {
  const { program, provider, wallet } = ctx;
  const { benchmark, chunk } = pdas(ctx, wallet.publicKey, bank.benchmarkId);
  const acct = program.account as any;

  let b: any = await fetchOrNull(acct.benchmark.fetch(benchmark));
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
    let state: any = await fetchOrNull(acct.answerChunk.fetch(c));
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
      if (state.sealingPart === p) {
        // A seal computation is already queued; its offset is unknown, so poll the account.
        process.stdout.write(`chunk ${i} part ${p}: seal in flight, waiting...`);
        state = await waitFor(acct.answerChunk, c, (s) => (s.partsSealed & (1 << p)) !== 0);
        console.log(state.partsSealed & (1 << p) ? " sealed" : " STILL PENDING");
        continue;
      }
      if (!(state.partsStaged & (1 << p))) {
        const nonce = randomBytes(16);
        const cts = cipher.encrypt(hashes.slice(p * PART, (p + 1) * PART), nonce);
        await program.methods
          .stagePart(i, p, Array.from(pub), new anchor.BN(deserializeLE(nonce).toString()), cts.map((x) => Array.from(x)))
          .accounts({ authority: wallet.publicKey, benchmark, chunk: c })
          .rpc({ commitment: "confirmed" });
      }
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .sealPart(offset, i, p)
        .accountsPartial({ payer: wallet.publicKey, benchmark, chunk: c, ...arciumAccounts(ctx, offset, "seal_part") })
        .rpc({ commitment: "confirmed" });
      process.stdout.write(`chunk ${i} part ${p}: staged, sealing in MPC...`);
      state = await waitFor(acct.answerChunk, c, (s) => (s.partsSealed & (1 << p)) !== 0);
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

export async function score(bank: Bank, run: RunArtifact, authority: PublicKey, createOnly = false, runIndexOverride?: bigint, ctx = setup()) {
  const { program, provider, wallet } = ctx;
  if (run.benchmarkId !== bank.benchmarkId) throw new Error("run/bank benchmark id mismatch");
  const { benchmark, chunk, run: runPda } = pdas(ctx, authority, bank.benchmarkId);
  const acct = program.account as any;
  const b = await acct.benchmark.fetch(benchmark);
  if (b.status !== 1) throw new Error(`benchmark not live (status ${b.status})`);

  const runIndex = runIndexOverride ?? BigInt(b.runCount.toString());
  const r = runPda(runIndex);
  let state: any = await fetchOrNull(acct.run.fetch(r));
  if (!state) {
    if (runIndexOverride !== undefined) throw new Error(`run #${runIndex} does not exist`);
    console.log(`create_run #${runIndex} model=${run.model} fee=${Number(b.feeLamports) / LAMPORTS_PER_SOL} SOL`);
    await program.methods
      .createRun(run.model, Array.from(Buffer.from(run.harnessHash, "hex")), Array.from(Buffer.from(run.outputsRoot, "hex")))
      .accountsPartial({ runner: wallet.publicKey, authority, benchmark, run: r })
      .rpc({ commitment: "confirmed" });
    state = await acct.run.fetch(r);
  } else {
    if (run.model !== state.modelId) throw new Error(`run #${runIndex} already exists for model ${state.modelId}`);
    console.log(`run #${runIndex} exists (scored_mask=${state.scoredMask}); resuming`);
  }
  if (createOnly) {
    console.log(`run ${r.toBase58()} created (pending, unscored)`);
    return r;
  }

  let correct = Number(state.correct);
  for (let i = 0; i < bank.chunkCount; i++) {
    state = await acct.run.fetch(r);
    const bit = 1n << BigInt(i);
    const scored = BigInt(state.scoredMask.toString()) & bit;
    const pending = BigInt(state.pendingMask.toString()) & bit;
    if (scored) {
      console.log(`chunk ${i}: already scored`);
      continue;
    }
    if (!pending) {
      const outputs = runChunkOutputs(run, i).map((h) => new anchor.BN(h.toString()));
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(runIndex.toString()), i, outputs)
        .accountsPartial({ payer: wallet.publicKey, run: r, runner: wallet.publicKey, chunk: chunk(i), ...arciumAccounts(ctx, offset, "score_chunk") })
        .rpc({ commitment: "confirmed" });
    }
    process.stdout.write(`chunk ${i}: ${pending ? "scoring already in flight" : "scoring in MPC"}...`);
    state = await waitFor(acct.run, r, (s) => (BigInt(s.scoredMask.toString()) & bit) !== 0n);
    const delta = Number(state.correct) - correct;
    correct = Number(state.correct);
    console.log(scored || (BigInt(state.scoredMask.toString()) & bit) ? ` +${delta} (total ${correct})` : " STILL PENDING");
  }
  const final = await acct.run.fetch(r);
  const items = bank.chunkCount * CHUNK;
  console.log(
    `run ${r.toBase58()} ${final.status === 1 ? "FINALIZED" : "pending"}: ${final.correct}/${items} = ${((100 * Number(final.correct)) / items).toFixed(1)}%` +
      (run.localCorrect !== Number(final.correct) ? `  (local pre-score ${run.localCorrect} DIFFERS)` : "  (matches local pre-score)"),
  );
  return r;
}

/** Clear a stuck sealing_part flag after a dropped/expired MPC computation. */
export async function resetSealing(benchmarkId: number, chunkIndex: number, ctx = setup()) {
  const { program, wallet } = ctx;
  const { benchmark, chunk } = pdas(ctx, wallet.publicKey, benchmarkId);
  const acct = program.account as any;
  const state: any = await acct.answerChunk.fetch(chunk(chunkIndex));
  console.log(`chunk ${chunkIndex}: sealingPart=${state.sealingPart} -> clearing`);
  const sig = await program.methods
    .resetSealing(chunkIndex)
    .accounts({ authority: wallet.publicKey, benchmark, chunk: chunk(chunkIndex) })
    .rpc({ commitment: "confirmed" });
  console.log(`reset_sealing ${sig}`);
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

// ------------------------------------------------------------------ market

/** Parimutuel YES/NO markets that resolve on a finalized Run's `correct` field. */
const MARKET_PROGRAM_ID = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

function marketProgram(kpPath?: string) {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const kp = kpPath ? loadKeypair(kpPath) : loadKeypair(process.env.ANCHOR_WALLET ?? join(homedir(), ".config", "solana", "id.json"));
  const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(kp), { commitment: "confirmed" });
  const idl = require(join(ROOT, "target", "idl", "market.json"));
  if (process.env.MARKET_PROGRAM_ID) idl.address = process.env.MARKET_PROGRAM_ID;
  return { market: new anchor.Program(idl, provider), kp };
}

const marketPda = (run: PublicKey, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("market"), run.toBuffer()], pid)[0];
const positionPda = (market: PublicKey, bettor: PublicKey, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), bettor.toBuffer()], pid)[0];

async function marketOpen(run: PublicKey, threshold: number, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m = marketPda(run, market.programId);
  await (market.methods as any)
    .createMarket(threshold)
    .accounts({ authority: kp.publicKey, run, market: m })
    .rpc({ commitment: "confirmed" });
  console.log(`market ${m.toBase58()} opened: run ${run.toBase58()} threshold=${threshold}`);
  return m;
}

async function marketBet(marketPk: PublicKey, side: "yes" | "no", lamports: bigint, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m: any = await (market.account as any).market.fetch(marketPk);
  const position = positionPda(marketPk, kp.publicKey, market.programId);
  const sig = await (market.methods as any)
    .bet(side === "yes" ? 1 : 2, new anchor.BN(lamports.toString()))
    .accounts({ bettor: kp.publicKey, run: m.run, market: marketPk, position })
    .rpc({ commitment: "confirmed" });
  console.log(`bet ${side.toUpperCase()} ${Number(lamports) / LAMPORTS_PER_SOL} SOL by ${kp.publicKey.toBase58()} (${sig})`);
}

async function marketResolve(marketPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const m: any = await (market.account as any).market.fetch(marketPk);
  const sig = await (market.methods as any)
    .resolve()
    .accounts({ run: m.run, market: marketPk })
    .rpc({ commitment: "confirmed" });
  const after: any = await (market.account as any).market.fetch(marketPk);
  const oc = after.status === 2 ? "CANCELLED" : after.outcome === 1 ? "YES" : "NO";
  console.log(`market resolved (${sig}): score=${after.resolvedScore} threshold=${after.threshold} outcome=${oc}`);
}

async function marketClaim(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const position = positionPda(marketPk, kp.publicKey, market.programId);
  const before = await provider0(kp).getBalance(kp.publicKey);
  const sig = await (market.methods as any)
    .claim()
    .accounts({ bettor: kp.publicKey, market: marketPk, position })
    .rpc({ commitment: "confirmed" });
  const after = await provider0(kp).getBalance(kp.publicKey);
  console.log(`claim (${sig}): ${kp.publicKey.toBase58()} balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
}

function provider0(kp: Keypair) {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  return new Connection(url, "confirmed");
}

async function marketShow(marketPk: PublicKey) {
  const { market } = marketProgram();
  const m: any = await (market.account as any).market.fetch(marketPk);
  const status = ["OPEN", "RESOLVED", "CANCELLED"][m.status as number];
  const outcome = ["-", "YES", "NO"][m.outcome as number];
  console.log(`market ${marketPk.toBase58()} status=${status}`);
  console.log(`  run=${m.run.toBase58()} benchmark=${m.benchmark.toBase58()} run_index=${m.runIndex}`);
  console.log(`  question: will run.correct >= ${m.threshold}?  resolved_score=${m.resolvedScore} outcome=${outcome}`);
  console.log(`  pot: yes=${Number(m.yesTotal) / LAMPORTS_PER_SOL} SOL no=${Number(m.noTotal) / LAMPORTS_PER_SOL} SOL`);
  const positions = await (market.account as any).position.all([{ memcmp: { offset: 8, bytes: marketPk.toBase58() } }]);
  for (const { account: p } of positions) {
    console.log(`  position ${p.bettor.toBase58()} yes=${Number(p.yes) / LAMPORTS_PER_SOL} no=${Number(p.no) / LAMPORTS_PER_SOL} claimed=${p.claimed}`);
  }
}

// ------------------------------------------------------------------ cli glue

export async function chainMain(cmd: string[], args: Args) {
  const loadJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const [sub] = cmd;
  if (sub === "init") {
    await init();
    return;
  }
  if (sub === "reset-sealing") {
    await resetSealing(Number(args["bank-id"]), Number(args.chunk));
    return;
  }
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
    const idx = args["run-index"] !== undefined ? BigInt(String(args["run-index"])) : undefined;
    await score(bank, run, authority, Boolean(args["create-only"]), idx, ctx);
    return;
  }
  if (sub === "status") {
    await status(new PublicKey(String(args.benchmark)));
    return;
  }
  if (sub === "market") {
    const [m0] = cmd.slice(1);
    const bettor = args.bettor as string | undefined;
    if (m0 === "open") {
      const run = new PublicKey(String(args.run));
      await marketOpen(run, Number(args.threshold), bettor);
    } else if (m0 === "bet") {
      const side = String(args.side);
      if (side !== "yes" && side !== "no") throw new Error("--side yes|no");
      await marketBet(new PublicKey(String(args.market)), side, BigInt(String(args.lamports)), bettor);
    } else if (m0 === "resolve") {
      await marketResolve(new PublicKey(String(args.market)), bettor);
    } else if (m0 === "claim") {
      await marketClaim(new PublicKey(String(args.market)), bettor);
    } else if (m0 === "show") {
      await marketShow(new PublicKey(String(args.market)));
    } else throw new Error(`unknown market command: ${m0}`);
    return;
  }
  throw new Error(`unknown chain command: ${sub}`);
}
