/**
 * Chain client: drives the Sealed program from a bank file (seal) and a run
 * artifact (score), and prints leaderboards (status).
 *
 * Env: ANCHOR_PROVIDER_URL (default http://127.0.0.1:8899), ANCHOR_WALLET
 *      (default ~/.config/solana/id.json), SEALED_CLUSTER_OFFSET (Arcium cluster
 *      offset; localnet value comes from `arcium` env, devnet is 456).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { createHash, randomBytes } from "node:crypto";
import { type Bank, CHUNK, PART, chunkHashes } from "./bank.js";
import {
  bankFromChunks,
  decodeItemChunk,
  decodePrivItemChunk,
  privBankFromSpecs,
  privItemsRoot,
  renderPrompt,
  unpackSpecs,
  type ItemChunkState,
  type ItemSpec,
  type PrivItemChunkState,
} from "./genbank.js";
import { type RunArtifact, runChunkOutputs } from "./run.js";
import { chunkOutLeaves, merkleProof, itemLeaf, merkleRoot, hex } from "./hash.js";
import { evalGate, type GatePolicy, type GateVerdict, type ScoreReceipt } from "./gate.js";
import { classifyBoard, proven, type BoardRun } from "./board.js";
import { decodeSnapshotSection, loadSnapshotJson, snapOf, type SnapAccount } from "./snapshot.js";
import { ed25519 } from "@noble/curves/ed25519";

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
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { preflightCommitment: "processed", commitment: "confirmed" });
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

/** Sealed program client WITHOUT the Arcium env — for read paths (run/bank
 *  fetches) and recovery ixs like `unbrick_pda` that don't touch the cluster. */
/** Program id without a wallet — enough for PDA derivation in
 *  `--snapshot` replay mode, which must work keyless. */
/** `.all()` batch-decodes every account of a type — a single old-layout
 *  account (a real class on the merged devnet epochs) bricks the whole
 *  fetch. Fall back to fetching raw accounts by discriminator and
 *  decoding each individually, skipping what doesn't fit this IDL —
 *  the exact tolerance snapshot.ts already applies offline. */
async function tolerantAll(program: any, name: string): Promise<{ publicKey: PublicKey; account: any }[]> {
  try { return await (program.account as any)[name].all(); } catch { /* fall through */ }
  const disc = (program.coder.accounts as any).accountDiscriminator(name);
  const raw = await (program.provider.connection as Connection).getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }],
  });
  const out: { publicKey: PublicKey; account: any }[] = [];
  for (const { pubkey, account: acct } of raw) {
    try {
      const dec = (program.coder.accounts as any).decode(name, acct.data);
      const account: any = {};
      for (const [k, v] of Object.entries(dec)) account[k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())] = v;
      out.push({ publicKey: pubkey, account });
    } catch { /* layout predates this IDL — skip */ }
  }
  return out;
}

function sealedProgramId(): PublicKey {
  const idl = require(join(ROOT, "target", "idl", "sealed.json"));
  return new PublicKey(process.env.SEALED_PROGRAM_ID ?? idl.address);
}

function sealedProgram(kpPath?: string) {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const kp = kpPath
    ? loadKeypair(kpPath)
    : loadKeypair(process.env.ANCHOR_WALLET ?? join(homedir(), ".config", "solana", "id.json"));
  const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(kp), { preflightCommitment: "processed", commitment: "confirmed" });
  const idl = require(join(ROOT, "target", "idl", "sealed.json"));
  if (process.env.SEALED_PROGRAM_ID) idl.address = process.env.SEALED_PROGRAM_ID;
  return { program: new anchor.Program(idl, provider), kp, provider };
}

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

function pdas(ctx: Ctx, authority: PublicKey, benchmarkId: number) {
  const pid = ctx.program.programId;
  const [benchmark] = PublicKey.findProgramAddressSync([Buffer.from("benchmark"), authority.toBuffer(), u32le(benchmarkId)], pid);
  const chunk = (i: number) => PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(i)], pid)[0];
  const items = (i: number) => PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(i)], pid)[0];
  const pitems = (i: number) => PublicKey.findProgramAddressSync([Buffer.from("pitems"), benchmark.toBuffer(), u16le(i)], pid)[0];
  const run = (i: bigint) => PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(i)], pid)[0];
  const reveal = (i: number, p: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("reveal"), benchmark.toBuffer(), u16le(i), Uint8Array.of(p)], pid)[0];
  const grant = (i: number, p: number, viewer: Uint8Array) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("grant"), benchmark.toBuffer(), u16le(i), Uint8Array.of(p), viewer],
      pid,
    )[0];
  return { benchmark, chunk, items, pitems, run, reveal, grant };
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
  // Eagerly create the shared signer PDA — a grief-prefund before first use
  // would stall every queue path (create_account rejects lamport-carrying
  // PDAs); init_signer_pda drains prefunds and always succeeds. Call it
  // unconditionally: a prefunded-but-uninitialized account HAS an
  // AccountInfo (that's the grief), so an existence check would skip the
  // fix exactly when it's needed.
  const [signPda] = PublicKey.findProgramAddressSync([Buffer.from("ArciumSignerAccount")], program.programId);
  const sig = await program.methods
    .initSignerPda()
    .accounts({ payer: wallet.publicKey, signPdaAccount: signPda })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`sign_pda_account ensured (${sig})`);
  const arciumProgram = getArciumProgram(provider);
  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lut = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
  for (const [name, method] of [
    ["seal_part", "initSealPartCompDef"],
    ["score_chunk", "initScoreChunkCompDef"],
    ["gen_part", "initGenPartCompDef"],
    ["gen_part_private", "initGenPartPrivateCompDef"],
    ["reveal_part", "initRevealPartCompDef"],
    ["reshare_part", "initResharePartCompDef"],
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
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
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
      .createBenchmark(bank.benchmarkId, `sealed-v${bank.benchmarkId}`, bank.chunkCount, Array.from(Buffer.from(bank.itemsRoot, "hex")), new anchor.BN(feeLamports.toString()), 0)
      .accounts({ authority: wallet.publicKey })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    b = await acct.benchmark.fetch(benchmark);
  } else if (b.kind !== 0) {
    throw new Error(`benchmark ${benchmark.toBase58()} is a generated bank; use 'chain gen'`);
  } else if (Buffer.from(b.itemsRoot).toString("hex") !== bank.itemsRoot) {
    throw new Error(`benchmark ${benchmark.toBase58()} exists with a different items_root; bump the id`);
  }
  console.log(`benchmark ${benchmark.toBase58()} status=${b.status} sealed=${b.chunksSealed}/${b.chunkCount}`);

  const mxePublicKey = await getMXEPublicKey(provider, program.programId);
  if (!mxePublicKey) throw new Error("MXE public key unavailable (is the MXE initialized on this cluster?)");
  // Deterministic author key: `stage_part` pins `author_pubkey` once any part
  // is staged, so a mid-run restart with a fresh random key would brick the
  // chunk on `StagingKeyMismatch` forever. Derive from the wallet — same key
  // every run, domain-separated from the private-bank viewer key.
  const priv = createHash("sha256")
    .update("sealed/author-key\0")
    .update(wallet.secretKey.subarray(0, 32))
    .digest();
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
      await program.methods.initChunk(i).accounts({ authority: wallet.publicKey, benchmark }).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
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
          .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      }
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .sealPart(offset, i, p)
        .accountsPartial({ payer: wallet.publicKey, benchmark, chunk: c, ...arciumAccounts(ctx, offset, "seal_part") })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
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

// ------------------------------------------------------------------ generated banks

/**
 * Mint a generated bank: the items are drawn from MPC randomness by `gen_part`,
 * the answer fingerprints are born encrypted to the MXE key, and only the public
 * item specs land on-chain (in `ItemChunk` accounts). There is no answer key —
 * nothing to stage, seal, or leak. Returns the rendered Bank (prompts anyone
 * can regenerate; `answer`/`answerHash` fields are derived locally only).
 */
export async function gen(benchmarkId: number, chunkCount: number, feeLamports: bigint, ctx = setup()) {
  const { program, wallet } = ctx;
  const { benchmark, chunk, items } = pdas(ctx, wallet.publicKey, benchmarkId);
  const acct = program.account as any;

  let b: any = await fetchOrNull(acct.benchmark.fetch(benchmark));
  if (!b) {
    console.log(`create_benchmark id=${benchmarkId} chunks=${chunkCount} kind=generated`);
    await program.methods
      .createBenchmark(benchmarkId, `sealed-gen-v${benchmarkId}`, chunkCount, Array.from(new Uint8Array(32)), new anchor.BN(feeLamports.toString()), 1)
      .accounts({ authority: wallet.publicKey })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    b = await acct.benchmark.fetch(benchmark);
  } else if (b.kind !== 1) {
    throw new Error(`benchmark ${benchmark.toBase58()} exists as an authored bank; bump the id`);
  }
  console.log(`benchmark ${benchmark.toBase58()} status=${b.status} sealed=${b.chunksSealed}/${b.chunkCount}`);

  const PARTS = CHUNK / PART;
  const ALL = (1 << PARTS) - 1;
  for (let i = 0; i < b.chunkCount; i++) {
    const c = chunk(i);
    const it = items(i);
    let state: any = await fetchOrNull(acct.answerChunk.fetch(c));
    if (state?.partsSealed === ALL) {
      console.log(`chunk ${i}: already minted`);
      continue;
    }
    if (!state) {
      await program.methods.initChunk(i).accounts({ authority: wallet.publicKey, benchmark }).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      state = await acct.answerChunk.fetch(c);
    }
    if (!(await fetchOrNull(acct.itemChunk.fetch(it)))) {
      await program.methods.initItems(i).accounts({ authority: wallet.publicKey, benchmark, items: it }).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }
    for (let p = 0; p < PARTS; p++) {
      if (state.partsSealed & (1 << p)) continue;
      if (state.sealingPart !== p) {
        const offset = new anchor.BN(randomBytes(8), "hex");
        await program.methods
          .genPart(offset, i, p)
          .accountsPartial({ payer: wallet.publicKey, benchmark, chunk: c, items: it, ...arciumAccounts(ctx, offset, "gen_part") })
          .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      }
      process.stdout.write(`chunk ${i} part ${p}: minting in MPC...`);
      state = await waitFor(acct.answerChunk, c, (s) => (s.partsSealed & (1 << p)) !== 0);
      console.log(state.partsSealed & (1 << p) ? " minted" : " STILL PENDING");
    }
  }
  b = await acct.benchmark.fetch(benchmark);
  console.log(`benchmark ${benchmark.toBase58()} status=${b.status === 1 ? "LIVE" : b.status} minted=${b.chunksSealed}/${b.chunkCount}`);

  const bank = await fetchGenBank(benchmark, b.chunkCount, ctx);
  console.log(`items_root ${bank.itemsRoot} (${bank.items.length} minted items, answers never existed in plaintext)`);
  return { benchmark, bank };
}

/** Fetch all ItemChunk accounts for a generated bank and render the Bank file. */
export async function fetchGenBank(benchmark: PublicKey, chunkCount: number, ctx = setup()): Promise<Bank> {
  const { program } = ctx;
  const acct = program.account as any;
  const b: any = await acct.benchmark.fetch(benchmark);
  if (b.kind !== 1) throw new Error(`benchmark ${benchmark.toBase58()} is not a generated bank`);
  const pd = pdas(ctx, b.authority, b.id);
  const chunks: ItemChunkState[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const info = await ctx.provider.connection.getAccountInfo(pd.items(i));
    if (!info) throw new Error(`ItemChunk ${i} missing — bank not fully minted`);
    chunks.push(decodeItemChunk(Buffer.from(info.data)));
  }
  const bank = bankFromChunks(b.id, chunks);
  const onchain = Buffer.from(b.itemsRoot).toString("hex");
  if (b.status === 1 && bank.itemsRoot !== onchain) {
    throw new Error(`items_root mismatch: local fold ${bank.itemsRoot} != on-chain ${onchain}`);
  }
  return bank;
}

// ------------------------------------------------- private generated banks

/**
 * The authority's x25519 key material, derived from their Solana keypair —
 * no extra key management: whoever holds the authority wallet can decrypt the
 * private bank, and only them.
 */
function viewerKeys(ctx: Ctx) {
  const seed = ctx.wallet.secretKey.subarray(0, 32);
  const priv = ed25519.utils.toMontgomerySecret(seed);
  const pub = ed25519.utils.toMontgomery(ctx.wallet.publicKey.toBytes());
  return { priv, pub };
}

/**
 * Mint a PRIVATE generated bank: `gen_part_private` draws item specs from MPC
 * randomness and returns them `Enc<Shared, Pack<GenPart>>` to the authority's
 * x25519 key. On-chain `PrivItemChunk` accounts hold ciphertext only — a public
 * RPC reader sees encrypted bytes. The items_root fold commits to
 * (cts || nonce), so anyone can verify the mint transcript but only the
 * authority can render the prompts.
 */
export async function genPrivate(benchmarkId: number, chunkCount: number, feeLamports: bigint, ctx = setup()) {
  const { program, provider, wallet } = ctx;
  const { benchmark, chunk, pitems } = pdas(ctx, wallet.publicKey, benchmarkId);
  const acct = program.account as any;

  let b: any = await fetchOrNull(acct.benchmark.fetch(benchmark));
  if (!b) {
    console.log(`create_benchmark id=${benchmarkId} chunks=${chunkCount} kind=private-generated`);
    await program.methods
      .createBenchmark(benchmarkId, `sealed-pgen-v${benchmarkId}`, chunkCount, Array.from(new Uint8Array(32)), new anchor.BN(feeLamports.toString()), 2)
      .accounts({ authority: wallet.publicKey })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    b = await acct.benchmark.fetch(benchmark);
  } else if (b.kind !== 2) {
    throw new Error(`benchmark ${benchmark.toBase58()} exists with kind=${b.kind}; bump the id`);
  }
  console.log(`benchmark ${benchmark.toBase58()} status=${b.status} minted=${b.chunksSealed}/${b.chunkCount}`);

  if (!(await getMXEPublicKey(provider, program.programId))) throw new Error("MXE public key unavailable");
  const viewer = viewerKeys(ctx);

  const PARTS = CHUNK / PART;
  const ALL = (1 << PARTS) - 1;
  for (let i = 0; i < b.chunkCount; i++) {
    const c = chunk(i);
    const it = pitems(i);
    let state: any = await fetchOrNull(acct.answerChunk.fetch(c));
    if (state?.partsSealed === ALL) {
      console.log(`chunk ${i}: already minted`);
      continue;
    }
    if (!state) {
      await program.methods.initChunk(i).accounts({ authority: wallet.publicKey, benchmark }).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      state = await acct.answerChunk.fetch(c);
    }
    if (!(await fetchOrNull(acct.privItemChunk.fetch(it)))) {
      await program.methods.initItemsPrivate(i).accounts({ authority: wallet.publicKey, benchmark, items: it }).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }
    for (let p = 0; p < PARTS; p++) {
      if (state.partsSealed & (1 << p)) continue;
      if (state.sealingPart !== p) {
        const offset = new anchor.BN(randomBytes(8), "hex");
        await program.methods
          .genPartPrivate(offset, i, p, Array.from(viewer.pub))
          .accountsPartial({ payer: wallet.publicKey, benchmark, chunk: c, items: it, ...arciumAccounts(ctx, offset, "gen_part_private") })
          .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      }
      process.stdout.write(`chunk ${i} part ${p}: minting privately in MPC...`);
      state = await waitFor(acct.answerChunk, c, (s) => (s.partsSealed & (1 << p)) !== 0);
      console.log(state.partsSealed & (1 << p) ? " minted" : " STILL PENDING");
    }
  }
  b = await acct.benchmark.fetch(benchmark);
  console.log(`benchmark ${benchmark.toBase58()} status=${b.status === 1 ? "LIVE" : b.status} minted=${b.chunksSealed}/${b.chunkCount}`);

  const bank = await fetchPrivBank(benchmark, b.chunkCount, ctx);
  console.log(`items_root ${bank.itemsRoot} (${bank.items.length} private items — ciphertext-only on chain)`);
  return { benchmark, bank };
}

/**
 * Fetch a private bank's PrivItemChunks, verify the ciphertext transcript
 * against the on-chain items_root, then decrypt specs with the authority's
 * wallet-derived x25519 key and render the Bank.
 */
export async function fetchPrivBank(benchmark: PublicKey, chunkCount: number, ctx = setup()): Promise<Bank> {
  const { program, provider } = ctx;
  const acct = program.account as any;
  const b: any = await acct.benchmark.fetch(benchmark);
  if (b.kind !== 2) throw new Error(`benchmark ${benchmark.toBase58()} is not a private generated bank`);
  const pd = pdas(ctx, b.authority, b.id);

  const chunks: PrivItemChunkState[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const info = await provider.connection.getAccountInfo(pd.pitems(i));
    if (!info) throw new Error(`PrivItemChunk ${i} missing — bank not fully minted`);
    chunks.push(decodePrivItemChunk(Buffer.from(info.data)));
  }
  const root = privItemsRoot(chunks);
  const onchain = Buffer.from(b.itemsRoot).toString("hex");
  if (b.status === 1 && root !== onchain) {
    throw new Error(`items_root mismatch: ciphertext fold ${root} != on-chain ${onchain}`);
  }

  const mxePublicKey = await getMXEPublicKey(provider, program.programId);
  if (!mxePublicKey) throw new Error("MXE public key unavailable");
  const viewer = viewerKeys(ctx);
  const cipher = new RescueCipher(x25519.getSharedSecret(viewer.priv, mxePublicKey));

  const parts: ItemSpec[][][] = chunks.map((c) =>
    c.nonces.map((nonce, part) => {
      const ct = c.ciphertexts.slice(part * 2, part * 2 + 2).map((x) => Array.from(x));
      const nb = new Uint8Array(16);
      let n = nonce;
      for (let k = 0; k < 16; k++) { nb[k] = Number(n & 0xffn); n >>= 8n; }
      return unpackSpecs(cipher.decrypt(ct, nb));
    }),
  );
  return privBankFromSpecs(b.id, chunkCount, parts, root);
}

// ------------------------------------------------------------------ reshare

/**
 * Re-encrypt one private-bank part to a delegate's key. `delegate` is the
 * delegate's *Solana* pubkey — converted to x25519 the same way the authority's
 * viewer key is. The MPC cluster decrypts the stored specs inside the enclave
 * and re-encrypts to the delegate; the ShareGrant PDA records the ciphertext.
 * The answers never move — only the questions.
 */
export async function resharePart(
  benchmarkPk: PublicKey,
  chunkIndex: number,
  part: number,
  delegate: PublicKey,
  ctx = setup(),
) {
  const { program, provider, wallet } = ctx;
  const acct = program.account as any;
  const b: any = await acct.benchmark.fetch(benchmarkPk);
  if (b.kind !== 2) throw new Error(`benchmark ${benchmarkPk.toBase58()} is not a private generated bank`);
  const pd = pdas(ctx, b.authority, b.id);
  const viewer = ed25519.utils.toMontgomery(delegate.toBytes());
  const g = pd.grant(chunkIndex, part, viewer);

  const offset = new anchor.BN(randomBytes(8), "hex");
  console.log(`reshare_part chunk=${chunkIndex} part=${part} → ${delegate.toBase58()} (grant ${g.toBase58()})`);
  await program.methods
    .resharePart(offset, chunkIndex, part, Array.from(viewer))
    .accountsPartial({
      payer: wallet.publicKey,
      benchmark: benchmarkPk,
      items: pd.pitems(chunkIndex),
      grant: g,
      ...arciumAccounts(ctx, offset, "reshare_part"),
    })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

  process.stdout.write("waiting for MPC re-encryption...");
  const grant = await waitFor(acct.shareGrant, g, (s) => !s.sharedAt.isZero());
  console.log(grant.sharedAt.isZero() ? " STILL PENDING" : ` shared at ${grant.sharedAt}`);
  return { grant: g, viewer };
}

/** Fetch + decrypt a ShareGrant for the local wallet (the delegate's). */
export async function fetchGrant(benchmarkPk: PublicKey, chunkIndex: number, part: number, ctx = setup()) {
  const { program, provider } = ctx;
  const acct = program.account as any;
  const b: any = await acct.benchmark.fetch(benchmarkPk);
  const viewer = viewerKeys(ctx);
  const pd = pdas(ctx, b.authority, b.id);
  const g = pd.grant(chunkIndex, part, viewer.pub);
  const grant: any = await fetchOrNull(acct.shareGrant.fetch(g));
  if (!grant) throw new Error(`no ShareGrant for this wallet at ${g.toBase58()}`);

  const mxePublicKey = await getMXEPublicKey(provider, program.programId);
  if (!mxePublicKey) throw new Error("MXE public key unavailable");
  const cipher = new RescueCipher(x25519.getSharedSecret(viewer.priv, mxePublicKey));
  const nb = new Uint8Array(16);
  let n = BigInt(grant.nonce.toString());
  for (let k = 0; k < 16; k++) { nb[k] = Number(n & 0xffn); n >>= 8n; }
  const specs = unpackSpecs(cipher.decrypt(grant.ciphertexts.map((x: number[]) => Array.from(x)), nb));
  return { grant: g, specs, sharedAt: grant.sharedAt };
}

/**
 * Assemble a full private bank from the ShareGrants addressed to the local
 * wallet — the "delegated runner" path. Every chunk's every part must have a
 * grant for this wallet; the result is the same Bank the authority renders,
 * reconstructed entirely from per-part grants. The runner can then `sealed run`
 * a model against questions nobody else can see, and score through the normal
 * MPC pipeline — the answers still never appear in plaintext anywhere.
 */
export async function delegateBank(benchmarkPk: PublicKey, ctx = setup()): Promise<Bank> {
  const { program, provider } = ctx;
  const acct = program.account as any;
  const b: any = await acct.benchmark.fetch(benchmarkPk);
  if (b.kind !== 2) throw new Error(`benchmark ${benchmarkPk.toBase58()} is not a private generated bank`);
  const viewer = viewerKeys(ctx);
  const pd = pdas(ctx, b.authority, b.id);
  const mxePublicKey = await getMXEPublicKey(provider, program.programId);
  if (!mxePublicKey) throw new Error("MXE public key unavailable");
  const cipher = new RescueCipher(x25519.getSharedSecret(viewer.priv, mxePublicKey));

  const chunks = await Promise.all(
    Array.from({ length: b.chunkCount }, (_, i) => provider.connection.getAccountInfo(pd.pitems(i))),
  );
  const decoded = chunks.map((info, i) => {
    if (!info) throw new Error(`PrivItemChunk ${i} missing`);
    return decodePrivItemChunk(Buffer.from(info.data));
  });
  const root = privItemsRoot(decoded);
  const onchain = Buffer.from(b.itemsRoot).toString("hex");
  if (b.status === 1 && root !== onchain) {
    throw new Error(`items_root mismatch: ciphertext fold ${root} != on-chain ${onchain}`);
  }

  const parts: ItemSpec[][][] = [];
  for (let i = 0; i < b.chunkCount; i++) {
    const chunkParts: ItemSpec[][] = [];
    for (let p = 0; p < CHUNK / PART; p++) {
      const g = pd.grant(i, p, viewer.pub);
      const grant: any = await fetchOrNull(acct.shareGrant.fetch(g));
      if (!grant) throw new Error(`no ShareGrant for this wallet at chunk ${i} part ${p} — authority must reshare it first`);
      const nb = new Uint8Array(16);
      let n = BigInt(grant.nonce.toString());
      for (let k = 0; k < 16; k++) { nb[k] = Number(n & 0xffn); n >>= 8n; }
      chunkParts.push(unpackSpecs(cipher.decrypt(grant.ciphertexts.map((x: number[]) => Array.from(x)), nb)));
    }
    parts.push(chunkParts);
  }
  return privBankFromSpecs(b.id, b.chunkCount, parts, root);
}

/** List every ShareGrant for a private benchmark (explorer: who can see what). */
export async function listGrants(benchmarkPk: PublicKey, ctx = setup()) {
  const { program } = ctx;
  const acct = program.account as any;
  const all: any[] = await acct.shareGrant.all([
    { memcmp: { offset: 8, bytes: benchmarkPk.toBase58() } },
  ]);
  return all.map((a) => ({
    address: a.publicKey as PublicKey,
    chunkIndex: a.account.chunkIndex as number,
    part: a.account.part as number,
    viewer: Buffer.from(a.account.viewer).toString("hex"),
    sharedAt: a.account.sharedAt,
  }));
}

// ------------------------------------------------------------------ score

export async function score(
  bank: Bank,
  run: RunArtifact,
  authority: PublicKey,
  createOnly = false,
  runIndexOverride?: bigint,
  ctx = setup(),
  insecureAllowUnbound = false,
) {
  const { program, provider, wallet } = ctx;
  if (run.benchmarkId !== bank.benchmarkId) throw new Error("run/bank benchmark id mismatch");
  const { benchmark, chunk, run: runPda } = pdas(ctx, authority, bank.benchmarkId);
  const acct = program.account as any;
  const b = await acct.benchmark.fetch(benchmark);
  if (b.status !== 1) throw new Error(`benchmark not live (status ${b.status})`);
  // The artifact must bind to THIS bank revision: a bank file rewritten
  // (re-minted, re-fetched) after the run started silently scores stale
  // outputs — MPC will tally honestly but against the wrong sealed key.
  const onchainRoot = Buffer.from(b.itemsRoot).toString("hex");
  if (bank.itemsRoot !== onchainRoot)
    throw new Error(`bank file items_root ${bank.itemsRoot} != on-chain ${onchainRoot} — stale bank file`);
  if (run.itemsRoot !== onchainRoot) {
    // Deliberate escape hatch (scripts/score-artifact-insecure.mts): proves
    // the items_root check is a UX guard — MPC remains the security boundary
    // and scores the mismatched outputs honestly anyway.
    if (!insecureAllowUnbound)
      throw new Error(
        run.itemsRoot
          ? `run artifact answered items_root ${run.itemsRoot} but the on-chain bank is ${onchainRoot} — ` +
              `the bank changed after this run; re-run the model against the current bank`
          : "run artifact has no items_root — it predates bank-revision binding, so there is no " +
              "way to verify it answered THIS bank. Re-run the model against the current bank file.",
      );
    console.log("WARNING: scoring an unbound/stale artifact — MPC will tally it honestly, likely low");
  }
  // Authored banks: re-derive the leaf fold — itemsRoot is a claimed string
  // in a mutable file, so verify it actually commits to these items.
  // Generated banks can't refold from rendered items (raw spec bytes aren't
  // stored); the on-chain compare above is the check there.
  if (!bank.kind || bank.kind === "authored") {
    const refolded = hex(
      merkleRoot(bank.items.map((it) => itemLeaf(bank.benchmarkId, it.index, Buffer.from(it.salt, "hex"), it.prompt))),
    );
    if (refolded !== bank.itemsRoot)
      throw new Error(`bank file items_root doesn't re-fold to ${bank.itemsRoot} — file corrupted or edited`);
  }

  const runIndex = runIndexOverride ?? BigInt(b.runCount.toString());
  const r = runPda(runIndex);
  let state: any = await fetchOrNull(acct.run.fetch(r));
  if (!state) {
    if (runIndexOverride !== undefined) throw new Error(`run #${runIndex} does not exist`);
    console.log(`create_run #${runIndex} model=${run.model} fee=${Number(b.feeLamports) / LAMPORTS_PER_SOL} SOL`);
    await program.methods
      .createRun(run.model, Array.from(Buffer.from(run.harnessHash, "hex")), Array.from(Buffer.from(run.outputsRoot, "hex")))
      .accountsPartial({ runner: wallet.publicKey, authority, benchmark, run: r })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    state = await acct.run.fetch(r);
  } else {
    if (run.model !== state.modelId) throw new Error(`run #${runIndex} already exists for model ${state.modelId}`);
    // Resuming with the wrong artifact would fail at OutputsRootMismatch
    // on-chain — catch it here with a legible error.
    const committed = Buffer.from(state.outputsRoot).toString("hex");
    if (run.outputsRoot !== committed)
      throw new Error(`run #${runIndex} committed outputs_root ${committed} — this artifact's ${run.outputsRoot} cannot score it`);
    console.log(`run #${runIndex} exists (scored_mask=${state.scoredMask}); resuming`);
  }
  if (createOnly) {
    console.log(`run ${r.toBase58()} created (pending, unscored)`);
    return r;
  }

  if (run.items.length !== bank.chunkCount * CHUNK)
    throw new Error(`run artifact has ${run.items.length} outputs; benchmark expects ${bank.chunkCount * CHUNK}`);
  const outLeaves = chunkOutLeaves(run.items.map((r) => BigInt(r.outputHash)));
  // Fail fast on a tampered artifact: if the items were edited after
  // outputsRoot was committed, every score_chunk reverts OutputsRootMismatch
  // — catch it locally before paying for create_run + queues.
  const foldedRoot = Buffer.from(merkleRoot(outLeaves)).toString("hex");
  if (run.outputsRoot && foldedRoot !== run.outputsRoot)
    throw new Error(`run artifact items do not fold to its committed outputsRoot (${foldedRoot.slice(0, 16)}… != ${run.outputsRoot.slice(0, 16)}…) — artifact is corrupt or tampered`);
  // Queue every un-scored chunk UP FRONT. A queued computation executes
  // regardless of later bit sweeps, so once `ever_queued_mask` is full any
  // further stall is the cluster's fault — markets can then settle the honest
  // partial on expiry instead of refunding a runner-chosen truncation point.
  {
    const snap: any = await acct.run.fetch(r);
    const masks = BigInt(snap.scoredMask.toString()) | BigInt(snap.pendingMask.toString());
    for (let i = 0; i < bank.chunkCount; i++) {
      if (masks & (1n << BigInt(i))) continue;
      const outputs = runChunkOutputs(run, i).map((h) => new anchor.BN(h.toString()));
      const proof = merkleProof(outLeaves, i).map((p) => Array.from(p));
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(runIndex.toString()), i, outputs, proof)
        .accountsPartial({ payer: wallet.publicKey, run: r, runner: wallet.publicKey, chunk: chunk(i), ...arciumAccounts(ctx, offset, "score_chunk") })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      console.log(`chunk ${i}: queued in MPC`);
    }
  }
  for (let i = 0; i < bank.chunkCount; i++) {
    const bit = 1n << BigInt(i);
    state = await acct.run.fetch(r);
    if (BigInt(state.scoredMask.toString()) & bit) {
      console.log(`chunk ${i}: scored (total ${state.correct})`);
      continue;
    }
    process.stdout.write(`chunk ${i}: scoring in MPC...`);
    state = await waitFor(acct.run, r, (s) => (BigInt(s.scoredMask.toString()) & bit) !== 0n);
    console.log(` scored (total ${state.correct})`);
  }
  const final = await acct.run.fetch(r);
  const items = bank.chunkCount * CHUNK;
  console.log(
    `run ${r.toBase58()} ${final.status === 1 ? "FINALIZED" : "pending"}: ${final.correct}/${items} = ${((100 * Number(final.correct)) / items).toFixed(1)}%` +
      (final.attested ? "  [attested ✓]" : "") +
      (run.localCorrect !== Number(final.correct) ? `  (local pre-score ${run.localCorrect} DIFFERS)` : "  (matches local pre-score)"),
  );
  return r;
}

// ------------------------------------------------------------------ reveal / audit

/**
 * Declassify one part's answer fingerprints (authority-only). MPC decrypts the
 * part inside the enclave and the callback writes the eight hash commitments to
 * a `Reveal` PDA — fingerprints, never plaintext answers. Returns the account.
 */
export async function revealPart(benchmarkPk: PublicKey, chunkIndex: number, part: number, ctx = setup()) {
  const { program, wallet } = ctx;
  const acct = program.account as any;
  const b: any = await acct.benchmark.fetch(benchmarkPk);
  const { chunk, reveal } = pdas(ctx, b.authority, b.id);
  const rv = reveal(chunkIndex, part);
  let state: any = await fetchOrNull(acct.reveal.fetch(rv));
  if (state) {
    console.log(`reveal ${rv.toBase58()} already exists`);
    return state;
  }
  const offset = new anchor.BN(randomBytes(8), "hex");
  await program.methods
    .revealPart(offset, chunkIndex, part)
    .accountsPartial({
      payer: wallet.publicKey,
      benchmark: benchmarkPk,
      chunk: chunk(chunkIndex),
      reveal: rv,
      ...arciumAccounts(ctx, offset, "reveal_part"),
    })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  process.stdout.write(`chunk ${chunkIndex} part ${part}: declassifying in MPC...`);
  state = await waitFor(acct.reveal, rv, (s) => Number(s.revealedAt) !== 0);
  console.log(state && Number(state.revealedAt) !== 0 ? " revealed" : " STILL PENDING");
  return state;
}

/**
 * Spot-check audit: compare every declassified answer fingerprint against the
 * run's committed output hashes. Anyone holding the run artifact can recompute
 * what `score_chunk` must have seen on the revealed positions.
 */
export async function verifyRun(benchmarkPk: PublicKey, run: RunArtifact, runIndex?: bigint, ctx?: Ctx, snapPath?: string) {
  let b: any, reveals: SnapAccount[], ss: ReturnType<typeof decodeSnapshotSection> | null = null;
  if (snapPath) {
    ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
    b = snapOf(ss, "Benchmark").find((x) => x.publicKey.equals(benchmarkPk))?.account;
    if (!b) { console.log(`no benchmark ${benchmarkPk.toBase58()} in snapshot`); return; }
    reveals = snapOf(ss, "Reveal").filter((x) => (x.account.benchmark as PublicKey).equals(benchmarkPk));
  } else {
    ctx ??= setup();
    const acct = ctx.program.account as any;
    b = await acct.benchmark.fetch(benchmarkPk);
    reveals = await acct.reveal.all([{ memcmp: { offset: 8, bytes: benchmarkPk.toBase58() } }]);
  }
  if (reveals.length === 0) {
    console.log(`no revealed parts for ${benchmarkPk.toBase58()} — ask the authority to 'chain reveal' first`);
    return;
  }
  // If the run is on-chain, prove the artifact's outputs are the committed ones.
  if (runIndex !== undefined) {
    const [runPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("run"), benchmarkPk.toBuffer(), u64le(runIndex)], sealedProgramId());
    const r: any = ss
      ? snapOf(ss, "Run").find((x) => x.publicKey.equals(runPda))?.account
      : await fetchOrNull((ctx!.program.account as any).run.fetch(runPda));
    if (r && Buffer.from(r.outputsRoot).toString("hex") !== run.outputsRoot) {
      throw new Error(`outputs_root mismatch: run artifact is not the committed run #${runIndex}`);
    }
    if (r) console.log(`run #${runIndex} outputs_root matches the on-chain commitment`);
  }
  let checked = 0;
  let matched = 0;
  for (const { account } of reveals.sort((x, y) => x.account.chunkIndex - y.account.chunkIndex || x.account.part - y.account.part)) {
    const base = account.chunkIndex * CHUNK + account.part * PART;
    for (let k = 0; k < PART; k++) {
      const pos = base + k;
      const rec = run.items[pos];
      if (!rec) continue;
      const ok = rec.outputHash === account.hashes[k].toString();
      checked++;
      if (ok) matched++;
      console.log(`  item ${pos}: ${ok ? "MATCH" : "miss"}  output=${rec.outputHash} answer=${account.hashes[k].toString()}`);
    }
  }
  console.log(`audit: ${matched}/${checked} revealed positions match the run's committed outputs`);
  return { checked, matched };
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
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`reset_sealing ${sig}`);
}

/**
 * Clear a stuck pending_mask bit on a run. The runner may sweep anytime; anyone
 * may sweep once the bit is stale (PENDING_TIMEOUT_SECS after the last queue).
 */
export async function resetPending(runPk: PublicKey, chunkIndex: number, ctx = setup()) {
  const { program, wallet } = ctx;
  const acct = program.account as any;
  const r: any = await acct.run.fetch(runPk);
  const stale = r.pendingSince.toNumber() !== 0 && Date.now() / 1000 > r.pendingSince.toNumber() + 900;
  console.log(
    `run #${Number(r.index)} chunk ${chunkIndex}: pendingMask bit=${r.pendingMask.testn(chunkIndex) ? 1 : 0}, ` +
      `pendingSince=${r.pendingSince.toNumber()} ${stale ? "(STALE — anyone may sweep)" : "(runner-only until stale)"}`,
  );
  const sig = await program.methods
    .resetPending(new anchor.BN(Number(r.index)), chunkIndex)
    .accounts({ sweeper: wallet.publicKey, run: runPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`reset_pending ${sig}`);
}

// ------------------------------------------------------------------ status

export async function status(benchmark: PublicKey, ctx?: Ctx, snapPath?: string, json = false) {
  let b: any, runs: SnapAccount[];
  if (snapPath) {
    const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
    b = snapOf(ss, "Benchmark").find((x) => x.publicKey.equals(benchmark))?.account;
    if (!b) { console.log(`no benchmark ${benchmark.toBase58()} in snapshot`); return; }
    runs = snapOf(ss, "Run").filter((x) => (x.account.benchmark as PublicKey).equals(benchmark));
  } else {
    ctx ??= setup();
    const acct = ctx.program.account as any;
    b = await acct.benchmark.fetch(benchmark);
    runs = await acct.run.all([{ memcmp: { offset: 8, bytes: benchmark.toBase58() } }]);
  }
  const items = b.chunkCount * CHUNK;
  const rows = runs
    .filter((x: any) => x.account.status === 1)
    .sort((p: any, q: any) => Number(q.account.correct) - Number(p.account.correct));
  if (json) {
    console.log(JSON.stringify({
      benchmark: benchmark.toBase58(), name: b.name, status: b.status,
      items, runCount: Number(b.runCount), itemsRoot: Buffer.from(b.itemsRoot).toString("hex"),
      leaderboard: rows.map((x: any) => ({
        run: x.publicKey.toBase58(), index: Number(x.account.index), model: x.account.modelId,
        correct: Number(x.account.correct), items, pct: 100 * Number(x.account.correct) / items,
        attested: !!x.account.attested, postReveal: !!x.account.postReveal,
      })),
    }));
    return;
  }
  console.log(`benchmark ${benchmark.toBase58()} "${b.name}" status=${b.status} items=${items} runs=${b.runCount} root=${Buffer.from(b.itemsRoot).toString("hex")}`);
  console.log("rank  score      model                                   run");
  rows.forEach((x: any, i: number) => {
    const r = x.account;
    const pct = ((100 * Number(r.correct)) / items).toFixed(1).padStart(5);
    console.log(`${String(i + 1).padStart(4)}  ${pct}%  ${String(Number(r.correct)).padStart(4)}/${items}  ${(r.modelId + (r.attested ? " ✓" : "")).padEnd(38)} #${r.index} ${x.publicKey.toBase58()}`);
  });
}

// ------------------------------------------------------------------ market

/** N-way parimutuel bucket markets that resolve on a finalized Run's `correct`. */
const MARKET_PROGRAM_ID = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const MAX_OUTCOMES = 8;

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

function marketProgram(kpPath?: string) {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const kp = kpPath ? loadKeypair(kpPath) : loadKeypair(process.env.ANCHOR_WALLET ?? join(homedir(), ".config", "solana", "id.json"));
  const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(kp), { preflightCommitment: "processed", commitment: "confirmed" });
  const idl = require(join(ROOT, "target", "idl", "market.json"));
  if (process.env.MARKET_PROGRAM_ID) idl.address = process.env.MARKET_PROGRAM_ID;
  return { market: new anchor.Program(idl, provider), kp };
}

const marketPda = (run: PublicKey, salt = 0n, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("market"), run.toBuffer(), Buffer.from(new anchor.BN(salt.toString()).toArray("le", 8))], pid)[0];
const positionPda = (market: PublicKey, bettor: PublicKey, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), bettor.toBuffer()], pid)[0];
const duelPda = (runA: PublicKey, runB: PublicKey, salt = 0n, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("duel"), runA.toBuffer(), runB.toBuffer(), Buffer.from(new anchor.BN(salt.toString()).toArray("le", 8))], pid)[0];
const isDuel = (m: any) => m.runB && !(m.runB as PublicKey).equals(PublicKey.default);
const DUEL_LABELS = ["A wins", "B wins", "tie"];

/** Human-readable label for outcome i given a market's edges/n_outcomes. */
export function outcomeLabel(nOutcomes: number, edges: number[] | bigint[], i: number): string {
  const lo = i === 0 ? 0 : Number(edges[i - 1]);
  const hi = i === nOutcomes - 1 ? null : Number(edges[i]);
  return hi === null ? `>= ${lo}` : lo === 0 ? `< ${hi}` : `${lo}–${hi - 1}`;
}

interface MarketTiming { feeBps: number; closesAt: bigint; resolveBy: bigint; revealSecs: bigint }

/** `--flag 0` disables; `+3600` = that many seconds from now; else absolute unix ts. */
function deadline(v: string | boolean | undefined): bigint {
  if (v === undefined || v === true || v === "0") return 0n;
  const s = String(v);
  if (s.startsWith("+")) return BigInt(Math.floor(Date.now() / 1000) + Number(s.slice(1)));
  return BigInt(s);
}

function timing(args: Args): MarketTiming {
  const resolveBy = deadline(args["resolve-by"]);
  if (resolveBy === 0n)
    throw new Error("--resolve-by is required (e.g. --resolve-by +86400) — every market needs a refund deadline");
  const revealSecs = args["reveal-secs"] !== undefined ? BigInt(String(args["reveal-secs"])) : BigInt(24 * 3600);
  if (revealSecs < 60n || revealSecs > BigInt(90 * 24 * 3600))
    throw new Error("--reveal-secs must be 60..7776000 — winners need time to reveal (24h recommended)");
  return {
    feeBps: args["fee-bps"] !== undefined ? Number(args["fee-bps"]) : 0,
    closesAt: deadline(args["closes-at"]),
    resolveBy,
    revealSecs,
  };
}

async function marketOpen(run: PublicKey, edges: number[], salt: bigint, t: MarketTiming, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m = marketPda(run, salt, market.programId);
  await (market.methods as any)
    .createMarket(new anchor.BN(salt.toString()), edges, t.feeBps, new anchor.BN(t.closesAt.toString()), new anchor.BN(t.resolveBy.toString()))
    .accounts({ authority: kp.publicKey, run, market: m })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const labels = Array.from({ length: edges.length + 1 }, (_, i) => outcomeLabel(edges.length + 1, edges, i)).join(" | ");
  console.log(`market ${m.toBase58()} opened: run ${run.toBase58()} outcomes: ${labels}${t.feeBps ? ` fee=${t.feeBps}bps` : ""}`);
  return m;
}

async function marketOpenDuel(runA: PublicKey, runB: PublicKey, salt: bigint, t: MarketTiming, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m = duelPda(runA, runB, salt, market.programId);
  await (market.methods as any)
    .createDuel(new anchor.BN(salt.toString()), t.feeBps, new anchor.BN(t.closesAt.toString()), new anchor.BN(t.resolveBy.toString()))
    .accounts({ authority: kp.publicKey, runA, runB, market: m })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`duel market ${m.toBase58()} opened: run ${runA.toBase58()} vs ${runB.toBase58()} — outcomes: A wins | B wins | tie`);
  return m;
}

async function marketBet(marketPk: PublicKey, outcome: number, lamports: bigint, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m: any = await (market.account as any).market.fetch(marketPk);
  const position = positionPda(marketPk, kp.publicKey, market.programId);
  const duel = isDuel(m);
  const label = duel ? DUEL_LABELS[outcome] : outcomeLabel(m.nOutcomes, m.edges, outcome);
  const sig = duel
    ? await (market.methods as any)
        .betDuel(outcome, new anchor.BN(lamports.toString()))
        .accounts({ bettor: kp.publicKey, runA: m.run, runB: m.runB, market: marketPk, position })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" })
    : await (market.methods as any)
        .bet(outcome, new anchor.BN(lamports.toString()))
        .accounts({ bettor: kp.publicKey, run: m.run, market: marketPk, position })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`bet [${label}] ${Number(lamports) / LAMPORTS_PER_SOL} SOL by ${kp.publicKey.toBase58()} (${sig})`);
}

async function marketResolve(marketPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const m: any = await (market.account as any).market.fetch(marketPk);
  const sig = isDuel(m)
    ? await (market.methods as any)
        .resolveDuel()
        .accounts({ runA: m.run, runB: m.runB, market: marketPk })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" })
    : await (market.methods as any)
        .resolve()
        .accounts({ run: m.run, market: marketPk })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after: any = await (market.account as any).market.fetch(marketPk);
  const oc = after.status === 2
    ? "CANCELLED"
    : isDuel(after)
      ? `outcome ${after.outcome} [${DUEL_LABELS[after.outcome]}] a=${after.resolvedScore >> 16} b=${after.resolvedScore & 0xffff}`
      : `outcome ${after.outcome} [${outcomeLabel(after.nOutcomes, after.edges, after.outcome)}]`;
  console.log(`market resolved (${sig}): score=${after.resolvedScore} ${oc}`);
}

async function marketClaim(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const position = positionPda(marketPk, kp.publicKey, market.programId);
  const before = await provider0().getBalance(kp.publicKey);
  const sig = await (market.methods as any)
    .claim()
    .accounts({ bettor: kp.publicKey, market: marketPk, position })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after = await provider0().getBalance(kp.publicKey);
  console.log(`claim (${sig}): ${kp.publicKey.toBase58()} balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
}

/** Authority void — only while every referenced run is still fully unscored. */
async function marketVoid(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m: any = await (market.account as any).market.fetch(marketPk);
  const sig = isDuel(m)
    ? await (market.methods as any)
        .voidDuel()
        .accounts({ authority: kp.publicKey, runA: m.run, runB: m.runB, market: marketPk })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" })
    : await (market.methods as any)
        .voidMarket()
        .accounts({ authority: kp.publicKey, run: m.run, market: marketPk })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`market voided (${sig}): ${marketPk.toBase58()} — all positions refundable via claim`);
}

/** Permissionless expiry once resolve_by has passed: never-queued runs refund;
 *  a run stalled past the 24h cap settles on its proven partial score. */
async function marketExpire(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m = await (market.account as any).market.fetch(marketPk);
  const runB = m.runB.equals(PublicKey.default) ? m.run : m.runB;
  const sig = await (market.methods as any)
    .expireMarket()
    .accounts({ market: marketPk, runA: m.run, runB })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after = await (market.account as any).market.fetch(marketPk);
  const what = after.status === 1
    ? `settled on proven score ${after.resolvedScore.toString()} (outcome ${after.outcome})`
    : "cancelled — all positions refundable via claim";
  console.log(`market expired (${sig}): ${marketPk.toBase58()} — ${what}`);
}

/** Authority collects the fee accrued at resolution. */
async function marketClaimFee(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const before = await provider0().getBalance(kp.publicKey);
  const sig = await (market.methods as any)
    .claimFee()
    .accounts({ authority: kp.publicKey, market: marketPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after = await provider0().getBalance(kp.publicKey);
  console.log(`claim-fee (${sig}): ${kp.publicKey.toBase58()} balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
}

function provider0() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  return new Connection(url, "confirmed");
}

// ------------------------------------------------------------------ ladders

const ladderPda = (firstLeg: PublicKey, salt = 0n, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("ladder"), firstLeg.toBuffer(), Buffer.from(new anchor.BN(salt.toString()).toArray("le", 8))], pid)[0];
const legMeta = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const ladderLegs = (l: any): PublicKey[] => (l.legs as PublicKey[]).slice(0, l.legCount as number);

/** K-way race market: argmax over leg scores, dead-heat split on ties. */
async function ladderOpen(legs: PublicKey[], salt: bigint, t: MarketTiming, kpPath?: string) {
  if (t.closesAt === 0n) throw new Error("--closes-at is required for ladders (e.g. --closes-at +3600)");
  const { market, kp } = marketProgram(kpPath);
  const ctx = setup();
  const l = ladderPda(legs[0], salt, market.programId);
  // Print each leg's runner + model before opening: a leg whose runner never
  // scores forfeits at 0 — bettors must be able to spot dormant-runner legs.
  const legRows = await Promise.all(legs.map(async (x, i) => {
    const r: any = await (ctx.program.account as any).run.fetch(x);
    return `  [${i}] ${x.toBase58()} runner=${(r.runner as PublicKey).toBase58()} model=${r.modelId}`;
  }));
  await (market.methods as any)
    .createLadder(legs[0], new anchor.BN(salt.toString()), t.feeBps, new anchor.BN(t.closesAt.toString()), new anchor.BN(t.resolveBy.toString()))
    .accounts({ authority: kp.publicKey, ladder: l })
    .remainingAccounts(legs.map(legMeta))
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`ladder ${l.toBase58()} opened: ${legs.length}-way race${t.feeBps ? ` fee=${t.feeBps}bps` : ""}`);
  legRows.forEach((r) => console.log(r));
  console.log(`  outcome index = leg order above — a leg whose runner never scores forfeits at 0`);
  return l;
}

async function ladderBet(ladderPk: PublicKey, outcome: number, lamports: bigint, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const l: any = await (market.account as any).ladder.fetch(ladderPk);
  const position = positionPda(ladderPk, kp.publicKey, market.programId);
  const sig = await (market.methods as any)
    .betLadder(outcome, new anchor.BN(lamports.toString()))
    .accounts({ bettor: kp.publicKey, ladder: ladderPk, position })
    .remainingAccounts(ladderLegs(l).map(legMeta))
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`bet leg [${outcome}] ${Number(lamports) / LAMPORTS_PER_SOL} SOL by ${kp.publicKey.toBase58()} (${sig})`);
}

async function ladderResolve(ladderPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const l: any = await (market.account as any).ladder.fetch(ladderPk);
  const sig = await (market.methods as any)
    .resolveLadder()
    .accounts({ ladder: ladderPk })
    .remainingAccounts(ladderLegs(l).map(legMeta))
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after: any = await (market.account as any).ladder.fetch(ladderPk);
  const what = after.status === 2
    ? "CANCELLED (wash — nobody backed a leader, or all legs tied)"
    : `mask=0b${(after.resultMask as number).toString(2)} winning_score=${after.resolvedScore}`;
  console.log(`ladder resolved (${sig}): ${ladderPk.toBase58()} — ${what}`);
}

async function ladderClaim(ladderPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const position = positionPda(ladderPk, kp.publicKey, market.programId);
  const before = await provider0().getBalance(kp.publicKey);
  const sig = await (market.methods as any)
    .claimLadder()
    .accounts({ bettor: kp.publicKey, ladder: ladderPk, position })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after = await provider0().getBalance(kp.publicKey);
  console.log(`claim (${sig}): ${kp.publicKey.toBase58()} balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
}

async function ladderVoid(ladderPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const l: any = await (market.account as any).ladder.fetch(ladderPk);
  const sig = await (market.methods as any)
    .voidLadder()
    .accounts({ authority: kp.publicKey, ladder: ladderPk })
    .remainingAccounts(ladderLegs(l).map(legMeta))
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`ladder voided (${sig}): ${ladderPk.toBase58()} — all positions refundable via claim`);
}

async function ladderClaimFee(ladderPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const before = await provider0().getBalance(kp.publicKey);
  const sig = await (market.methods as any)
    .claimFeeLadder()
    .accounts({ authority: kp.publicKey, ladder: ladderPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after = await provider0().getBalance(kp.publicKey);
  console.log(`claim-fee (${sig}): ${kp.publicKey.toBase58()} balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
}

async function ladderShow(ladderPk: PublicKey) {
  const { market } = marketProgram();
  const ctx = setup();
  const l: any = await (market.account as any).ladder.fetch(ladderPk);
  const status = ["OPEN", "RESOLVED", "CANCELLED"][l.status as number];
  console.log(`ladder ${ladderPk.toBase58()} status=${status} legs=${l.legCount} benchmark=${l.benchmark.toBase58()}`);
  for (let i = 0; i < (l.legCount as number); i++) {
    const win = l.status === 1 && (l.resultMask & (1 << i)) !== 0 ? "  <- WINNER" : "";
    let info = "";
    try {
      const r: any = await (ctx.program.account as any).run.fetch(l.legs[i]);
      info = ` model=${r.modelId} runner=${(r.runner as PublicKey).toBase58().slice(0, 8)}… score=${r.status === 1 ? r.correct : "?"}`;
    } catch { /* leg account unreadable — show the key only */ }
    console.log(`  [${i}] ${(l.legs[i] as PublicKey).toBase58()}${info}: ${Number(l.totals[i]) / LAMPORTS_PER_SOL} SOL${win}`);
  }
  console.log(`  resolved_score=${l.resolvedScore} result_mask=0b${(l.resultMask as number).toString(2)}`);
  const fmt = (v: bigint) => (v === 0n ? "-" : new Date(Number(v) * 1000).toISOString());
  console.log(`  fee_bps=${l.feeBps} fees_accrued=${Number(l.feesAccrued) / LAMPORTS_PER_SOL} SOL closes_at=${fmt(l.closesAt)} resolve_by=${fmt(l.resolveBy)}`);
  const positions = await (market.account as any).position.all([{ memcmp: { offset: 8, bytes: ladderPk.toBase58() } }]);
  for (const { account: p } of positions) {
    const bets = p.amounts.slice(0, l.legCount).map((a: bigint, i: number) => `[${i}]=${Number(a) / LAMPORTS_PER_SOL}`).filter((s: string) => !s.endsWith("=0")).join(" ");
    console.log(`  position ${p.bettor.toBase58()} ${bets}`);
  }
}

async function marketShow(marketPk: PublicKey) {
  const { market } = marketProgram();
  const m: any = await (market.account as any).market.fetch(marketPk);
  const status = ["OPEN", "RESOLVED", "CANCELLED"][m.status as number];
  const duel = isDuel(m);
  console.log(`market ${marketPk.toBase58()} status=${status}${duel ? " (duel)" : ""}`);
  console.log(`  run=${m.run.toBase58()}${duel ? ` vs=${m.runB.toBase58()}` : ""} benchmark=${m.benchmark.toBase58()} run_index=${m.runIndex}`);
  const n = m.nOutcomes as number;
  const lbl = (i: number) => (duel ? DUEL_LABELS[i] : outcomeLabel(n, m.edges, i));
  for (let i = 0; i < n; i++) {
    const win = m.status === 1 && m.outcome === i ? "  <- WINNER" : "";
    console.log(`  [${i}] ${lbl(i)}: ${Number(m.totals[i]) / LAMPORTS_PER_SOL} SOL${win}`);
  }
  const rs = duel ? `${m.resolvedScore >> 16}-${m.resolvedScore & 0xffff}` : `${m.resolvedScore}`;
  console.log(`  resolved_score=${rs} outcome=${m.status === 1 ? m.outcome : "-"}`);
  const fmt = (v: bigint) => (v === 0n ? "-" : new Date(Number(v) * 1000).toISOString());
  console.log(`  fee_bps=${m.feeBps} fees_accrued=${Number(m.feesAccrued) / LAMPORTS_PER_SOL} SOL closes_at=${fmt(m.closesAt)} resolve_by=${fmt(m.resolveBy)}`);
  const positions = await (market.account as any).position.all([{ memcmp: { offset: 8, bytes: marketPk.toBase58() } }]);
  for (const { account: p } of positions) {
    const bets = p.amounts.slice(0, n).map((a: bigint, i: number) => `${lbl(i)}=${Number(a) / LAMPORTS_PER_SOL}`).filter((s: string) => !s.endsWith("=0")).join(" ");
    console.log(`  position ${p.bettor.toBase58()} ${bets}`);
  }
}

// ------------------------------------------------------------------ dark markets

const darkPda = (run: PublicKey, salt = 0n, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("dark"), run.toBuffer(), Buffer.from(new anchor.BN(salt.toString()).toArray("le", 8))], pid)[0];
const darkPosPda = (market: PublicKey, bettor: PublicKey, posSalt = 0n, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("darkpos"), market.toBuffer(), bettor.toBuffer(), Buffer.from(new anchor.BN(posSalt.toString()).toArray("le", 8))], pid)[0];

/** SHA256(b"sealed/dark" ‖ market ‖ bettor ‖ outcome u8 ‖ amount u64le ‖ salt[32])
 * — the exact preimage the on-chain `dark_commitment` recomputes at reveal. */
export function darkCommitment(market: PublicKey, bettor: PublicKey, outcome: number, amount: bigint, salt: Buffer): Buffer {
  const amt = Buffer.alloc(8);
  amt.writeBigUInt64LE(amount);
  return createHash("sha256")
    .update(Buffer.from("sealed/dark"))
    .update(market.toBuffer())
    .update(bettor.toBuffer())
    .update(Buffer.from([outcome]))
    .update(amt)
    .update(salt)
    .digest();
}

/** Open a dark score market — same buckets/deadlines as `market open`. */
async function darkOpen(run: PublicKey, edges: number[], salt: bigint, t: MarketTiming, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m = darkPda(run, salt, market.programId);
  await (market.methods as any)
    .createDark(new anchor.BN(salt.toString()), edges, t.feeBps, new anchor.BN(t.closesAt.toString()), new anchor.BN(t.resolveBy.toString()), new anchor.BN(t.revealSecs.toString()))
    .accounts({ authority: kp.publicKey, run, darkMarket: m })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const labels = Array.from({ length: edges.length + 1 }, (_, i) => outcomeLabel(edges.length + 1, edges, i)).join(" | ");
  console.log(`dark market ${m.toBase58()} opened: run ${run.toBase58()} outcomes: ${labels} — positions are sealed`);
  return m;
}

/** Stake a sealed position: outcome never hits the wire — only the commitment.
 *  Prints the preimage; keep it — revealing without it is impossible. */
async function darkBet(marketPk: PublicKey, outcome: number, lamports: bigint, posSalt: bigint, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m: any = await (market.account as any).darkMarket.fetch(marketPk);
  const salt = randomBytes(32);
  const commitment = darkCommitment(marketPk, kp.publicKey, outcome, lamports, salt);
  const position = darkPosPda(marketPk, kp.publicKey, posSalt, market.programId);
  const sig = await (market.methods as any)
    .darkBet(new anchor.BN(posSalt.toString()), Array.from(commitment), new anchor.BN(lamports.toString()))
    .accounts({ bettor: kp.publicKey, run: m.run, darkMarket: marketPk, position })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const label = outcomeLabel(m.nOutcomes, m.edges, outcome);
  console.log(`sealed bet ${Number(lamports) / LAMPORTS_PER_SOL} SOL by ${kp.publicKey.toBase58()} (${sig})`);
  console.log(`  position ${position.toBase58()} — the chain sees only commitment ${commitment.toString("hex").slice(0, 16)}…`);
  console.log(`  KEEP THIS PREIMAGE — needed to reveal: --pos-salt ${posSalt} --outcome ${outcome} --salt ${salt.toString("hex")}`);
  console.log(`  (your hidden side: [${label}] — nobody else can see it until you reveal)`);
}

async function darkResolve(marketPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const m: any = await (market.account as any).darkMarket.fetch(marketPk);
  const sig = await (market.methods as any)
    .resolveDark()
    .accounts({ run: m.run, darkMarket: marketPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after: any = await (market.account as any).darkMarket.fetch(marketPk);
  const oc = after.status === 2
    ? "CANCELLED"
    : `outcome ${after.outcome} [${outcomeLabel(after.nOutcomes, after.edges, after.outcome)}] — reveal window open until ${new Date(Number(after.revealUntil) * 1000).toISOString()}`;
  console.log(`dark market resolved (${sig}): score=${after.resolvedScore} ${oc}`);
}

async function darkReveal(marketPk: PublicKey, posSalt: bigint, outcome: number, saltHex: string, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const position = darkPosPda(marketPk, kp.publicKey, posSalt, market.programId);
  const sig = await (market.methods as any)
    .revealDark(new anchor.BN(posSalt.toString()), outcome, Array.from(Buffer.from(saltHex, "hex")))
    .accounts({ bettor: kp.publicKey, market: marketPk, position })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const m: any = await (market.account as any).darkMarket.fetch(marketPk);
  const win = m.outcome === outcome ? "WINNER — stake counted in win_total" : "losing side — position recorded";
  console.log(`revealed (${sig}): outcome ${outcome} — ${win}`);
}

async function darkFinalize(marketPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const sig = await (market.methods as any)
    .finalizeDark()
    .accounts({ darkMarket: marketPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const m: any = await (market.account as any).darkMarket.fetch(marketPk);
  const what = m.status === 2 ? "CANCELLED — nobody revealed; positions refund via claim" : `tallied: win_total=${Number(m.winTotal) / LAMPORTS_PER_SOL} SOL of pool=${Number(m.poolTotal) / LAMPORTS_PER_SOL}`;
  console.log(`dark market finalized (${sig}): ${what}`);
}

async function darkClaim(marketPk: PublicKey, posSalt: bigint, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const position = darkPosPda(marketPk, kp.publicKey, posSalt, market.programId);
  const before = await provider0().getBalance(kp.publicKey);
  const sig = await (market.methods as any)
    .claimDark(new anchor.BN(posSalt.toString()))
    .accounts({ bettor: kp.publicKey, market: marketPk, position })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after = await provider0().getBalance(kp.publicKey);
  console.log(`claim (${sig}): ${kp.publicKey.toBase58()} balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
}

/** Authority voids an open market (all positions refundable via claim). */
async function darkVoid(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m: any = await (market.account as any).darkMarket.fetch(marketPk);
  const sig = await (market.methods as any)
    .voidDark()
    .accounts({ authority: kp.publicKey, run: m.run, darkMarket: marketPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`dark market ${marketPk.toBase58()} voided (${sig}) — positions refund via claim`);
}

/** Permissionless expiry past resolve_by — settles on any landed score or cancels. */
async function darkExpire(marketPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const m: any = await (market.account as any).darkMarket.fetch(marketPk);
  const sig = await (market.methods as any)
    .expireDark()
    .accounts({ runA: m.run, darkMarket: marketPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const after: any = await (market.account as any).darkMarket.fetch(marketPk);
  const status = ["OPEN", "RESOLVED", "CANCELLED"][after.status as number];
  console.log(`dark market expired (${sig}): status=${status} score=${after.resolvedScore}`);
}

/** Authority sweeps accrued dark-market fees after tally. */
async function darkClaimFee(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const sig = await (market.methods as any)
    .claimFeeDark()
    .accounts({ authority: kp.publicKey, darkMarket: marketPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`dark market fees claimed (${sig})`);
}

async function darkShow(marketPk: PublicKey) {
  const { market } = marketProgram();
  const m: any = await (market.account as any).darkMarket.fetch(marketPk);
  const status = ["OPEN", "RESOLVED", "CANCELLED"][m.status as number];
  const n = m.nOutcomes as number;
  console.log(`dark market ${marketPk.toBase58()} status=${status}${m.tallied ? " tallied" : ""}`);
  console.log(`  run=${m.run.toBase58()} benchmark=${m.benchmark.toBase58()} run_index=${m.runIndex}`);
  console.log(`  outcomes: ${Array.from({ length: n }, (_, i) => `[${i}] ${outcomeLabel(n, m.edges, i)}`).join(" | ")}`);
  console.log(`  pool=${Number(m.poolTotal) / LAMPORTS_PER_SOL} SOL win_total=${Number(m.winTotal) / LAMPORTS_PER_SOL} revealed=${m.revealedCount} positions`);
  const rs = m.status === 1 ? `score=${m.resolvedScore} outcome=${m.outcome} [${outcomeLabel(n, m.edges, m.outcome)}]` : "unresolved";
  console.log(`  ${rs}`);
  const fmt = (v: bigint) => (v === 0n ? "-" : new Date(Number(v) * 1000).toISOString());
  console.log(`  fee_bps=${m.feeBps} fees_accrued=${Number(m.feesAccrued) / LAMPORTS_PER_SOL} SOL closes_at=${fmt(m.closesAt)} resolve_by=${fmt(m.resolveBy)} reveal_until=${fmt(m.revealUntil)}`);
  const positions = await (market.account as any).darkPosition.all([{ memcmp: { offset: 8, bytes: marketPk.toBase58() } }]);
  for (const { account: p } of positions) {
    const side = p.revealed === 255 ? "sealed" : `outcome ${p.revealed} [${outcomeLabel(n, m.edges, p.revealed)}]`;
    console.log(`  position ${p.bettor.toBase58()} ${Number(p.amount) / LAMPORTS_PER_SOL} SOL — ${side}`);
  }
}

// ------------------------------------------------------------------ bounties

const bountyPda = (bank: PublicKey, sponsor: PublicKey, salt = 0n, pid = MARKET_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("bounty"), bank.toBuffer(), sponsor.toBuffer(), Buffer.from(new anchor.BN(salt.toString()).toArray("le", 8))],
    pid,
  )[0];

/** Escrow a capability bounty on a bank: first run to finalize >= threshold
 *  before `deadline` takes the pot — paid to the RUN's operator, not a bettor. */
async function bountyOpen(bank: PublicKey, threshold: number, amount: bigint, deadlineTs: bigint, salt: bigint, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const b = bountyPda(bank, kp.publicKey, salt, market.programId);
  await (market.methods as any)
    .createBounty(new anchor.BN(salt.toString()), threshold, new anchor.BN(amount.toString()), new anchor.BN(deadlineTs.toString()))
    .accounts({ sponsor: kp.publicKey, bank, bounty: b })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`bounty ${b.toBase58()} opened: bank ${bank.toBase58()} threshold=${threshold} pot=${Number(amount) / LAMPORTS_PER_SOL} SOL deadline=${new Date(Number(deadlineTs) * 1000).toISOString()}`);
  return b;
}

/** Permissionless claim — anyone may trigger it; the pot lands on the run's
 *  operator (`run.runner`), verified on-chain. Needs no Arcium env: the run
 *  fetch is a plain account read and the claim ix is sealed→market only. */
async function bountyClaim(bountyPk: PublicKey, runPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const { program, provider } = sealedProgram();
  const run: any = await (program.account as any).run.fetch(runPk);
  const before = await provider.connection.getBalance(run.runner);
  const sig = await (market.methods as any)
    .claimBounty()
    .accounts({ run: runPk, bounty: bountyPk, payee: run.runner })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  const afterBal = await provider.connection.getBalance(run.runner);
  const b: any = await (market.account as any).bounty.fetch(bountyPk);
  console.log(`bounty claimed (${sig}): run ${runPk.toBase58()} score=${b.winningScore} paid ${afterBal - before} lamports to runner ${run.runner.toBase58()}`);
}

/** Permissionless expiry — pot + rent return to the stored sponsor. */
async function bountyExpire(bountyPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const b: any = await (market.account as any).bounty.fetch(bountyPk);
  const sig = await (market.methods as any)
    .expireBounty()
    .accounts({ bounty: bountyPk, sponsor: b.sponsor })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`bounty expired (${sig}): ${bountyPk.toBase58()} — escrow returned to sponsor ${b.sponsor.toBase58()}`);
}

async function bountyShow(bountyPk: PublicKey) {
  const { market } = marketProgram();
  let b: any;
  try {
    b = await (market.account as any).bounty.fetch(bountyPk);
  } catch {
    // `expire_bounty` closes the account — a missing PDA IS the expired state.
    console.log(`bounty ${bountyPk.toBase58()} status=EXPIRED (account closed — escrow returned to sponsor)`);
    return;
  }
  const status = ["OPEN", "CLAIMED", "EXPIRED"][b.status as number] ?? `?${b.status}`;
  console.log(`bounty ${bountyPk.toBase58()} status=${status}`);
  console.log(`  bank=${b.bank.toBase58()} sponsor=${b.sponsor.toBase58()} threshold=${b.threshold} pot=${Number(b.amount) / LAMPORTS_PER_SOL} SOL`);
  const fmt = (v: bigint) => new Date(Number(v) * 1000).toISOString();
  console.log(`  created_at=${fmt(b.createdAt)} deadline=${fmt(b.deadline)}`);
  if (b.status === 1)
    console.log(`  winner_run=${b.winnerRun.toBase58()} winning_score=${b.winningScore}`);
}

/** `chain unbrick <sealed|market> <kind> <args…>` — sweep a grief-prefunded
 *  PDA's lamports to this wallet, un-bricking its `init` path. The on-chain
 *  ix re-derives the address from `seeds` under the program id, so only a
 *  canonical PDA of that program can be drained. */
async function unbrickPda(cmd: string[]) {
  const [program, kind, ...a] = cmd;
  const P = (s: string) => new PublicKey(s).toBuffer();
  const u8 = (n: number) => Buffer.from([n]);
  const salt = (s?: string) => u64le(BigInt(s ?? "0"));
  const arity: Record<string, number> = {
    benchmark: 2, chunk: 2, items: 2, pitems: 2, run: 2, reveal: 3, grant: 4,
    market: 1, duel: 2, position: 2, ladder: 1, dark: 1, darkpos: 2, bounty: 2,
  };
  let seeds: Buffer[] | undefined;
  if (kind && a.length < (arity[kind] ?? 99)) {
    // missing positional args — print usage rather than crash on undefined
  } else if (program === "sealed") {
    switch (kind) {
      case "benchmark": seeds = [Buffer.from("benchmark"), P(a[0]), u32le(Number(a[1]))]; break;
      case "chunk": case "items": case "pitems":
        seeds = [Buffer.from(kind), P(a[0]), u16le(Number(a[1]))]; break;
      case "run": seeds = [Buffer.from("run"), P(a[0]), u64le(BigInt(a[1]))]; break;
      case "reveal": seeds = [Buffer.from("reveal"), P(a[0]), u16le(Number(a[1])), u8(Number(a[2]))]; break;
      case "grant": seeds = [Buffer.from("grant"), P(a[0]), u16le(Number(a[1])), u8(Number(a[2])), P(a[3])]; break;
    }
  } else if (program === "market") {
    switch (kind) {
      case "market": seeds = [Buffer.from("market"), P(a[0]), salt(a[1])]; break;
      case "duel": seeds = [Buffer.from("duel"), P(a[0]), P(a[1]), salt(a[2])]; break;
      case "position": seeds = [Buffer.from("position"), P(a[0]), P(a[1])]; break;
      case "ladder": seeds = [Buffer.from("ladder"), P(a[0]), salt(a[1])]; break;
      case "dark": seeds = [Buffer.from("dark"), P(a[0]), salt(a[1])]; break;
      case "darkpos": seeds = [Buffer.from("darkpos"), P(a[0]), P(a[1]), salt(a[2])]; break;
      case "bounty": seeds = [Buffer.from("bounty"), P(a[0]), P(a[1]), salt(a[2])]; break;
    }
  }
  if (!seeds) {
    console.log("usage: chain unbrick <sealed|market> <kind> <args…>");
    console.log("  sealed: benchmark <authority> <id> | chunk|items|pitems <bank> <idx> | run <bank> <idx> | reveal <bank> <chunk> <part> | grant <bank> <chunk> <part> <viewer>");
    console.log("  market: market|dark <run> [salt] | duel <a> <b> [salt] | position <market|ladder> <bettor> | ladder <leg> [salt] | darkpos <market> <bettor> [salt] | bounty <bank> <sponsor> [salt]");
    return;
  }
  const { prog, kp } = program === "sealed"
    ? (({ program: p, kp }) => ({ prog: p, kp }))(sealedProgram())
    : (({ market: m, kp }) => ({ prog: m, kp }))(marketProgram());
  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, prog.programId);
  const sig = await (prog.methods as any)
    .unbrickPda(seeds, bump)
    .accounts({ rescuer: kp.publicKey, pda })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`unbrick_pda ${pda.toBase58()} (${sig}) — grief lamports swept to ${kp.publicKey.toBase58()}; the init path is unblocked`);
}

// ------------------------------------------------------------------ cli glue

/**
 * Venue attestation: the benchmark authority marks a finalized run as vouched
 * (it executed the claimed model/harness). Reputation, not proof — separates
 * attested runs from self-reported `model_id` claims on the leaderboard.
 */
export async function attestRun(runPk: PublicKey) {
  const ctx = setup();
  const acct = ctx.program.account as any;
  const r: any = await acct.run.fetch(runPk);
  await ctx.program.methods
    .attestRun(new anchor.BN(r.index.toString()))
    .accounts({ authority: ctx.wallet.publicKey, benchmark: r.benchmark, run: runPk })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`run ${runPk.toBase58()} attested by authority ${ctx.wallet.publicKey.toBase58()}`);
}

/** `chain record --run <pk>` — permissionlessly enroll a finalized run's
 *  MPC-written score into the on-chain capability registry. The ModelRecord
 *  PDA is keyed by sha256(model_id) so the entry binds the run's declared
 *  identity; a ScoreLog receipt makes double-counting impossible. */
export async function recordScore(runPk: PublicKey) {
  const { program, kp } = sealedProgram();
  const acct = program.account as any;
  const r: any = await acct.run.fetch(runPk);
  if (r.status !== 1) throw new Error(`run not finalized (status=${r.status})`);
  const modelHash = createHash("sha256").update(Buffer.from(r.modelId, "utf8")).digest();
  const [modelRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from("modelrec"), modelHash], program.programId,
  );
  const [scoreLog] = PublicKey.findProgramAddressSync(
    [Buffer.from("scorelog"), runPk.toBuffer()], program.programId,
  );
  if (await acct.scoreLog.fetchNullable(scoreLog))
    throw new Error(`run already enrolled (receipt ${scoreLog.toBase58()})`);
  const sig = await program.methods
    .recordScore(new anchor.BN(r.index.toString()), Array.from(modelHash))
    .accounts({ recorder: kp.publicKey, run: runPk, modelRecord, scoreLog })
    .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
  console.log(`run ${runPk.toBase58()} recorded → ${r.modelId} ${r.correct}/${Number(r.chunkCount) * 32} ` +
    `(record ${modelRecord.toBase58()}, receipt ${scoreLog.toBase58()}, ${sig})`);
}

/** `chain record --all` — the permissionless librarian: crawl the ledger,
 *  enroll every finalized run that lacks a ScoreLog receipt. Idempotent —
 *  receipts are init-once PDAs so a re-run is a no-op. */
export async function recordAllScores() {
  const { program, kp } = sealedProgram();
  const acct = program.account as any;
  const [runs, logs] = await Promise.all([acct.run.all(), acct.scoreLog.all()]);
  const enrolled = new Set(logs.map((l: any) => (l.account.run as PublicKey).toBase58()));
  let done = 0, failed = 0, pending = 0;
  for (const { publicKey: runPk, account: r } of runs) {
    if (r.status !== 1) { pending++; continue; }
    if (enrolled.has(runPk.toBase58())) continue;
    try {
      const modelHash = createHash("sha256").update(Buffer.from(r.modelId, "utf8")).digest();
      const [modelRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from("modelrec"), modelHash], program.programId);
      const [scoreLog] = PublicKey.findProgramAddressSync(
        [Buffer.from("scorelog"), runPk.toBuffer()], program.programId);
      const sig = await program.methods
        .recordScore(new anchor.BN(r.index.toString()), Array.from(modelHash))
        .accounts({ recorder: kp.publicKey, run: runPk, modelRecord, scoreLog })
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      console.log(`enrolled ${r.modelId} ${r.correct}/${Number(r.chunkCount) * 32} ` +
        `→ ${modelRecord.toBase58().slice(0, 16)}… (${sig.slice(0, 20)}…)`);
      done++;
    } catch (e: any) {
      failed++;
      const code = /Error Code: (\w+)/.exec(String(e?.message ?? e))?.[1] ?? String(e).slice(0, 80);
      console.log(`  failed ${runPk.toBase58()} ${r.modelId}: ${code}`);
    }
  }
  console.log(`\n${done} newly enrolled, ${enrolled.size} already recorded, ${pending} unfinalized${failed ? `, ${failed} failed` : ""}`);
}

const BANK_KIND = ["authored", "generated", "private"] as const;

/** `chain banks [--snapshot f] [--json]` — every benchmark, run-count first:
 *  the index `chain status --benchmark <pk>` needs without an explorer. */
export async function bankList(snapPath?: string, json = false, kind?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [banks, runs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "Benchmark"), snapOf(ss, "Run")]
    : await Promise.all([acct().benchmark.all(), acct().run.all()]);
  const best = new Map<string, number>();
  const finalized = new Map<string, number>();
  for (const r of runs) {
    if (r.account.status !== 1) continue;
    const k = (r.account.benchmark as PublicKey).toBase58();
    const items = Number(r.account.chunkCount) * 32;
    const pct = items ? (100 * Number(r.account.correct)) / items : 0;
    best.set(k, Math.max(best.get(k) ?? 0, pct));
    finalized.set(k, (finalized.get(k) ?? 0) + 1);
  }
  const want = kind ? BANK_KIND.indexOf(kind as any) : -1;
  if (kind && want < 0) throw new Error(`--kind one of ${BANK_KIND.join("|")}`);
  const rows = banks.filter((x) => want < 0 || x.account.kind === want).map((x) => {
    const b = x.account;
    const pk = x.publicKey.toBase58();
    return {
      pk, name: b.name as string, kind: BANK_KIND[b.kind as number] ?? String(b.kind),
      items: Number(b.chunkCount) * 32, runs: Number(b.runCount),
      finalized: finalized.get(pk) ?? 0, best: best.get(pk) ?? 0,
      reveals: Number(b.revealCount), createdAt: Number(b.createdAt),
      authority: (b.authority as PublicKey).toBase58(),
    };
  }).sort((p, q) => q.runs - p.runs || p.name.localeCompare(q.name));
  if (json) { console.log(JSON.stringify(rows)); return rows; }
  console.log(`${rows.length} benchmarks — run count first:`);
  for (const r of rows)
    console.log(`  ${r.pk}  ${r.name.padEnd(20)} ${r.kind.padEnd(9)} items=${String(r.items).padStart(3)} runs=${String(r.runs).padStart(3)}` +
      ` finalized=${String(r.finalized).padStart(3)} best=${r.best.toFixed(1)}%${r.reveals ? ` reveals=${r.reveals}` : ""}`);
  return rows;
}

/** `chain bank <pk|name> [--json]` — one benchmark's dossier: spec,
 *  every run/receipt/reveal/grant/chunk on it, and every market-program
 *  venue priced against it — the explorer's per-bank section as a
 *  portable report. Names aren't unique; when a name matches several
 *  banks the command lists them and asks for a pk. */
export async function bankShow(keyOrName: string, json = false, snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sAcct = () => (sealedProgram().program.account as any);
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [banks, runs, logs, reveals, grants, itemChunks, privChunks]: Acct[][] =
    ss ? ["Benchmark", "Run", "ScoreLog", "Reveal", "ShareGrant", "ItemChunk", "PrivItemChunk"].map((n) => snapOf(ss, n))
       : await Promise.all(["benchmark", "run", "scoreLog", "reveal", "shareGrant", "itemChunk", "privItemChunk"]
        .map((n) => (sAcct() as any)[n].all()));
  const [markets, darks, ladders, bounties]: Acct[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty"].map((n) => (mAcct() as any)[n].all()));
  const matches = banks.filter((x) => x.publicKey.toBase58() === keyOrName || x.account.name === keyOrName);
  if (!matches.length) throw new Error(`no benchmark named/addressed ${keyOrName}`);
  if (matches.length > 1) {
    console.log(`${matches.length} benchmarks named ${keyOrName} — re-run with a public key:`);
    for (const m of matches) console.log(`  ${m.publicKey.toBase58()}`);
    process.exitCode = 2;
    return;
  }
  const bank = matches[0];
  const B = bank.account as any;
  const pk = bank.publicKey.toBase58();
  const bRuns = runs.filter((r) => (r.account.benchmark as PublicKey).toBase58() === pk);
  const bLogs = logs.filter((l) => (l.account.benchmark as PublicKey).toBase58() === pk);
  const bReveals = reveals.filter((r) => (r.account.benchmark as PublicKey).toBase58() === pk);
  const bGrants = grants.filter((g) => (g.account.benchmark as PublicKey).toBase58() === pk);
  const bItem = itemChunks.filter((c) => (c.account.benchmark as PublicKey).toBase58() === pk);
  const bPriv = privChunks.filter((c) => (c.account.benchmark as PublicKey).toBase58() === pk);
  const items = Number(B.chunkCount) * 32;
  const fin = bRuns.filter((r) => r.account.status === 1);
  const postRev = bRuns.filter((r) => r.account.postReveal);
  const best = fin.reduce((m, r) => Math.max(m, Number(r.account.correct)), -1);
  const STATUS = ["open", "resolved", "expired"];
  const venueRow = (xs: Acct[], kind: string, key: "benchmark" | "bank", statusName?: (a: any) => string) => {
    const list = xs.filter((v) => (v.account[key] as PublicKey)?.toBase58?.() === pk);
    if (!list.length) return null;
    const byStatus: Record<string, number> = {};
    for (const v of list) {
      const s = statusName ? statusName(v.account) : (STATUS[v.account.status as number] ?? String(v.account.status));
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    return { kind, total: list.length, byStatus };
  };
  const venues = [
    venueRow(markets, "band/duel", "benchmark"), venueRow(darks, "dark", "benchmark"),
    venueRow(ladders, "ladder", "benchmark"),
    venueRow(bounties, "bounty", "bank", (a) => (a.status === 0 ? "open" : "claimed")),
  ].filter((v): v is NonNullable<typeof v> => Boolean(v));
  const out = {
    pk, name: B.name, kind: BANK_KIND[B.kind as number] ?? String(B.kind),
    authority: (B.authority as PublicKey).toBase58(), status: B.status,
    items, chunksSealed: Number(B.chunksSealed), chunksTotal: Number(B.chunkCount),
    itemsRoot: Buffer.from(B.itemsRoot).toString("hex"),
    feeLamports: Number(B.feeLamports), createdAt: Number(B.createdAt),
    runs: { total: bRuns.length, finalized: fin.length, pending: bRuns.length - fin.length,
      postReveal: postRev.length, bestCorrect: best < 0 ? null : best, bestPct: best < 0 ? null : +(100 * best / Math.max(1, items)).toFixed(1) },
    receipts: { total: bLogs.length, vouched: bLogs.filter((l) => l.account.vouchedAtRecord).length,
      postReveal: bLogs.filter((l) => l.account.postReveal).length },
    reveals: bReveals.map((r) => ({ pk: r.publicKey.toBase58(), chunk: r.account.chunkIndex, part: r.account.part, revealedAt: Number(r.account.revealedAt) }))
      .sort((a, b) => a.revealedAt - b.revealedAt),
    grants: bGrants.length,
    chunks: { public: bItem.length, private: bPriv.length },
    venues,
  };
  if (json) { console.log(JSON.stringify(out)); return out; }
  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`bank ${pk}`);
  console.log(`  spec — "${out.name}" ${out.kind} · authority ${out.authority.slice(0, 12)}… · status=${out.status} · ${out.chunksSealed}/${out.chunksTotal} chunks sealed (${out.items} items) · fee ${(out.feeLamports / 1e9).toFixed(4)}◎ · created ${fmt(out.createdAt)}`);
  console.log(`  items_root — ${out.itemsRoot.slice(0, 24)}…  (chain items --benchmark ${pk.slice(0, 8)}… regenerates the exam offline)`);
  console.log(`  runs — ${out.runs.total} total · ${out.runs.finalized} finalized · ${out.runs.pending} pending · ${out.runs.postReveal} post-reveal${out.runs.bestCorrect !== null ? ` · best ${out.runs.bestCorrect}/${out.items} (${out.runs.bestPct}%)` : ""}`);
  console.log(`  receipts — ${out.receipts.total} minted · ${out.receipts.vouched} vouched · ${out.receipts.postReveal} post-reveal`);
  if (out.reveals.length)
    for (const r of out.reveals) console.log(`  reveal — ${r.pk.slice(0, 12)}… chunk ${r.chunk} part ${r.part} @ ${fmt(r.revealedAt)}`);
  else console.log(`  reveals — none (answer fingerprints still sealed)`);
  console.log(`  grants — ${out.grants} reshare grant(s) · chunks stored: ${out.chunks.public} public + ${out.chunks.private} private`);
  if (!venues.length) console.log(`  venues — none priced runs on this bank`);
  for (const v of venues)
    console.log(`  venues — ${v.kind}: ${v.total} (${Object.entries(v.byStatus).map(([k, n]) => `${n} ${k}`).join(", ")})`);
  return out;
}

/** `chain runs [--bank <pk|name>] [--model <id>] [--min-pct n] [--status s]`
  for (const r of rows)
    console.log(`  ${r.pk}  ${r.name.padEnd(20)} ${r.kind.padEnd(9)} items=${String(r.items).padStart(3)} runs=${String(r.runs).padStart(3)}` +
      ` finalized=${String(r.finalized).padStart(3)} best=${r.best.toFixed(1)}%${r.reveals ? ` reveals=${r.reveals}` : ""}`);
  return rows;
}

/** `chain runs [--bank <pk|name>] [--model <id>] [--min-pct n] [--status s]`
 *  — the run substrate index: who ran what, scored what, on which bank.
 *  The question behind every bounty and market — "which runs cleared X on
 *  bank Y" — as a grep-able table. */
export async function runList(opts: {
  snapPath?: string; json?: boolean; bank?: string; model?: string;
  minPct?: number; status?: string;
}) {
  const ss = opts.snapPath ? decodeSnapshotSection(loadSnapshotJson(opts.snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [banks, runs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "Benchmark"), snapOf(ss, "Run")]
    : await Promise.all([acct().benchmark.all(), acct().run.all()]);
  const bankName = new Map(banks.map((b) => [b.publicKey.toBase58(), b.account.name as string]));
  // Bank names are human labels, not unique — a name filter matches every
  // bank carrying it; a pk filter matches exactly one.
  const bankPks = opts.bank
    ? (() => {
        const m = banks.filter((b) => b.publicKey.toBase58() === opts.bank || b.account.name === opts.bank);
        if (!m.length) throw new Error(`no benchmark named/addressed ${opts.bank}`);
        return new Set(m.map((b) => b.publicKey.toBase58()));
      })()
    : undefined;
  const statusMap: Record<string, number> = { pending: 0, finalized: 1, cancelled: 2 };
  const want = opts.status ? statusMap[opts.status] : undefined;
  if (opts.status && want === undefined) throw new Error(`--status one of ${Object.keys(statusMap).join("|")}`);
  const rows = runs.map((x) => {
    const r = x.account;
    const items = Number(r.chunkCount) * 32;
    const pct = items && Number(r.status) === 1 ? (100 * Number(r.correct)) / items : 0;
    return {
      pk: x.publicKey.toBase58(), model: r.modelId as string,
      bank: (r.benchmark as PublicKey).toBase58(), bankName: bankName.get((r.benchmark as PublicKey).toBase58()) ?? "?",
      status: Number(r.status), correct: Number(r.correct), items, pct,
      postReveal: !!r.postReveal, runner: (r.runner as PublicKey).toBase58(),
      createdAt: Number(r.createdAt), finalizedAt: Number(r.finalizedAt),
    };
  }).filter((r) =>
    (!bankPks || bankPks.has(r.bank)) &&
    (!opts.model || r.model === opts.model) &&
    (opts.minPct === undefined || r.pct >= opts.minPct) &&
    (want === undefined || r.status === want))
    .sort((a, b) => b.pct - a.pct || b.finalizedAt - a.finalizedAt);
  if (opts.json) { console.log(JSON.stringify(rows)); return rows; }
  console.log(`${rows.length} run(s)${bankPks ? ` on ${opts.bank}` : ""}${opts.model ? ` by ${opts.model}` : ""} — score first:`);
  for (const r of rows.slice(0, 100))
    console.log(`  ${r.pk}  ${r.model.padEnd(24)} ${r.bankName.padEnd(18)} ${r.status === 1 ? `${String(r.correct).padStart(3)}/${r.items} (${r.pct.toFixed(1)}%)` : (["PENDING", "?", "CANCELLED"][r.status] ?? r.status)}${r.postReveal ? " post-reveal" : ""}`);
  if (rows.length > 100) console.log(`  … ${rows.length - 100} more (narrow with --bank/--model/--min-pct)`);
  return rows;
}

/** `chain records` — the whole capability registry, accuracy-first. */
export async function modelRecordList(snapPath?: string, json = false) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const [all, logs] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog")]
    : await Promise.all([
        (sealedProgram().program.account as any).modelRecord.all(),
        (sealedProgram().program.account as any).scoreLog.all(),
      ]);
  if (!all.length) { console.log("no model records — record_score a finalized run first"); return; }
  // Vouched-only aggregate, recomputed over receipts — the answer to
  // self-reported model_id claims: what the venue-vouched evidence shows.
  const vAgg = new Map<string, { c: number; i: number }>();
  for (const l of logs) {
    const a = l.account as any;
    if (!a.vouchedAtRecord) continue;
    const k = (a.modelRecord as PublicKey).toBase58();
    const v = vAgg.get(k) ?? { c: 0, i: 0 };
    v.c += a.correct; v.i += a.items; vAgg.set(k, v);
  }
  const rows = all
    .map(({ account: r, publicKey: pk }: any) => ({
      pk,
      modelId: r.modelId as string,
      runs: r.runsScored as number,
      pct: r.totalItems.toNumber() ? 100 * r.totalCorrect.toNumber() / r.totalItems.toNumber() : 0,
      bestPct: r.bestItems ? 100 * r.bestCorrect / r.bestItems : 0,
      best: `${r.bestCorrect}/${r.bestItems}`,
      vouched: vAgg.get(pk.toBase58()),
      last: (r.lastRun as PublicKey).toBase58(),
    }))
    .sort((a: any, b: any) => b.bestPct - a.bestPct || b.pct - a.pct);
  if (json) {
    console.log(JSON.stringify(rows.map((r: any) => ({
      record: r.pk.toBase58(), modelId: r.modelId, runs: r.runs,
      pct: r.pct, best: r.best, bestPct: r.bestPct,
      vouched: r.vouched ? `${r.vouched.c}/${r.vouched.i}` : null, lastRun: r.last,
    }))));
    return rows;
  }
  console.log(`${rows.length} model record(s) — cumulative MPC-scored performance:`);
  for (const r of rows)
    console.log(`  ${r.modelId.padEnd(36)} runs=${r.runs}  agg=${r.pct.toFixed(1)}%  best=${r.best} (${r.bestPct.toFixed(1)}%)` +
      `${r.vouched ? `  vouched=${r.vouched.c}/${r.vouched.i}` : ""}  rec=${r.pk.toBase58()}`);
}

/** `chain modelrec <pubkey|model_id>` — print a registry entry. */
export async function modelRecordShow(keyOrName: string, snapPath?: string, json = false) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  let pda: PublicKey;
  try {
    pda = new PublicKey(keyOrName);
  } catch {
    const h = createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest();
    [pda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), h], sealedProgramId());
  }
  const rec: any = ss
    ? snapOf(ss, "ModelRecord").find((x) => x.publicKey.equals(pda))?.account
    : await acct().modelRecord.fetchNullable(pda);
  if (!rec) { console.log(`no model record at ${pda.toBase58()}`); return; }
  if (json) {
    const logs: any[] = (ss ? snapOf(ss, "ScoreLog") : await acct().scoreLog.all())
      .filter((l: any) => (l.account.modelRecord as PublicKey).equals(pda));
    console.log(JSON.stringify({
      record: pda.toBase58(), modelId: rec.modelId,
      modelHash: Buffer.from(rec.modelHash).toString("hex"),
      runs: rec.runsScored, totalCorrect: rec.totalCorrect.toNumber(), totalItems: rec.totalItems.toNumber(),
      best: `${rec.bestCorrect}/${rec.bestItems}`, bestRun: (rec.bestRun as PublicKey).toBase58(),
      bestBank: (rec.bestBank as PublicKey).toBase58(), lastRun: (rec.lastRun as PublicKey).toBase58(),
      firstSeen: rec.firstSeen, lastScored: rec.lastScored,
      vouchedReceipts: logs.filter((l: any) => l.account.vouchedAtRecord).length,
      postRevealReceipts: logs.filter((l: any) => l.account.postReveal).length,
    }));
    return;
  }
  const pct = rec.totalItems.toNumber() ? (100 * rec.totalCorrect.toNumber() / rec.totalItems.toNumber()).toFixed(1) : "0.0";
  console.log(`model record ${pda.toBase58()}`);
  console.log(`  model_id=${rec.modelId}  hash=${Buffer.from(rec.modelHash).toString("hex").slice(0, 16)}…`);
  console.log(`  runs=${rec.runsScored}  aggregate=${rec.totalCorrect}/${rec.totalItems} (${pct}%)`);
  const logs: any[] = (ss ? snapOf(ss, "ScoreLog") : await acct().scoreLog.all())
    .filter((l: any) => (l.account.modelRecord as PublicKey).equals(pda));
  const vc = logs.filter((l: any) => l.account.vouchedAtRecord).reduce((s: number, l: any) => s + l.account.correct, 0);
  const vi = logs.filter((l: any) => l.account.vouchedAtRecord).reduce((s: number, l: any) => s + l.account.items, 0);
  if (vi) console.log(`  vouched-only=${vc}/${vi} (${(100 * vc / vi).toFixed(1)}%) across ${logs.filter((l: any) => l.account.vouchedAtRecord).length} attested receipt(s)`);
  // Self-verification: the stored aggregate must recompute bit-exact from
  // this record's receipts — the registry cannot lie.
  const rc = logs.reduce((s: number, l: any) => s + Number(l.account.correct), 0);
  const ri = logs.reduce((s: number, l: any) => s + Number(l.account.items), 0);
  console.log(logs.length === (rec.runsScored as number) && rc === rec.totalCorrect.toNumber() && ri === rec.totalItems.toNumber()
    ? `  replayed ${logs.length} receipt(s) — stored aggregate verified bit-exact`
    : `  !! VIOLATION — receipts sum ${rc}/${ri} over ${logs.length} run(s), record claims ${rec.totalCorrect}/${rec.totalItems} over ${rec.runsScored}`);
  console.log(`  best=${rec.bestCorrect}/${rec.bestItems} on run ${(rec.bestRun as PublicKey).toBase58()} (bank ${(rec.bestBank as PublicKey).toBase58()})`);
  console.log(`  last=${(rec.lastRun as PublicKey).toBase58()}  first_seen=${rec.firstSeen}  last_scored=${rec.lastScored}`);
}

/** `chain gate <model_id|record-pk> [--min-pct N] [--min-runs N]
 *  [--min-items N] [--wilson N] [--vouched] [--no-post-reveal] [--json]`
 *  — evaluate a capability policy
 *  over the on-chain registry and exit 0/1/2 (pass / fail / no evidence).
 *  Composability made executable: a script, CI job, or downstream venue
 *  can gate on MPC-scored receipts instead of a leaderboard's word. The
 *  policy check is pure (`gate.ts`) — same verdict off a live RPC or the
 *  explorer's committed snapshot. */
export async function gateModelRecord(
  keyOrName: string,
  policy: GatePolicy,
  json = false,
  snapPath?: string,
  bank?: string,
): Promise<GateVerdict> {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  let pda: PublicKey;
  try {
    pda = new PublicKey(keyOrName);
  } catch {
    const h = createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest();
    [pda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), h], sealedProgramId());
  }
  const rec: any = ss
    ? snapOf(ss, "ModelRecord").find((x) => x.publicKey.equals(pda))?.account
    : await acct().modelRecord.fetchNullable(pda);
  // --bank accepts a pk or a name; names aren't unique so a name matches
  // every benchmark carrying it (same semantics as `chain runs`).
  const bankPks = bank
    ? new Set((ss ? snapOf(ss, "Benchmark") : await acct().benchmark.all())
        .filter((b: any) => b.publicKey.toBase58() === bank || b.account.name === bank)
        .map((b: any) => b.publicKey.toBase58()))
    : null;
  if (bank && !bankPks!.size) throw new Error(`no benchmark named/addressed ${bank}`);
  const logs: any[] = rec
    ? (ss ? snapOf(ss, "ScoreLog") : await acct().scoreLog.all())
        .filter((l: any) => (l.account.modelRecord as PublicKey).equals(pda)
          && (!bankPks || bankPks.has((l.account.benchmark as PublicKey).toBase58())))
    : [];
  const receipts: ScoreReceipt[] = logs.map((l: any) => ({
    correct: l.account.correct as number,
    items: l.account.items as number,
    vouchedAtRecord: l.account.vouchedAtRecord,
    postReveal: l.account.postReveal,
  }));
  const verdict = evalGate(receipts, policy, !!rec);
  verdict.modelId = rec ? (rec.modelId as string) : keyOrName;
  const out = { record: pda.toBase58(), ...verdict };
  if (json) {
    console.log(JSON.stringify(out));
  } else if (!rec) {
    console.log(`NO EVIDENCE — no model record for ${keyOrName} (${pda.toBase58()})`);
  } else {
    const tag = verdict.pass ? "PASS" : verdict.reason === "policy" ? "FAIL" : "NO EVIDENCE";
    console.log(`${tag} — ${verdict.modelId} ${verdict.runs} ${verdict.scope} run(s), ` +
      `${verdict.correct}/${verdict.items} (${verdict.pct.toFixed(1)}%)` +
      `  [registry: ${verdict.totalRuns} total, ${verdict.postRevealRuns} post-reveal]` +
      (bank ? `  [bank: ${bank}]` : ""));
    for (const c of verdict.checks)
      console.log(`  ${c.pass ? "ok" : "MISS"} ${c.name}: ${c.actual} (needed ${c.needed})`);
  }
  process.exitCode = verdict.pass ? 0 : verdict.reason === "policy" ? 1 : 2;
  return verdict;
}

/** `chain compare <A> <B> [--json]` — the registry's actual question: "does
 *  A beat B on the SAME evidence?" Aggregates lie (different banks, different
 *  item counts); this joins each model's ScoreLog receipts by benchmark and
 *  reports paired deltas. Banks only one model ran are reported as coverage
 *  asymmetry, not silently dropped. Exit 0 decisive / 1 tie / 2 no shared
 *  benchmark — composable like `gate`. */
export async function modelCompare(keyA: string, keyB: string, json = false, snapPath?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const resolve = (keyOrName: string): PublicKey => {
    try { return new PublicKey(keyOrName); } catch { /* model_id */ }
    const h = createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest();
    return PublicKey.findProgramAddressSync([Buffer.from("modelrec"), h], sealedProgramId())[0];
  };
  const pkA = resolve(keyA), pkB = resolve(keyB);
  const [records, logs, banks]: [SnapAccount[], SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog"), snapOf(ss, "Benchmark")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all(), acct().benchmark.all()]);
  const recA = records.find((r) => r.publicKey.equals(pkA));
  const recB = records.find((r) => r.publicKey.equals(pkB));
  const bankName = new Map(banks.map((b) => [b.publicKey.toBase58(), b.account.name as string]));
  const byBank = (pk: PublicKey) => {
    const m = new Map<string, { correct: number; items: number; runs: number }>();
    for (const l of logs) {
      if (!(l.account.modelRecord as PublicKey).equals(pk)) continue;
      const k = (l.account.benchmark as PublicKey).toBase58();
      const e = m.get(k) ?? { correct: 0, items: 0, runs: 0 };
      e.correct += Number(l.account.correct); e.items += Number(l.account.items); e.runs++;
      m.set(k, e);
    }
    return m;
  };
  const a = byBank(pkA), b = byBank(pkB);
  const shared = [...a.keys()].filter((k) => b.has(k));
  const rows = shared.map((k) => {
    const ea = a.get(k)!, eb = b.get(k)!;
    const pa = ea.items ? (100 * ea.correct) / ea.items : 0;
    const pb = eb.items ? (100 * eb.correct) / eb.items : 0;
    return { bank: k, name: bankName.get(k) ?? "?", a: ea, b: eb, pctA: pa, pctB: pb, delta: pa - pb };
  }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const pooledA = shared.reduce((s, k) => s + a.get(k)!.correct, 0);
  const pooledAi = shared.reduce((s, k) => s + a.get(k)!.items, 0);
  const pooledB = shared.reduce((s, k) => s + b.get(k)!.correct, 0);
  const pooledBi = shared.reduce((s, k) => s + b.get(k)!.items, 0);
  const pctA = pooledAi ? (100 * pooledA) / pooledAi : 0;
  const pctB = pooledBi ? (100 * pooledB) / pooledBi : 0;
  const wins = { a: rows.filter((r) => r.delta > 0).length, tie: rows.filter((r) => r.delta === 0).length,
    b: rows.filter((r) => r.delta < 0).length };
  const verdict = shared.length === 0 ? "no-evidence" : pctA === pctB ? "tie" : pctA > pctB ? "a" : "b";
  const out = {
    a: { record: pkA.toBase58(), modelId: recA?.account.modelId ?? keyA },
    b: { record: pkB.toBase58(), modelId: recB?.account.modelId ?? keyB },
    sharedBanks: rows, pooled: { a: `${pooledA}/${pooledAi}`, b: `${pooledB}/${pooledBi}`, pctA, pctB },
    bankWins: wins, onlyA: [...a.keys()].filter((k) => !b.has(k)).length,
    onlyB: [...b.keys()].filter((k) => !a.has(k)).length, verdict,
  };
  if (json) { console.log(JSON.stringify(out)); }
  else {
    const nA = out.a.modelId, nB = out.b.modelId;
    console.log(`${nA} vs ${nB} — ${shared.length} shared benchmark(s)` +
      (recA && recB ? "" : `  (${!recA ? nA : nB} has no ModelRecord)`));
    for (const r of rows)
      console.log(`  ${r.bank.slice(0, 12)}… ${String(r.name).padEnd(14)} ` +
        `${r.pctA.toFixed(1)}% vs ${r.pctB.toFixed(1)}%  Δ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)}` +
        `  (${r.a.correct}/${r.a.items} vs ${r.b.correct}/${r.b.items}, ${r.a.runs}v${r.b.runs} runs)`);
    if (shared.length) {
      console.log(`pooled shared items: ${nA} ${pooledA}/${pooledAi} (${pctA.toFixed(1)}%)  ` +
        `${nB} ${pooledB}/${pooledBi} (${pctB.toFixed(1)}%)`);
      console.log(`bank wins: ${nA} ${wins.a} — tie ${wins.tie} — ${nB} ${wins.b}` +
        `  | unshared: ${out.onlyA} bank(s) only ${nA} ran, ${out.onlyB} only ${nB}`);
      console.log(verdict === "tie" ? "VERDICT: tie on shared items"
        : `VERDICT: ${verdict === "a" ? nA : nB} +${Math.abs(pctA - pctB).toFixed(1)}pp on shared evidence`);
    } else {
      console.log("VERDICT: no shared benchmark — the registry can't rank them against each other" +
        ` (${a.size} vs ${b.size} bank(s) covered, disjoint)`);
    }
  }
  process.exitCode = verdict === "no-evidence" ? 2 : verdict === "tie" ? 1 : 0;
  return out;
}

/** `chain compare --all [--json]` — the paired-evidence leaderboard: every
 *  model×model pair's shared-bank result tallied into a win table. Aggregate
 *  accuracy ranks models that never faced the same exam; this ranks them on
 *  what they actually shared — and says how much of the ranking is grounded
 *  (pairs with zero shared banks count as unranked, not assumed). */
export async function compareAll(json = false, snapPath?: string, minShared = 1) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [records, logs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all()]);
  // per record: bank → {correct, items}
  const byBank = new Map<string, Map<string, { correct: number; items: number }>>();
  for (const l of logs) {
    const rec = (l.account.modelRecord as PublicKey).toBase58();
    const k = (l.account.benchmark as PublicKey).toBase58();
    const m = byBank.get(rec) ?? new Map<string, { correct: number; items: number }>();
    const e = m.get(k) ?? { correct: 0, items: 0 };
    e.correct += Number(l.account.correct); e.items += Number(l.account.items);
    m.set(k, e);
    byBank.set(rec, m);
  }
  const recs = records.map((r) => ({
    pk: r.publicKey.toBase58(), modelId: r.account.modelId as string,
    banks: byBank.get(r.publicKey.toBase58())?.size ?? 0,
    wins: 0, losses: 0, ties: 0, rankedPairs: 0, sharedBanks: 0, ppDelta: 0,
  }));
  let unranked = 0;
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    const a = byBank.get(recs[i].pk) ?? new Map(), b = byBank.get(recs[j].pk) ?? new Map();
    const shared = [...a.keys()].filter((k) => b.has(k));
    if (shared.length < minShared) { unranked++; continue; }
    const pa = shared.reduce((s, k) => s + a.get(k)!.correct, 0) / Math.max(1, shared.reduce((s, k) => s + a.get(k)!.items, 0));
    const pb = shared.reduce((s, k) => s + b.get(k)!.correct, 0) / Math.max(1, shared.reduce((s, k) => s + b.get(k)!.items, 0));
    recs[i].rankedPairs++; recs[j].rankedPairs++;
    recs[i].sharedBanks += shared.length; recs[j].sharedBanks += shared.length;
    const d = 100 * (pa - pb);
    recs[i].ppDelta += d; recs[j].ppDelta -= d;
    if (pa > pb) { recs[i].wins++; recs[j].losses++; }
    else if (pa < pb) { recs[j].wins++; recs[i].losses++; }
    else { recs[i].ties++; recs[j].ties++; }
  }
  const ranked = recs.sort((x, y) => y.wins - x.wins || x.losses - y.losses || y.ppDelta - x.ppDelta);
  const total = (recs.length * (recs.length - 1)) / 2;
  if (json) { console.log(JSON.stringify({ ranked, unrankedPairs: unranked, totalPairs: total })); return ranked; }
  console.log(`paired-evidence leaderboard — ${recs.length} models, ${total} pairs ` +
    `(${total - unranked} rankable, ${unranked} disjoint${minShared > 1 ? ` or <${minShared} shared banks` : ""})`);
  for (const r of ranked)
    console.log(`  ${r.modelId.padEnd(28)} W${String(r.wins).padStart(2)}-L${String(r.losses).padStart(2)}-T${String(r.ties).padStart(2)}` +
      `  ΣΔ${r.ppDelta >= 0 ? "+" : ""}${r.ppDelta.toFixed(0)}pp  over ${r.sharedBanks} shared-bank result(s)`);
  console.log(`ranking grounded on shared benchmarks only — ${unranked} pair(s) had none and count as unranked`);
  return ranked;
}

/** `chain trail <run-pk> [--json]` — one run's custody chain: bank → receipt
 *  → every venue that priced it → resolution re-verified. The explorer's
 *  custody row as a portable report: each resolved venue's `resolvedScore`
 *  / `winningScore` is checked against `Run.correct` rather than trusted. */
export async function chainTrail(runPkStr: string, json = false, snapPath?: string) {
  const runPk = new PublicKey(runPkStr);
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sealedAcct = () => (sealedProgram().program.account as any);
  const marketAcct = () => (marketProgram().market.account as any);
  const [runs, banks, logs, markets, darks, ladders, bounties]: [SnapAccount[], SnapAccount[], SnapAccount[], SnapAccount[], SnapAccount[], SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "Run"), snapOf(ss, "Benchmark"), snapOf(ss, "ScoreLog"),
       snapOf(sm!, "Market"), snapOf(sm!, "DarkMarket"), snapOf(sm!, "Ladder"), snapOf(sm!, "Bounty")]
    : await Promise.all([
        sealedAcct().run.all(), sealedAcct().benchmark.all(), sealedAcct().scoreLog.all(),
        marketAcct().market.all(), marketAcct().darkMarket.all(), marketAcct().ladder.all(), marketAcct().bounty.all()]);
  const run = runs.find((r) => r.publicKey.equals(runPk));
  if (!run) { console.log(`no run at ${runPkStr}`); return; }
  const R = run.account as any;
  const bank = banks.find((b) => (b.account as any) && (b.publicKey as PublicKey).equals(R.benchmark));
  const receipt = logs.find((l) => (l.account.run as PublicKey).equals(runPk));
  const B = bank?.account as any;
  const items = Number(R.chunkCount) * 32;
  const venues: any[] = [];
  const STATUS = ["open", "resolved", "expired"];
  for (const m of markets) {
    const M = m.account as any;
    const isA = (M.run as PublicKey).equals(runPk);
    const isB = M.runB && !(M.runB as PublicKey).equals(PublicKey.default) && (M.runB as PublicKey).equals(runPk);
    if (!isA && !isB) continue;
    const duel = isB || (M.runB && !(M.runB as PublicKey).equals(PublicKey.default));
    // duels pack resolved_score = (a << 16) | b; bands store the run's correct.
    const ourScore = duel ? (isA ? Number(M.resolvedScore) >> 16 : Number(M.resolvedScore) & 0xffff) : Number(M.resolvedScore);
    const verified = M.status === 1 ? ourScore === Number(R.correct) : null;
    venues.push({ kind: duel ? "duel" : "band", pk: m.publicKey.toBase58(), status: STATUS[M.status as number] ?? M.status,
      outcome: M.status === 1 ? (duel ? (Number(M.outcome) === 0 ? "A won" : Number(M.outcome) === 1 ? "B won" : "tie") : `bucket ${M.outcome}`) : null,
      edges: duel ? [] : (M.edges as any[]).slice(0, Math.max(0, Number(M.nOutcomes) - 1)).map(Number),
      resolvedScore: M.status === 1 ? (duel ? `${Number(M.resolvedScore) >> 16}-${Number(M.resolvedScore) & 0xffff}` : Number(M.resolvedScore)) : null, verified,
      pool: (M.totals as any[]).reduce((s: number, t: any) => s + Number(t), 0) });
  }
  for (const d of darks) {
    const D = d.account as any;
    if (!(D.run as PublicKey).equals(runPk)) continue;
    venues.push({ kind: "dark", pk: d.publicKey.toBase58(), status: STATUS[D.status as number] ?? D.status,
      tallied: !!D.tallied, pool: Number(D.poolTotal), resolvedScore: D.status === 1 ? Number(D.resolvedScore) : null,
      verified: D.status === 1 ? Number(D.resolvedScore) === Number(R.correct) : null });
  }
  for (const l of ladders) {
    const L = l.account as any;
    const legIx = (L.legs as PublicKey[]).slice(0, Number(L.legCount)).findIndex((p) => p.equals(runPk));
    if (legIx < 0) continue;
    const legs = (L.legs as PublicKey[]).slice(0, Number(L.legCount));
    const legRuns = legs.map((lp) => runs.find((r) => r.publicKey.equals(lp))?.account as any);
    const scores = legRuns.map((lr) => (lr && lr.status === 1 ? Number(lr.correct) : 0));
    const winner = scores.length ? scores.indexOf(Math.max(...scores)) : -1;
    venues.push({ kind: "ladder", pk: l.publicKey.toBase58(), status: STATUS[L.status as number] ?? L.status,
      leg: `${legIx + 1}/${L.legCount}`, outcome: L.status === 1 ? (winner === legIx ? "won" : scores[legIx] === scores[winner] ? "dead-heat" : "lost") : null,
      resolvedScore: L.status === 1 ? scores[legIx] : null, verified: L.status === 1 ? scores[legIx] === Number(R.correct) : null });
  }
  for (const b of bounties) {
    const Bo = b.account as any;
    if (!(Bo.winnerRun as PublicKey).equals(runPk)) continue;
    venues.push({ kind: "bounty", pk: b.publicKey.toBase58(), status: "claimed",
      threshold: Number(Bo.threshold), winningScore: Number(Bo.winningScore),
      amount: Number(Bo.amount), verified: Number(Bo.winningScore) === Number(R.correct) });
  }
  const out = {
    run: runPkStr, modelId: R.modelId, benchmark: (R.benchmark as PublicKey).toBase58(),
    bankName: B?.name ?? "?", bankKind: BANK_KIND[B?.kind as number] ?? "?",
    score: `${R.correct}/${items}`, status: R.status === 1 ? "finalized" : `pending (${R.status})`,
    postReveal: !!R.postReveal, runner: (R.runner as PublicKey).toBase58(), createdAt: Number(R.createdAt),
    receipt: receipt ? { pk: receipt.publicKey.toBase58(), recordedBy: (receipt.account.recordedBy as PublicKey).toBase58(),
      recordedAt: Number(receipt.account.recordedAt), vouched: !!receipt.account.vouchedAtRecord,
      postReveal: !!receipt.account.postReveal } : null,
    venues,
  };
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`trail ${runPkStr}`);
  console.log(`  run — model "${R.modelId}" by ${out.runner.slice(0, 12)}… on ${out.bankName} (${out.bankKind})`);
  console.log(`  score — ${out.score} ${out.status}${out.postReveal ? "  ⚠ post-reveal (committed after a fingerprint reveal — spoiled items)" : ""}`);
  console.log(`  bank  — ${(R.benchmark as PublicKey).toBase58()}`);
  if (receipt) {
    const r = receipt.account as any;
    console.log(`  receipt — ${receipt.publicKey.toBase58()} recorded by ${(r.recordedBy as PublicKey).toBase58().slice(0, 12)}…` +
      ` @ ${Number(r.recordedAt)}${r.vouchedAtRecord ? "  [vouched by bank authority]" : ""}${r.postReveal ? "  [post-reveal]" : ""}`);
  } else console.log(`  receipt — none (run not enrolled — \`chain record --run ${runPkStr.slice(0, 12)}…\` enrolls it)`);
  if (!venues.length) console.log(`  venues — none priced this run`);
  for (const v of venues) {
    const check = v.verified === null ? "" : v.verified ? "  ✓ score matches Run.correct" : "  ✗ MISMATCH vs Run.correct";
    console.log(`  venue ${v.kind.padEnd(6)} ${v.pk}  ${v.status}${v.outcome != null ? ` → ${v.outcome}` : ""}` +
      `${v.leg ? ` leg ${v.leg}` : ""}${v.edges?.length ? ` edges=[${v.edges.join(",")}]` : ""}` +
      `${v.resolvedScore != null ? ` resolved=${v.resolvedScore}` : ""}${v.threshold != null ? ` threshold=${v.threshold}` : ""}` +
      `${v.pool != null ? ` pool=${(v.pool / 1e9).toFixed(3)}◎` : ""}${v.amount != null ? ` pot=${(v.amount / 1e9).toFixed(3)}◎` : ""}${check}`);
  }
  return out;
}

/** `chain bounties [--snapshot f] [--json]` — the runner-facing index: every
 *  capability bounty (open / claimed / expired), threshold, pot, deadline.
 *  Board serves keepers; this answers "where can my model earn?" */
export async function bountyList(snapPath?: string, json = false) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const marketAcct = () => (marketProgram().market.account as any);
  const [bounties, runs, bankRows]: [SnapAccount[], SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(sm!, "Bounty"), snapOf(ss, "Run"), snapOf(ss, "Benchmark")]
    : await Promise.all([marketAcct().bounty.all(), (sealedProgram().program.account as any).run.all(),
        (sealedProgram().program.account as any).benchmark.all()]);
  const bankName = new Map(bankRows.map((b) => [b.publicKey.toBase58(), (b.account as any).name as string]));
  const bankItems = new Map(bankRows.map((b) => [b.publicKey.toBase58(), Number((b.account as any).chunkCount) * 32]));
  const runsOnBank = new Map<string, any[]>();
  const bestOnBank = new Map<string, number>();
  for (const r of runs) {
    const k = ((r.account as any).benchmark as PublicKey).toBase58();
    (runsOnBank.get(k) ?? runsOnBank.set(k, []).get(k)!).push(r.account);
    if ((r.account as any).status === 1)
      bestOnBank.set(k, Math.max(bestOnBank.get(k) ?? 0, Number((r.account as any).correct)));
  }
  const now = Math.floor(Date.now() / 1000);
  const BSTATUS = ["open", "claimed", "expired"];
  const rows = bounties.map((x) => {
    const b = x.account as any;
    const bank = (b.bank as PublicKey).toBase58();
    const status = BSTATUS[b.status as number] ?? String(b.status);
    const best = bestOnBank.get(bank) ?? 0;
    const items = bankItems.get(bank) ?? 0;
    return {
      pk: x.publicKey.toBase58(), bank, bankName: bankName.get(bank) ?? "?",
      sponsor: (b.sponsor as PublicKey).toBase58(), threshold: Number(b.threshold), items,
      amount: Number(b.amount), deadline: Number(b.deadline),
      status, winnerRun: b.status === 1 ? (b.winnerRun as PublicKey).toBase58() : null,
      winningScore: b.status === 1 ? Number(b.winningScore) : null,
      bestScoreOnBank: best,
      // bounty_qualifies mirrored exactly (board.ts): proven run on the bank
      // with correct >= threshold, created_at >= bounty.created_at
      // (retroactivity wall), runner != sponsor, not post-reveal.
      clearableNow: b.status === 0 && now <= Number(b.deadline) && (runsOnBank.get(bank) ?? []).some((r: any) =>
        proven({
          pubkey: "", benchmark: bank, status: r.status, correct: Number(r.correct),
          createdAt: Number(r.createdAt), runner: (r.runner as PublicKey).toBase58(),
          postReveal: !!r.postReveal, scoredMask: String(r.scoredMask ?? "0"),
          firstPendingAt: Number(r.firstPendingAt ?? 0), allQueuedAt: Number(r.allQueuedAt ?? 0),
        } as BoardRun, now) &&
        Number(r.correct) >= Number(b.threshold) && Number(r.createdAt) >= Number(b.createdAt) &&
        !(r.runner as PublicKey).equals(b.sponsor) && !r.postReveal),
      expired: b.status === 0 && now > Number(b.deadline),
      deadlineIn: Number(b.deadline) - now,
    };
  }).sort((p, q) => Number(p.status !== "open") - Number(q.status !== "open") || q.amount - p.amount);
  if (json) { console.log(JSON.stringify(rows)); return rows; }
  const open = rows.filter((r) => r.status === "open" && !r.expired);
  const claimable = rows.filter((r) => r.clearableNow);
  console.log(`${rows.length} bounties — ${open.length} open (${claimable.length} claimable right now):`);
  for (const r of rows) {
    const stat = r.status === "open" && r.expired ? "open·expired" : r.status;
    console.log(`  ${r.pk.slice(0, 12)}… ${stat.padEnd(12)} ${String(r.bankName).padEnd(16)} ` +
      `≥${r.threshold}/${r.items}  pot=${(r.amount / 1e9).toFixed(3)}◎  ` +
      (r.status === "claimed" ? `won ${r.winningScore} by ${r.winnerRun?.slice(0, 12)}…` :
        r.status === "open" && r.expired ? `deadline passed — expire_bounty refunds sponsor` :
        `deadline in ${Math.max(0, Math.round(r.deadlineIn / 3600))}h  best-on-bank=${r.bestScoreOnBank}` +
        (r.clearableNow ? `  ← a qualifying run already clears it — claim_bounty` :
          r.bestScoreOnBank >= r.threshold ? ` (predates bounty — retroactivity wall)` : "")));
  }
  return rows;
}

/** The two integrity verdicts, with per-item detail: which ModelRecords
 *  replay bit-exact from their receipts, and which resolved venues'
 *  stored scores match `Run.correct`. Shared by `chain stats` and
 *  `chain export` — the same arithmetic, never re-derived twice. */
function ledgerIntegrity(p: {
  records: SnapAccount[]; logsByRec: Map<string, any[]>; markets: SnapAccount[];
  darks: SnapAccount[]; ladders: SnapAccount[]; bounties: SnapAccount[]; runs: SnapAccount[];
}) {
  const recordRows: { pk: string; modelId: string; stored: string; replayed: string; ok: boolean }[] = [];
  for (const r of p.records) {
    const a = r.account as any;
    const ls = p.logsByRec.get(r.publicKey.toBase58()) ?? [];
    const rc = ls.reduce((s: number, l: any) => s + Number(l.correct), 0);
    const ri = ls.reduce((s: number, l: any) => s + Number(l.items), 0);
    const ok = ls.length === Number(a.runsScored) && rc === Number(a.totalCorrect) && ri === Number(a.totalItems);
    recordRows.push({ pk: r.publicKey.toBase58(), modelId: a.modelId, stored: `${a.totalCorrect}/${a.totalItems} over ${a.runsScored}`, replayed: `${rc}/${ri} over ${ls.length}`, ok });
  }
  const runByPk = new Map(p.runs.map((r) => [r.publicKey.toBase58(), r.account as any]));
  const correctOf = (pk: PublicKey) => Number(runByPk.get(pk.toBase58())?.correct ?? -1);
  const venueRows: { venue: string; kind: string; stored: number; expected: number; ok: boolean }[] = [];
  for (const m of p.markets) {
    const M = m.account as any;
    if (M.status !== 1) continue;
    const duel = M.runB && !(M.runB as PublicKey).equals(PublicKey.default);
    const stored = Number(M.resolvedScore);
    const expected = duel ? (correctOf(M.run) << 16) | correctOf(M.runB) : correctOf(M.run);
    venueRows.push({ venue: m.publicKey.toBase58(), kind: duel ? "duel" : "band", stored, expected, ok: stored === expected });
  }
  for (const d of p.darks) {
    const D = d.account as any;
    if (D.status !== 1) continue;
    venueRows.push({ venue: d.publicKey.toBase58(), kind: "dark", stored: Number(D.resolvedScore), expected: correctOf(D.run), ok: Number(D.resolvedScore) === correctOf(D.run) });
  }
  for (const b of p.bounties) {
    const B = b.account as any;
    if (B.status !== 1) continue;
    venueRows.push({ venue: b.publicKey.toBase58(), kind: "bounty", stored: Number(B.winningScore), expected: correctOf(B.winnerRun), ok: Number(B.winningScore) === correctOf(B.winnerRun) });
  }
  for (const l of p.ladders) {
    const L = l.account as any;
    if (L.status !== 1) continue;
    const legs = (L.legs as PublicKey[]).slice(0, Number(L.legCount));
    const scores = legs.map((x) => correctOf(x));
    const mx = Math.max(...scores);
    const maskOk = scores.every((s, i) => (s === mx) === !!((Number(L.resultMask) >> i) & 1));
    venueRows.push({ venue: l.publicKey.toBase58(), kind: "ladder", stored: Number(L.resolvedScore), expected: mx, ok: Number(L.resolvedScore) === mx && maskOk });
  }
  return {
    recOk: recordRows.filter((r) => r.ok).length, recBad: recordRows.filter((r) => !r.ok).length,
    resOk: venueRows.filter((r) => r.ok).length, resBad: venueRows.filter((r) => !r.ok).length,
    recordRows, venueRows,
  };
}

/** `chain market venue <pk> [--json]` — one venue's dossier: which type,
 *  status, pools per outcome, positions held, fee skim, the run(s) it
 *  prices, its keeper classification (the same verdict `market board`
 *  assigns), and — when resolved — its stored score re-verified against
 *  `Run.correct` (duel packing and ladder masks handled). */
export async function marketVenue(pkStr: string, json = false, snapPath?: string) {
  const pk = new PublicKey(pkStr);
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sAcct = () => (sealedProgram().program.account as any);
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [markets, darks, ladders, bounties, positions, darkPositions]: Acct[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty", "Position", "DarkPosition"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty", "position", "darkPosition"]
        .map((n) => (mAcct() as any)[n].all()));
  const runs: Acct[] = ss ? snapOf(ss, "Run") : await sAcct().run.all();
  const runByPk = new Map(runs.map((r) => [r.publicKey.toBase58(), r.account as any]));
  const runInfo = (rpk: PublicKey) => {
    const r = runByPk.get(rpk.toBase58());
    return r ? { pk: rpk.toBase58(), modelId: r.modelId, correct: Number(r.correct), status: r.status, postReveal: !!r.postReveal } : { pk: rpk.toBase58() };
  };
  const { board } = await loadBoard(snapPath);
  const keeperState = (p: string) =>
    board.claimable.some((x: any) => x.pubkey === p) ? "claimable" :
    board.resolvable.some((x: any) => x.pubkey === p) ? "resolvable" :
    board.resolvableLadders.some((x: any) => x.pubkey === p) ? "resolvable" :
    board.tallyable.some((x: any) => x.pubkey === p) ? "tallyable" :
    board.expirable.some((x: any) => x.pubkey === p) ? "expirable" :
    board.expiredBounties.some((x: any) => x.pubkey === p) ? "expired-bounty" :
    board.liveBounties.some((x: any) => x.pubkey === p) ? "live-bounty" : null;

  const pos = positions.filter((p) => (p.account.market as PublicKey).equals(pk));
  const dpos = darkPositions.filter((p) => (p.account.market as PublicKey).equals(pk));
  const STATUS = ["open", "resolved", "expired"];
  let out: any = null;

  const m = markets.find((x) => x.publicKey.equals(pk));
  if (m) {
    const M = m.account as any;
    const duel = M.runB && !(M.runB as PublicKey).equals(PublicKey.default);
    const rs = Number(M.resolvedScore);
    const expA = duel ? rs >> 16 : rs, expB = duel ? rs & 0xffff : null;
    const rA = runByPk.get((M.run as PublicKey).toBase58());
    const rB = duel ? runByPk.get((M.runB as PublicKey).toBase58()) : null;
    const verified = M.status === 1
      ? expA === Number(rA?.correct ?? -1) && (duel ? expB === Number(rB?.correct ?? -1) : true) : null;
    out = { pk: pkStr, kind: duel ? "duel" : "band", status: STATUS[M.status] ?? M.status,
      authority: (M.authority as PublicKey).toBase58(),
      outcomes: Number(M.nOutcomes), edges: (M.edges as any[]).slice(0, Math.max(0, Number(M.nOutcomes) - 1)).map(Number),
      totals: (M.totals as any[]).map(Number), feesLamports: Number(M.feesAccrued), feeBps: Number(M.feeBps),
      createdAt: Number(M.createdAt), resolvedAt: Number(M.resolvedAt), closesAt: Number(M.closesAt), resolveBy: Number(M.resolveBy),
      runs: { a: runInfo(M.run), b: duel ? runInfo(M.runB) : null },
      resolution: M.status === 1 ? { outcome: M.outcome, storedScore: duel ? `${expA}-${expB}` : expA, verified } : null,
      positions: pos.length, keeper: keeperState(pkStr) };
  }
  const d = darks.find((x) => x.publicKey.equals(pk));
  if (!out && d) {
    const D = d.account as any;
    const r = runByPk.get((D.run as PublicKey).toBase58());
    out = { pk: pkStr, kind: "dark", status: STATUS[D.status] ?? D.status,
      authority: (D.authority as PublicKey).toBase58(),
      outcomes: Number(D.n ?? D.nOutcomes), edges: (D.edges as any[]).map(Number),
      poolLamports: Number(D.poolTotal), winTotal: Number(D.winTotal), revealedCount: Number(D.revealedCount),
      tallied: !!D.tallied, revealUntil: Number(D.revealUntil),
      createdAt: Number(D.createdAt), resolvedAt: Number(D.resolvedAt), resolveBy: Number(D.resolveBy),
      feesLamports: Number(D.feesAccrued),
      runs: { a: runInfo(D.run) },
      resolution: D.status === 1 ? { storedScore: Number(D.resolvedScore), verified: Number(D.resolvedScore) === Number(r?.correct ?? -1) } : null,
      positions: dpos.length, keeper: keeperState(pkStr) };
  }
  const l = ladders.find((x) => x.publicKey.equals(pk));
  if (!out && l) {
    const L = l.account as any;
    const legs = (L.legs as PublicKey[]).slice(0, Number(L.legCount));
    const legRuns = legs.map(runInfo);
    const winners = L.status === 1 ? legs.filter((_, i) => (Number(L.resultMask) >> i) & 1).map((p) => p.toBase58()) : [];
    const verified = L.status === 1
      ? legs.every((lp, i) => {
          const r = runByPk.get(lp.toBase58());
          const won = ((Number(L.resultMask) >> i) & 1) === 1;
          const top = Math.max(...legs.map((x) => Number(runByPk.get(x.toBase58())?.correct ?? 0)));
          return won === (Number(r?.correct ?? 0) === top);
        }) : null;
    out = { pk: pkStr, kind: "ladder", status: STATUS[L.status] ?? L.status,
      authority: (L.authority as PublicKey).toBase58(),
      legs: legRuns, winners, resultMask: Number(L.resultMask),
      totals: (L.totals as any[]).map(Number), feesLamports: Number(L.feesAccrued),
      createdAt: Number(L.createdAt), resolvedAt: Number(L.resolvedAt), closesAt: Number(L.closesAt), resolveBy: Number(L.resolveBy),
      resolution: L.status === 1 ? { storedScore: Number(L.resolvedScore), verified } : null,
      positions: pos.length, keeper: keeperState(pkStr) };
  }
  const b = bounties.find((x) => x.publicKey.equals(pk));
  if (!out && b) {
    const B = b.account as any;
    const claimed = B.status !== 0;
    const r = runByPk.get((B.winnerRun as PublicKey).toBase58());
    out = { pk: pkStr, kind: "bounty", status: claimed ? "claimed" : "open",
      sponsor: (B.sponsor as PublicKey).toBase58(), bank: (B.bank as PublicKey).toBase58(),
      threshold: Number(B.threshold), amountLamports: Number(B.amount),
      createdAt: Number(B.createdAt), deadline: Number(B.deadline),
      winnerRun: claimed ? runInfo(B.winnerRun) : null,
      resolution: claimed ? { storedScore: Number(B.winningScore), verified: Number(B.winningScore) === Number(r?.correct ?? -1) } : null,
      keeper: keeperState(pkStr) };
  }
  if (!out) { console.log(`no venue at ${pkStr}`); process.exitCode = 2; return; }
  if (json) { console.log(JSON.stringify(out)); return out; }
  const fmt = (t: number) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : "-");
  const sol = (x: number) => (x / 1e9).toFixed(4);
  console.log(`venue ${pkStr}`);
  console.log(`  kind — ${out.kind} · status ${out.status}${out.keeper ? ` · keeper: ${out.keeper}` : ""}`);
  if (out.kind === "bounty")
    console.log(`  bounty — ≥${out.threshold} pays ${sol(out.amountLamports)}◎ · sponsor ${out.sponsor.slice(0, 12)}… · bank ${out.bank.slice(0, 12)}… · created ${fmt(out.createdAt)} deadline ${fmt(out.deadline)}`);
  else {
    console.log(`  pool — ${out.totals ? out.totals.map((t: number) => sol(t)).join(" / ") + " ◎" : sol(out.poolLamports) + " ◎"}${out.feesLamports ? ` · fees accrued ${sol(out.feesLamports)}◎` : ""}`);
    console.log(`  times — created ${fmt(out.createdAt)} · closes ${fmt(out.closesAt)} · resolve_by ${fmt(out.resolveBy)}${out.revealUntil ? ` · reveal_until ${fmt(out.revealUntil)}` : ""}${out.resolvedAt ? ` · resolved ${fmt(out.resolvedAt)}` : ""}`);
  }
  if (out.runs?.a) {
    const a = out.runs.a, bb = out.runs.b;
    console.log(`  run A — ${a.modelId ?? a.pk} ${a.correct !== undefined ? `scored ${a.correct}` : "(missing)"}${a.postReveal ? " post-reveal" : ""}`);
    if (bb) console.log(`  run B — ${bb.modelId ?? bb.pk} ${bb.correct !== undefined ? `scored ${bb.correct}` : "(missing)"}${bb.postReveal ? " post-reveal" : ""}`);
  }
  if (out.legs) for (const [i, lg] of out.legs.entries())
    console.log(`  leg ${i + 1}/${out.legs.length} — ${lg.modelId ?? lg.pk} ${lg.correct !== undefined ? `scored ${lg.correct}` : "(pending)"}${out.winners.includes(lg.pk) ? "  ★ winner" : ""}`);
  if (out.resolution) {
    const chk = out.resolution.verified === null ? "" : out.resolution.verified ? "  ✓ matches Run.correct" : "  ✗ MISMATCH vs Run.correct";
    console.log(`  resolution — ${out.resolution.storedScore}${out.resolution.outcome !== undefined ? ` outcome ${out.resolution.outcome}` : ""}${chk}`);
  }
  if (out.positions !== undefined) console.log(`  positions — ${out.positions} held`);
  return out;
}

/** `chain stats [--snapshot f] [--json]` — the executive dashboard: ledger
 *  counts, escrow, fees, and the two integrity verdicts recomputed inline —
 *  every ModelRecord's aggregate replayed from its ScoreLogs bit-exact, and
 *  every resolved venue's stored score checked against `Run.correct`.
 *  Numbers you don't have to trust: they recompute on the spot. */
export async function chainStats(snapPath?: string, json = false) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sAcct = () => (sealedProgram().program.account as any);
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [banks, runs, logs, records, reveals, grants, itemChunks, privChunks]: Acct[][] =
    ss ? ["Benchmark", "Run", "ScoreLog", "ModelRecord", "Reveal", "ShareGrant", "ItemChunk", "PrivItemChunk"]
        .map((n) => snapOf(ss, n))
       : await Promise.all(["benchmark", "run", "scoreLog", "modelRecord", "reveal", "shareGrant", "itemChunk", "privItemChunk"]
        .map((n) => (sAcct() as any)[n].all()));
  const [markets, darks, ladders, bounties, positions, darkPositions]: Acct[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty", "Position", "DarkPosition"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty", "position", "darkPosition"]
        .map((n) => (mAcct() as any)[n].all()));

  const lam = (x: any) => Number(x ?? 0);
  const sum = (xs: any[], f: (a: any) => number) => xs.reduce((s, x) => s + f(x.account ?? x), 0);
  const escrow = sum(markets, (m) => (m.totals as any[]).reduce((s2: number, t: any) => s2 + lam(t), 0))
    + sum(ladders, (l) => (l.totals as any[]).reduce((s2: number, t: any) => s2 + lam(t), 0))
    + sum(darks, (d) => lam(d.poolTotal)) + sum(bounties, (b) => lam(b.amount));
  const fees = sum(markets, (m) => lam(m.feesAccrued)) + sum(ladders, (l) => lam(l.feesAccrued)) + sum(darks, (d) => lam(d.feesAccrued));

  // Verdict 1: every ModelRecord's stored aggregate must recompute bit-exact
  // from its ScoreLog receipts — the registry cannot lie. (Shared with
  // chainExport via ledgerIntegrity below.)
  const logsByRec = new Map<string, any[]>();
  for (const l of logs) {
    const k = (l.account.modelRecord as PublicKey).toBase58();
    (logsByRec.get(k) ?? logsByRec.set(k, []).get(k)!).push(l.account);
  }
  const { recOk, recBad, resOk, resBad } = ledgerIntegrity({ records, logsByRec, markets, darks, ladders, bounties, runs });

  const fin = runs.filter((r) => (r.account as any).status === 1);
  const lats = fin.map((r) => { const a = r.account as any; return Number(a.firstPendingAt) > 0 && Number(a.finalizedAt) > Number(a.firstPendingAt) ? Number(a.finalizedAt) - Number(a.firstPendingAt) : 0; }).filter((x) => x > 0).sort((a, b) => a - b);
  const pct = (p: number) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(p * lats.length / 100))] : 0;
  const vouched = logs.filter((l) => (l.account as any).vouchedAtRecord).length;
  const postRev = logs.filter((l) => (l.account as any).postReveal).length;

  const out = {
    ledger: {
      banks: banks.length, runs: runs.length, finalized: fin.length,
      itemChunks: itemChunks.length, privChunks: privChunks.length,
      reveals: reveals.length, grants: grants.length,
      records: records.length, receipts: logs.length,
      venues: markets.length + darks.length + ladders.length + bounties.length,
      markets: markets.length, darks: darks.length, ladders: ladders.length, bounties: bounties.length,
      positions: positions.length + darkPositions.length,
    },
    money: { escrowLamports: escrow, feesLamports: fees },
    integrity: {
      registryReplay: `${recOk}/${records.length} bit-exact${recBad ? ` (${recBad} VIOLATIONS)` : ""}`,
      resolutionsVerified: `${resOk}/${resOk + resBad} match Run.correct${resBad ? ` (${resBad} MISMATCHES)` : ""}`,
      vouchedReceipts: `${vouched}/${logs.length}`,
      postRevealReceipts: postRev,
    },
    mpcLatency: { samples: lats.length, p50s: pct(50), p95s: pct(95) },
    keeper: (await loadBoard(snapPath)).board,
  };
  if (json) {
    const { keeper, ...rest } = out;
    const actionable = keeper.claimable.length + keeper.resolvable.length + keeper.resolvableLadders.length +
      keeper.tallyable.length + keeper.expirable.length + keeper.expiredBounties.length;
    console.log(JSON.stringify({ ...rest, keeper: { actionable, settled: keeper.settled, filling: keeper.filling } }));
    return out;
  }
  const actionable = out.keeper.claimable.length + out.keeper.resolvable.length + out.keeper.resolvableLadders.length +
    out.keeper.tallyable.length + out.keeper.expirable.length + out.keeper.expiredBounties.length;
  console.log(`ledger — ${out.ledger.banks} banks · ${out.ledger.runs} runs (${out.ledger.finalized} MPC-finalized)` +
    ` · ${out.ledger.venues} venues (${out.ledger.markets} band/duel, ${out.ledger.darks} dark, ${out.ledger.ladders} ladder, ${out.ledger.bounties} bounty)` +
    ` · ${out.ledger.positions} positions`);
  console.log(`registry — ${out.ledger.records} records · ${out.ledger.receipts} receipts (${out.integrity.vouchedReceipts} vouched, ${postRev} post-reveal)`);
  console.log(`disclosure — ${out.ledger.reveals} reveals · ${out.ledger.grants} reshare grants · ${out.ledger.itemChunks}+${out.ledger.privChunks} item chunks`);
  console.log(`money — ${(escrow / 1e9).toFixed(3)}◎ escrowed · ${(fees / 1e9).toFixed(4)}◎ protocol fees collected`);
  console.log(`integrity — registry ${out.integrity.registryReplay} · resolutions ${out.integrity.resolutionsVerified}`);
  console.log(`mpc — scoring latency p50 ${out.mpcLatency.p50s}s / p95 ${out.mpcLatency.p95s}s (${lats.length} timed runs)`);
  console.log(`keeper — ${actionable} actionable now · ${out.keeper.settled} settled · ${out.keeper.filling} in play`);
  if (recBad || resBad) process.exitCode = 1;
  return out;
}

/** `chain export [--snapshot <f>] [--out file]` — the portable evidence
 *  digest: the classified ledger as one machine-readable document.
 *  Self-binding (carries the bundle's sha256 + MANIFEST verdict), with
 *  per-record and per-venue integrity rows an integrator or CI job can
 *  diff without learning the account layouts. Without `--snapshot` the
 *  digest runs over the live cluster — the same verdicts on YOUR
 *  deployment, not just the committed bundle. */
export async function chainExport(snapPath: string | undefined, out?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sAcct = () => sealedProgram().program;
  const mAcct = () => marketProgram().market;
  type Acct = { publicKey: PublicKey; account: any };
  const [banks, runs, logs, records, reveals, grants, itemChunks, privChunks]: Acct[][] =
    ss ? ["Benchmark", "Run", "ScoreLog", "ModelRecord", "Reveal", "ShareGrant", "ItemChunk", "PrivItemChunk"].map((n) => snapOf(ss, n))
       : await Promise.all(["benchmark", "run", "scoreLog", "modelRecord", "reveal", "shareGrant", "itemChunk", "privItemChunk"]
        .map((n) => tolerantAll(sAcct(), n)));
  const [markets, darks, ladders, bounties, positions, darkPositions]: Acct[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty", "Position", "DarkPosition"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty", "position", "darkPosition"]
        .map((n) => tolerantAll(mAcct(), n)));
  const sha256 = snapPath ? createHash("sha256").update(readFileSync(snapPath)).digest("hex") : null;
  const logsByRec = new Map<string, any[]>();
  for (const l of logs) {
    const k = (l.account.modelRecord as PublicKey).toBase58();
    (logsByRec.get(k) ?? logsByRec.set(k, []).get(k)!).push(l.account);
  }
  const integ = ledgerIntegrity({ records, logsByRec, markets, darks, ladders, bounties, runs });
  const { board } = await loadBoard(snapPath);
  const actionable = board.claimable.length + board.resolvable.length + board.resolvableLadders.length +
    board.tallyable.length + board.expirable.length + board.expiredBounties.length;
  const digest = {
    kind: "sealed-evidence-digest/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath ?? "live", snapshotSha256: sha256,
    programs: { sealed: sealedProgramId().toBase58(), market: MARKET_PROGRAM_ID.toBase58() },
    epochs: snap?.meta?.epochs ?? null,
    counts: {
      banks: banks.length, runs: runs.length, receipts: logs.length, records: records.length,
      reveals: reveals.length, grants: grants.length,
      itemChunks: itemChunks.length, privChunks: privChunks.length,
      markets: markets.length, darkMarkets: darks.length, ladders: ladders.length,
      bounties: bounties.length, positions: positions.length + darkPositions.length,
    },
    integrity: {
      recordsOk: integ.recOk, recordsBad: integ.recBad,
      resolutionsOk: integ.resOk, resolutionsBad: integ.resBad,
      records: integ.recordRows, resolutions: integ.venueRows,
    },
    keeper: {
      actionable, settled: board.settled, filling: board.filling,
      claimable: board.claimable, resolvable: board.resolvable,
      resolvableLadders: board.resolvableLadders, tallyable: board.tallyable,
      expirable: board.expirable, expiredBounties: board.expiredBounties,
    },
    banks: banks.map((x) => ({
      pk: x.publicKey.toBase58(), name: x.account.name, kind: x.account.kind,
      items: Number(x.account.chunkCount) * 32, runs: Number(x.account.runCount),
      reveals: Number(x.account.revealCount),
      itemsRoot: Buffer.from(x.account.itemsRoot).toString("hex"),
    })),
    records: records.map((x) => ({
      pk: x.publicKey.toBase58(), modelId: x.account.modelId,
      runsScored: Number(x.account.runsScored),
      totalCorrect: Number(x.account.totalCorrect), totalItems: Number(x.account.totalItems),
    })),
  };
  const text = JSON.stringify(digest, null, 2) + "\n";
  if (out) { writeFileSync(out, text); console.log(`wrote ${out} — ${integ.recOk}/${records.length} records bit-exact, ${integ.resOk}/${integ.resOk + integ.resBad} resolutions verified, ${actionable} keeper actions`); }
  else console.log(text);
  if (integ.recBad || integ.resBad) process.exitCode = 1;
  return digest;
}

/** `chain feed [--limit N] [--type a,b] [--since ts] [--json]` — the
 *  network's activity stream: every timestamped event across both
 *  programs (bank created → run queued → MPC finalized → receipt
 *  minted → venue opened → resolved → reveal → grant) in one
 *  chronological list, newest first. The per-type indexes answer "what
 *  exists"; this answers "is it alive". `--type` filters by event class
 *  (bank,run,score,receipt,venue,resolution,reveal,grant). */
export async function chainFeed(limit = 40, typeFilter?: string, since = 0, json = false, snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sAcct = () => (sealedProgram().program.account as any);
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [banks, runs, logs, reveals, grants]: Acct[][] =
    ss ? ["Benchmark", "Run", "ScoreLog", "Reveal", "ShareGrant"].map((n) => snapOf(ss, n))
       : await Promise.all(["benchmark", "run", "scoreLog", "reveal", "shareGrant"]
        .map((n) => (sAcct() as any)[n].all()));
  const [markets, darks, ladders, bounties]: Acct[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty"]
        .map((n) => (mAcct() as any)[n].all()));

  const bankName = new Map(banks.map((b) => [b.publicKey.toBase58(), `${b.account.name} (${BANK_KIND[b.account.kind as number] ?? "?"})`]));
  const runModel = new Map(runs.map((r) => [r.publicKey.toBase58(), r.account.modelId as string]));
  const items = (r: any) => Number(r.chunkCount) * 32;

  type Ev = { t: number; type: string; pk: string; msg: string };
  const evs: Ev[] = [];
  const push = (t: any, type: string, pk: PublicKey, msg: string) => {
    const n = Number(t ?? 0);
    if (n > 0) evs.push({ t: n, type, pk: pk.toBase58(), msg });
  };
  for (const b of banks) push(b.account.createdAt, "bank", b.publicKey, `bank created — ${b.account.name} [${BANK_KIND[b.account.kind as number] ?? "?"}]`);
  for (const r of runs) {
    const bank = bankName.get((r.account.benchmark as PublicKey).toBase58()) ?? r.account.benchmark.toBase58().slice(0, 10);
    push(r.account.createdAt, "run", r.publicKey, `run queued — ${r.account.modelId} on ${bank}`);
    push(r.account.finalizedAt, "score", r.publicKey, `MPC finalized — ${r.account.modelId} scored ${r.account.correct}/${items(r.account)} on ${bank}${r.account.postReveal ? " (post-reveal)" : ""}`);
  }
  for (const l of logs) {
    const runPk = (l.account.run as PublicKey).toBase58();
    push(l.account.recordedAt, "receipt", l.publicKey, `receipt minted — ${runModel.get(runPk) ?? "?"} ${l.account.correct}/${l.account.items}${l.account.vouchedAtRecord ? " [vouched]" : ""}${l.account.postReveal ? " [post-reveal]" : ""}`);
  }
  for (const rv of reveals) push(rv.account.revealedAt, "reveal", rv.publicKey, `fingerprint reveal — ${bankName.get((rv.account.benchmark as PublicKey).toBase58()) ?? "?"} part ${rv.account.part}`);
  for (const g of grants) push(g.account.sharedAt, "grant", g.publicKey, `access grant — ${bankName.get((g.account.benchmark as PublicKey).toBase58()) ?? "?"} part ${g.account.part} shared to ${String(g.account.viewer?.toBase58 ? g.account.viewer.toBase58() : g.account.viewer).slice(0, 12)}…`);
  for (const m of markets) {
    const duel = m.account.runB && !(m.account.runB as PublicKey).equals(PublicKey.default);
    push(m.account.createdAt, "venue", m.publicKey, `venue opened — ${duel ? "duel" : "band"} on ${runModel.get((m.account.run as PublicKey).toBase58()) ?? "?"}`);
    const rs = Number(m.account.resolvedScore);
    push(m.account.resolvedAt, "resolution", m.publicKey, `venue resolved — ${duel ? `duel ${rs >> 16}-${rs & 0xffff}` : `band outcome ${m.account.outcome} (score ${rs})`}`);
  }
  for (const d of darks) {
    push(d.account.createdAt, "venue", d.publicKey, `dark venue opened — ${runModel.get((d.account.run as PublicKey).toBase58()) ?? "?"}`);
    push(d.account.resolvedAt, "resolution", d.publicKey, `dark venue resolved${d.account.tallied ? " + tallied" : ""}`);
  }
  for (const l of ladders) {
    push(l.account.createdAt, "venue", l.publicKey, `ladder opened — ${l.account.legCount} legs`);
    push(l.account.resolvedAt, "resolution", l.publicKey, `ladder resolved — mask ${l.account.resultMask}`);
  }
  for (const b of bounties) {
    const claimed = !(b.account.winnerRun as PublicKey).equals(PublicKey.default);
    push(b.account.createdAt, "venue", b.publicKey, `bounty posted — ≥${b.account.threshold} pays ${(Number(b.account.amount) / 1e9).toFixed(3)}◎${claimed ? ` (claimed @${b.account.winningScore})` : ""}`);
  }
  const keep = typeFilter ? new Set(typeFilter.split(",").map((s) => s.trim())) : null;
  const filtered = evs.filter((e) => e.t >= since && (!keep || keep.has(e.type))).sort((a, b) => b.t - a.t).slice(0, limit);
  if (json) { console.log(JSON.stringify(filtered)); return filtered; }
  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`feed — ${filtered.length} event(s)${typeFilter ? ` [${typeFilter}]` : ""} newest first`);
  for (const e of filtered)
    console.log(`  ${fmt(e.t)}  ${e.type.padEnd(10)} ${e.pk.slice(0, 12)}…  ${e.msg}`);
  return filtered;
}

/** `chain gate --all <policy>` — the gate as a leaderboard filter: run the
 *  same admission policy over EVERY ModelRecord's receipts and report who
 *  clears it. "Which models provably clear ≥80% with ≥10 vouched runs?"
 *  is a one-line answer, not a leaderboard's word. */
export async function gateAll(policy: GatePolicy, json = false, snapPath?: string, bank?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [records, allLogs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all()]);
  // --bank scopes the leaderboard to one exam — pk or (possibly ambiguous) name.
  const bankPks = bank
    ? new Set((ss ? snapOf(ss, "Benchmark") : await acct().benchmark.all())
        .filter((b: any) => b.publicKey.toBase58() === bank || b.account.name === bank)
        .map((b: any) => b.publicKey.toBase58()))
    : null;
  if (bank && !bankPks!.size) throw new Error(`no benchmark named/addressed ${bank}`);
  const logs = bankPks ? allLogs.filter((l) => bankPks.has((l.account.benchmark as PublicKey).toBase58())) : allLogs;
  const byRec = new Map<string, any[]>();
  for (const l of logs) {
    const k = (l.account.modelRecord as PublicKey).toBase58();
    const list = byRec.get(k) ?? [];
    list.push(l.account);
    byRec.set(k, list);
  }
  const rows = records.map((r) => {
    const receipts: ScoreReceipt[] = (byRec.get(r.publicKey.toBase58()) ?? []).map((a: any) => ({
      correct: a.correct as number, items: a.items as number,
      vouchedAtRecord: a.vouchedAtRecord, postReveal: a.postReveal,
    }));
    return { record: r.publicKey.toBase58(), modelId: r.account.modelId as string, verdict: evalGate(receipts, policy, receipts.length > 0) };
  }).sort((a, b) => Number(b.verdict.pass) - Number(a.verdict.pass) || b.verdict.pct - a.verdict.pct);
  const passes = rows.filter((r) => r.verdict.pass).length;
  if (json) { console.log(JSON.stringify(rows.map((r) => ({ record: r.record, ...r.verdict, modelId: r.modelId })))); return rows; }
  const parts = [
    policy.minPct !== undefined && `pct≥${policy.minPct}`,
    policy.minRuns !== undefined && `runs≥${policy.minRuns}`,
    policy.minItems !== undefined && `items≥${policy.minItems}`,
    policy.minWilsonPct !== undefined && `wilson≥${policy.minWilsonPct}`,
    policy.vouchedOnly && "vouched",
    policy.noPostReveal && "no-post-reveal",
  ].filter(Boolean).join(" ");
  console.log(`gate --all [${parts}${bank ? ` bank=${bank}` : ""}] — ${passes}/${rows.length} model(s) clear:`);
  for (const r of rows) {
    const v = r.verdict;
    const tag = v.pass ? "PASS" : v.reason === "policy" ? "FAIL" : "NOEV";
    const miss = v.checks.find((c) => !c.pass);
    console.log(`  ${tag}  ${r.modelId.padEnd(36)} ${v.pct.toFixed(1).padStart(5)}% (${v.correct}/${v.items}) ${v.runs} ${v.scope} run(s)` +
      (miss ? `  ← ${miss.name}: ${miss.actual} < ${miss.needed}` : ""));
  }
  return rows;
}

/** `chain market board [--json]` — the keeper + discovery surface: scan the
 *  ledger's venues and report what a permissionless actor can do RIGHT NOW:
 *  claimable bounties (a qualifying run already finalized), resolvable
 *  markets/ladders, and expired venues awaiting the sweeps. Read-only. */
async function loadBoard(snapPath?: string) {
  let bounties: SnapAccount[], markets: SnapAccount[], darks: SnapAccount[],
      ladders: SnapAccount[], runs: SnapAccount[];
  if (snapPath) {
    const snap = loadSnapshotJson(snapPath);
    const sm = decodeSnapshotSection(snap, "market"), ss = decodeSnapshotSection(snap, "sealed");
    [bounties, markets, darks, ladders, runs] =
      [snapOf(sm, "Bounty"), snapOf(sm, "Market"), snapOf(sm, "DarkMarket"), snapOf(sm, "Ladder"), snapOf(ss, "Run")];
  } else {
    const { market } = marketProgram();
    const { program } = sealedProgram();
    const mAcct = market.account as any;
    [bounties, markets, darks, ladders, runs] = await Promise.all([
      mAcct.bounty.all(), mAcct.market.all(), mAcct.darkMarket.all(),
      mAcct.ladder.all(), (program.account as any).run.all(),
    ]);
  }
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const now = Math.floor(Date.now() / 1000);
  const board = classifyBoard({
    bounties: bounties.map((x: any) => ({
      pubkey: x.publicKey.toBase58(), sponsor: x.account.sponsor.toBase58(),
      bank: x.account.bank.toBase58(), status: x.account.status,
      threshold: num(x.account.threshold), amount: num(x.account.amount),
      createdAt: num(x.account.createdAt), deadline: num(x.account.deadline),
      winnerRun: x.account.winnerRun?.toBase58(), winningScore: num(x.account.winningScore),
    })),
    markets: [
      ...markets.map((x: any) => ({
        pubkey: x.publicKey.toBase58(), kind: isDuel(x.account) ? "duel" as const : "band" as const,
        status: x.account.status, run: x.account.run.toBase58(), runB: x.account.runB?.toBase58(),
        resolveBy: num(x.account.resolveBy),
      })),
      ...darks.map((x: any) => ({
        pubkey: x.publicKey.toBase58(), kind: "dark" as const, status: x.account.status,
        run: x.account.run.toBase58(), resolveBy: num(x.account.resolveBy),
        revealUntil: num(x.account.revealUntil), tallied: !!x.account.tallied,
      })),
    ],
    ladders: ladders.map((x: any) => ({
      pubkey: x.publicKey.toBase58(), status: x.account.status,
      legs: (x.account.legs as PublicKey[]).slice(0, x.account.legCount).map((p) => p.toBase58()),
      resolveBy: num(x.account.resolveBy),
    })),
    runs: runs.map((x: any) => ({
      pubkey: x.publicKey.toBase58(), benchmark: x.account.benchmark.toBase58(),
      runner: x.account.runner.toBase58(), status: x.account.status,
      correct: num(x.account.correct), createdAt: num(x.account.createdAt),
      firstPendingAt: num(x.account.firstPendingAt),
      allQueuedAt: num(x.account.allQueuedAt),
      scoredMask: x.account.scoredMask.toString(),
      postReveal: x.account.postReveal,
    })),
  }, now);
  return { board, counts: { bounties: bounties.length, markets: markets.length, darks: darks.length, ladders: ladders.length, runs: runs.length } };
}

export async function marketBoard(json = false, snapPath?: string) {
  const { board, counts } = await loadBoard(snapPath);
  if (json) { console.log(JSON.stringify(board)); return board; }
  const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(3);
  console.log(`venue board — ${counts.bounties} bounties, ${counts.markets} markets, ${counts.darks} dark, ${counts.ladders} ladders over ${counts.runs} runs`);
  if (board.claimable.length) {
    console.log(`\nCLAIMABLE NOW — qualifying run already finalized:`);
    for (const b of board.claimable)
      console.log(`  bounty ${b.pubkey} ≥${b.threshold} pot=${sol(b.amount)} SOL → ${b.qualifyingRun} scored ${b.qualifyingScore}\n` +
        `    sealed chain market bounty claim --bounty ${b.pubkey} --run ${b.qualifyingRun}`);
  }
  if (board.resolvable.length || board.resolvableLadders.length) {
    console.log(`\nRESOLVABLE — run finalized / no leg still moving:`);
    for (const m of board.resolvable) console.log(`  ${m.kind} ${m.pubkey} → sealed chain market ${m.kind === "dark" ? "dark " : ""}resolve --market ${m.pubkey}`);
    for (const l of board.resolvableLadders) console.log(`  ladder ${l.pubkey} → sealed chain market ladder resolve --market ${l.pubkey}`);
  }
  if (board.tallyable.length) {
    console.log(`\nTALLYABLE — reveal window closed, tally open:`);
    for (const m of board.tallyable) console.log(`  dark ${m.pubkey} → sealed chain market dark finalize --market ${m.pubkey}`);
  }
  if (board.expiredBounties.length || board.expirable.length) {
    console.log(`\nSWEEPABLE — past deadline (permissionless):`);
    for (const b of board.expiredBounties) console.log(`  bounty ${b.pubkey} pot=${sol(b.amount)} SOL → sealed chain market bounty expire --bounty ${b.pubkey}`);
    for (const m of board.expirable) console.log(`  ${m.kind} ${m.pubkey} (${m.expireOutcome}) → sealed chain market ${m.kind === "dark" ? "dark " : ""}expire --market ${m.pubkey}`);
  }
  console.log(`\nstill live: ${board.liveBounties.length} bounties, ${board.filling} venues in play, ${board.revealing} darks revealing — settled: ${board.settled} venues, ${board.claimedBounties} claimed bounties`);
  return board;
}

/** The no-operator design made executable: scan the board, then EXECUTE
 *  every permissionless action it lists — bounty claims (the pot pays the
 *  winning run's operator on-chain, not the sweeper — pure public good),
 *  venue resolves, dark finalizes, and expiry sweeps. A raced keeper's tx
 *  fails on the already-transitioned account and the sweep continues. */
export async function marketSweep(kpPath?: string, watchSecs = 0) {
  for (;;) {
    await sweepOnce(kpPath);
    if (!watchSecs) return;
    await new Promise((r) => setTimeout(r, watchSecs * 1000));
  }
}

async function sweepOnce(kpPath?: string) {
  const { board } = await loadBoard();
  const total = board.claimable.length + board.resolvable.length +
    board.resolvableLadders.length + board.tallyable.length +
    board.expirable.length + board.expiredBounties.length;
  const stamp = new Date().toISOString().slice(11, 19);
  if (!total) { console.log(`${stamp} market sweep — nothing actionable`); return; }
  console.log(`${stamp} market sweep — ${total} permissionless actions queued`);
  const act = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); }
    catch (e: any) {
      console.log(`  ${what}: skipped (${e?.error?.errorMessage ?? e?.errorMessage ?? e?.message ?? e})`);
    }
  };
  for (const b of board.claimable)
    await act(`bounty claim ${b.pubkey} → pays operator of ${b.qualifyingRun}`,
      () => bountyClaim(new PublicKey(b.pubkey), new PublicKey(b.qualifyingRun), kpPath));
  for (const m of board.resolvable)
    await act(`${m.kind} resolve ${m.pubkey}`, () => m.kind === "dark"
      ? darkResolve(new PublicKey(m.pubkey), kpPath)
      : marketResolve(new PublicKey(m.pubkey), kpPath));
  for (const l of board.resolvableLadders)
    await act(`ladder resolve ${l.pubkey}`,
      () => ladderResolve(new PublicKey(l.pubkey), kpPath));
  for (const m of board.tallyable)
    await act(`dark finalize ${m.pubkey}`,
      () => darkFinalize(new PublicKey(m.pubkey), kpPath));
  for (const m of board.expirable)
    await act(`${m.kind} expire ${m.pubkey} (${m.expireOutcome})`, () => m.kind === "dark"
      ? darkExpire(new PublicKey(m.pubkey), kpPath)
      : marketExpire(new PublicKey(m.pubkey), kpPath));
  for (const b of board.expiredBounties)
    await act(`bounty expire ${b.pubkey} → refunds sponsor`,
      () => bountyExpire(new PublicKey(b.pubkey), kpPath));
}

/** `chain market positions` — the bettor-side mirror of the keeper board:
 *  every position the signing wallet holds, across bands/duels/ladders/
 *  darks, classified as payable / refundable / lost-rent / live. A bettor
 *  shouldn't need to track market PDAs to find their money. */
export async function marketPositions(kpPath?: string, json = false, snapPath?: string, viewerStr?: string) {
  let me: string;
  if (viewerStr) me = new PublicKey(viewerStr).toBase58();
  else me = marketProgram(kpPath).kp.publicKey.toBase58();
  let markets: SnapAccount[], ladders: SnapAccount[], darks: SnapAccount[],
      positions: SnapAccount[], darkPositions: SnapAccount[];
  if (snapPath) {
    const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
    [markets, ladders, darks, positions, darkPositions] =
      [snapOf(sm, "Market"), snapOf(sm, "Ladder"), snapOf(sm, "DarkMarket"), snapOf(sm, "Position"), snapOf(sm, "DarkPosition")];
  } else {
    const { market } = marketProgram(kpPath);
    const mAcct = market.account as any;
    [markets, ladders, darks, positions, darkPositions] = await Promise.all([
      mAcct.market.all(), mAcct.ladder.all(), mAcct.darkMarket.all(),
      mAcct.position.all(), mAcct.darkPosition.all(),
    ]);
  }
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const mk: Map<string, any> = new Map(markets.map((x: any) => [x.publicKey.toBase58(), { pk: x.publicKey.toBase58(), kind: isDuel(x.account) ? "duel" : "band", status: x.account.status as number, outcome: x.account.outcome as number, totals: (x.account.totals as any[]).map((t) => BigInt(t.toString())), feeBps: num(x.account.feeBps) }]));
  const lk: Map<string, any> = new Map(ladders.map((x: any) => [x.publicKey.toBase58(), { pk: x.publicKey.toBase58(), kind: "ladder", status: x.account.status as number, mask: x.account.resultMask as number, totals: (x.account.totals as any[]).map((t) => BigInt(t.toString())), feeBps: num(x.account.feeBps) }]));
  const dk: Map<string, any> = new Map(darks.map((x: any) => [x.publicKey.toBase58(), { pk: x.publicKey.toBase58(), kind: "dark", status: x.account.status as number, outcome: x.account.outcome as number, poolTotal: BigInt(x.account.poolTotal.toString()), winTotal: BigInt(x.account.winTotal.toString()), feeBps: num(x.account.feeBps), tallied: !!x.account.tallied }]));

  type Row = { pk: string; kind: string; state: "payable" | "refund" | "lost" | "live" | "sealed" | "forfeit"; staked: bigint; est: bigint; note: string };
  const rows: Row[] = [];
  const sol = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);
  const netOf = (totals: bigint[], feeBps: number) => {
    const pot = totals.reduce((s, t) => s + t, 0n);
    return pot - (pot * BigInt(feeBps)) / 10000n;
  };
  for (const p of positions) {
    if (p.account.bettor.toBase58() !== me) continue;
    const amounts = (p.account.amounts as any[]).map((a) => BigInt(a.toString()));
    const staked = amounts.reduce((s, a) => s + a, 0n);
    const venuePk = p.account.market.toBase58();
    const v = mk.get(venuePk) ?? lk.get(venuePk);
    if (!v) continue;
    if (v.status === 2) { rows.push({ pk: venuePk, kind: v.kind, state: "refund", staked, est: staked, note: "cancelled — gross refund" }); continue; }
    if (v.status !== 1) { rows.push({ pk: venuePk, kind: v.kind, state: "live", staked, est: 0n, note: "open — in play" }); continue; }
    if (v.kind === "ladder") {
      const mask = (v as any).mask as number;
      const won = amounts.reduce((s, a, i) => s + ((mask & (1 << i)) ? a : 0n), 0n);
      const winTotal = (v as any).totals.reduce((s: bigint, t: bigint, i: number) => s + ((mask & (1 << i)) ? t : 0n), 0n);
      const est = won > 0n && winTotal > 0n ? (won * netOf((v as any).totals, v.feeBps)) / winTotal : 0n;
      rows.push({ pk: venuePk, kind: "ladder", state: won > 0n ? "payable" : "lost", staked: won > 0n ? won : staked, est, note: won > 0n ? `mask 0b${mask.toString(2)} — pro-rata` : "resolved against you — claim returns rent" });
    } else {
      const won = amounts[(v as any).outcome] ?? 0n;
      const winTotal = (v as any).totals[(v as any).outcome] ?? 0n;
      const est = won > 0n && winTotal > 0n ? (won * netOf((v as any).totals, v.feeBps)) / winTotal : 0n;
      rows.push({ pk: venuePk, kind: v.kind, state: won > 0n ? "payable" : "lost", staked: won > 0n ? won : staked, est, note: won > 0n ? `outcome ${(v as any).outcome} — pro-rata` : "resolved against you — claim returns rent" });
    }
  }
  for (const p of darkPositions) {
    if (p.account.bettor.toBase58() !== me) continue;
    const amount = BigInt(p.account.amount.toString());
    const revealed = p.account.revealed as number;
    const venuePk = p.account.market.toBase58();
    const v = dk.get(venuePk);
    if (!v) continue;
    if (v.status === 2) { rows.push({ pk: venuePk, kind: "dark", state: "refund", staked: amount, est: amount, note: "cancelled — gross refund" }); continue; }
    if (v.status === 0) { rows.push({ pk: venuePk, kind: "dark", state: "sealed", staked: amount, est: 0n, note: "position still sealed" }); continue; }
    if (!v.tallied) { rows.push({ pk: venuePk, kind: "dark", state: "live", staked: amount, est: 0n, note: revealed === 255 ? "resolved — reveal or forfeit" : "resolved — awaiting tally" }); continue; }
    if (revealed === 255) { rows.push({ pk: venuePk, kind: "dark", state: "forfeit", staked: amount, est: 0n, note: "never revealed — forfeited into the pot" }); continue; }
    if (revealed !== v.outcome || v.winTotal === 0n) { rows.push({ pk: venuePk, kind: "dark", state: "lost", staked: amount, est: 0n, note: `revealed ${revealed}, outcome ${v.outcome} — claim returns rent` }); continue; }
    const est = (amount * (v.poolTotal - (v.poolTotal * BigInt(v.feeBps)) / 10000n)) / v.winTotal;
    rows.push({ pk: venuePk, kind: "dark", state: "payable", staked: amount, est, note: `revealed winner — pro-rata of ${sol(v.poolTotal)} SOL pool` });
  }
  if (json) { console.log(JSON.stringify(rows, (k, x) => typeof x === "bigint" ? x.toString() : x)); return rows; }
  const order = { payable: 0, refund: 1, live: 2, sealed: 3, lost: 4, forfeit: 5 } as const;
  rows.sort((a, b) => order[a.state] - order[b.state]);
  console.log(`positions — ${rows.length} held by ${me.slice(0, 8)}… across ${mk.size + lk.size + dk.size} venues`);
  for (const r of rows) {
    const tag = { payable: "PAYS", refund: "REFUND", live: "LIVE", sealed: "SEALED", lost: "RENT", forfeit: "FORFEIT" }[r.state];
    console.log(`  ${tag.padEnd(7)} ${r.kind.padEnd(6)} ${r.pk}  staked ${sol(r.staked)}${r.est > 0n ? ` → ~${sol(r.est)}` : ""} SOL  ${r.note}`);
  }
  const due = rows.filter((r) => r.state === "payable" || r.state === "refund");
  if (due.length) {
    console.log(`\nclaim now (${due.length}):`);
    for (const r of due) console.log(`  sealed chain market ${r.kind === "ladder" ? "ladder claim" : r.kind === "dark" ? "dark claim --pos-salt <your-salt>" : "claim"} --market ${r.pk}${r.kind === "dark" ? "  # pos_salt is a seed — use the value from your bet" : ""}`);
  }
  return rows;
}

/** `chain history <model_id|record-pk>` — the capability trajectory: every
 *  ScoreLog receipt for a model, oldest first, with the running accuracy
 *  after each run. "Did it regress after the fine-tune?" is an on-chain
 *  question — vouched and post-reveal flags ride on every row. */
export async function chainHistory(keyOrName: string, json = false, snapPath?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  let pda: PublicKey;
  try {
    pda = new PublicKey(keyOrName);
  } catch {
    const h = createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest();
    [pda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), h], sealedProgramId());
  }
  const rec: any = ss
    ? snapOf(ss, "ModelRecord").find((x) => x.publicKey.equals(pda))?.account
    : await acct().modelRecord.fetchNullable(pda);
  if (!rec) {
    console.log(`no model record for ${keyOrName} (${pda.toBase58()})`);
    process.exitCode = 2;
    return [];
  }
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const logs = (ss ? snapOf(ss, "ScoreLog") : await acct().scoreLog.all())
    .filter((l: any) => (l.account.modelRecord as PublicKey).equals(pda))
    .map((l: any) => ({
      run: (l.account.run as PublicKey).toBase58(),
      benchmark: (l.account.benchmark as PublicKey).toBase58(),
      recordedAt: num(l.account.recordedAt),
      correct: l.account.correct as number,
      items: l.account.items as number,
      vouched: l.account.vouchedAtRecord as number,
      postReveal: l.account.postReveal as number,
    }))
    .sort((a: { recordedAt: number }, b: { recordedAt: number }) => a.recordedAt - b.recordedAt);
  if (json) { console.log(JSON.stringify({ record: pda.toBase58(), modelId: rec.modelId, logs })); return logs; }
  console.log(`history — ${rec.modelId} (${pda.toBase58()}) · ${logs.length} receipt(s)`);
  let c = 0, i = 0;
  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  for (const l of logs) {
    c += l.correct; i += l.items;
    console.log(`  ${fmt(l.recordedAt)}  ${l.run.slice(0, 12)}…  ${l.correct}/${l.items} (${(100 * l.correct / Math.max(1, l.items)).toFixed(1)}%)` +
      `  running ${(100 * c / Math.max(1, i)).toFixed(1)}%${l.vouched ? "  vouched" : ""}${l.postReveal ? "  post-reveal" : ""}`);
  }
  return logs;
}

export async function chainMain(cmd: string[], args: Args) {
  const loadJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  // `export SEALED_SNAPSHOT=web/snapshot.json` makes every read command
  // replay the evidence bundle without repeating the flag.
  if (!args.snapshot && process.env.SEALED_SNAPSHOT) args.snapshot = process.env.SEALED_SNAPSHOT;
  const [sub] = cmd;
  if (sub === "init") {
    await init();
    return;
  }
  if (sub === "init-signer") {
    // Standalone un-brick: drains any grief-prefund and creates the shared
    // signer PDA — same ix `chain init` calls eagerly.
    const { program, provider, wallet } = setup();
    const [signPda] = PublicKey.findProgramAddressSync([Buffer.from("ArciumSignerAccount")], program.programId);
    const sig = await program.methods
      .initSignerPda()
      .accounts({ payer: wallet.publicKey, signPdaAccount: signPda })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    console.log(`init_signer_pda ${signPda.toBase58()} (${sig})`);
    return;
  }
  if (sub === "unbrick") {
    await unbrickPda(cmd.slice(1));
    return;
  }
  if (sub === "reset-sealing") {
    await resetSealing(Number(args["bank-id"]), Number(args.chunk));
    return;
  }
  if (sub === "reset-pending") {
    await resetPending(new PublicKey(String(args.run)), Number(args.chunk));
    return;
  }
  if (sub === "seal") {
    const bank = loadJson(String(args.bank)) as Bank;
    const fee = BigInt(String(args["fee-lamports"] ?? 0));
    await seal(bank, fee);
    return;
  }
  if (sub === "gen") {
    const id = Number(args.id);
    if (!Number.isFinite(id)) throw new Error("--id <n>");
    const chunks = Number(args.chunks ?? 2);
    const fee = BigInt(String(args["fee-lamports"] ?? 0));
    const { bank } = await gen(id, chunks, fee);
    const out = String(args.out ?? join("bank", `gen-${id}.json`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(bank, null, 2) + "\n");
    console.log(`wrote ${out}`);
    return;
  }
  if (sub === "items") {
    const bpk = new PublicKey(String(args.benchmark));
    let bank: Bank, b: any;
    if (args.snapshot) {
      // Offline replay: pull the raw ItemChunk bytes out of the committed
      // bundle, re-derive their PDAs, and re-fold items_root — keyless.
      const snap = loadSnapshotJson(String(args.snapshot));
      const ss = decodeSnapshotSection(snap, "sealed");
      const bx = snapOf(ss, "Benchmark").find((x) => x.publicKey.equals(bpk));
      if (!bx) throw new Error(`benchmark ${bpk.toBase58()} not in snapshot`);
      b = bx.account;
      if (b.kind !== 1) throw new Error(`benchmark ${bpk.toBase58()} is not a generated bank`);
      const rawByPk = new Map<string, Buffer>(
        (snap.sealed ?? []).map((e: any) => [e.pubkey, Buffer.from(e.data, "base64")]));
      const pd = pdas({ program: { programId: sealedProgramId() } } as Ctx, b.authority, b.id);
      const chunks: ItemChunkState[] = [];
      for (let i = 0; i < Number(b.chunkCount); i++) {
        const data = rawByPk.get(pd.items(i).toBase58());
        if (!data) throw new Error(`ItemChunk ${i} missing from snapshot — bank not fully minted`);
        chunks.push(decodeItemChunk(data));
      }
      bank = bankFromChunks(Number(b.id), chunks);
      const onchain = Buffer.from(b.itemsRoot).toString("hex");
      if (Number(b.status) === 1 && bank.itemsRoot !== onchain)
        throw new Error(`items_root mismatch: local fold ${bank.itemsRoot} != on-chain ${onchain}`);
    } else {
      const ctx = setup();
      const acct = ctx.program.account as any;
      b = await acct.benchmark.fetch(bpk);
      bank = await fetchGenBank(bpk, b.chunkCount, ctx);
    }
    const out = String(args.out ?? join("bank", `gen-${b.id}.json`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(bank, null, 2) + "\n");
    console.log(`wrote ${out} (${bank.items.length} items)`);
    return;
  }
  if (sub === "gen-private") {
    const id = Number(args.id);
    if (!Number.isFinite(id)) throw new Error("--id <n>");
    const chunks = Number(args.chunks ?? 2);
    const fee = BigInt(String(args["fee-lamports"] ?? 0));
    const { bank } = await genPrivate(id, chunks, fee);
    const out = String(args.out ?? join("bank", `pgen-${id}.json`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(bank, null, 2) + "\n");
    console.log(`wrote ${out} — KEEP IT PRIVATE: this file contains decrypted items`);
    return;
  }
  if (sub === "pitems") {
    const ctx = setup();
    const acct = ctx.program.account as any;
    const b: any = await acct.benchmark.fetch(new PublicKey(String(args.benchmark)));
    const bank = await fetchPrivBank(new PublicKey(String(args.benchmark)), b.chunkCount, ctx);
    const out = String(args.out ?? join("bank", `pgen-${b.id}.json`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(bank, null, 2) + "\n");
    console.log(`wrote ${out} (${bank.items.length} items) — KEEP IT PRIVATE`);
    return;
  }
  if (sub === "reshare") {
    // Delegate a private bank's questions to a second key (judge, runner, panel).
    const to = args.to ? new PublicKey(String(args.to)) : undefined;
    if (!to) throw new Error("--to <solana-pubkey>");
    if (typeof args.chunk !== "string" || typeof args.part !== "string" || !args.chunk || !args.part
      || !Number.isInteger(Number(args.chunk)) || !Number.isInteger(Number(args.part))
      || Number(args.part) < 0 || Number(args.part) > 3)
      throw new Error("reshare needs --chunk <i> and --part <0..3>");
    await resharePart(new PublicKey(String(args.benchmark)), Number(args.chunk), Number(args.part), to);
    return;
  }
  if (sub === "grant") {
    // Fetch + decrypt a ShareGrant addressed to the local wallet.
    if (typeof args.chunk !== "string" || typeof args.part !== "string" || !args.chunk || !args.part
      || !Number.isInteger(Number(args.chunk)) || !Number.isInteger(Number(args.part))
      || Number(args.part) < 0 || Number(args.part) > 3)
      throw new Error("grant needs --chunk <i> and --part <0..3>");
    const g = await fetchGrant(new PublicKey(String(args.benchmark)), Number(args.chunk), Number(args.part));
    console.log(`grant ${g.grant.toBase58()} shared_at=${g.sharedAt}`);
    for (const [i, s] of g.specs.entries()) console.log(`  item ${i}: ${renderPrompt(s)}`);
    return;
  }
  if (sub === "grants") {
    const bankPk = new PublicKey(String(args.benchmark));
    if (args.snapshot) {
      const ss = decodeSnapshotSection(loadSnapshotJson(String(args.snapshot)), "sealed");
      const gs = snapOf(ss, "ShareGrant").filter((g) => (g.account.benchmark as PublicKey).equals(bankPk));
      if (!gs.length) console.log("no grants");
      for (const g of gs) {
        const a = g.account as any;
        console.log(`chunk ${a.chunkIndex} part ${a.part} → viewer ${Buffer.from(a.viewer).toString("hex").slice(0, 16)}… at ${a.sharedAt} (${g.publicKey.toBase58()})`);
      }
      return;
    }
    const list = await listGrants(bankPk);
    if (!list.length) console.log("no grants");
    for (const g of list) console.log(`chunk ${g.chunkIndex} part ${g.part} → viewer ${g.viewer.slice(0, 16)}… at ${g.sharedAt} (${g.address.toBase58()})`);
    return;
  }
  if (sub === "reveals") {
    const bankPk = new PublicKey(String(args.benchmark));
    if (args.snapshot) {
      const ss = decodeSnapshotSection(loadSnapshotJson(String(args.snapshot)), "sealed");
      const rs = snapOf(ss, "Reveal")
        .filter((r) => (r.account.benchmark as PublicKey).equals(bankPk))
        .sort((x, y) => Number(x.account.chunkIndex) - Number(y.account.chunkIndex) || Number(x.account.part) - Number(y.account.part));
      if (!rs.length) console.log("no reveals — the bank's answers are still fully sealed");
      for (const r of rs) {
        const a = r.account as any;
        const hashes: any[] = Array.from(a.hashes ?? []);
        console.log(`chunk ${a.chunkIndex} part ${a.part} — ${hashes.length} fingerprint(s) declassified @ ${a.revealedAt}` +
          `  ${hashes.slice(0, 3).map((h: any) => Buffer.from(h).toString("hex").slice(0, 8)).join(" ")}…  (${r.publicKey.toBase58()})`);
      }
      if (rs.length) console.log(`⚠ ${rs.length} revealed part(s) — runs committed after these timestamps stamp post_reveal; markets refuse to open on them`);
      return;
    }
    const ctx = setup();
    const rs: any[] = await (ctx.program.account as any).reveal.all([{ memcmp: { offset: 8, bytes: bankPk.toBase58() } }]);
    if (!rs.length) console.log("no reveals — the bank's answers are still fully sealed");
    for (const r of rs) {
      const a = r.account as any;
      const hashes: any[] = Array.from(a.hashes ?? []);
      console.log(`chunk ${a.chunkIndex} part ${a.part} — ${hashes.length} fingerprint(s) declassified @ ${a.revealedAt}` +
        `  ${hashes.slice(0, 3).map((h: any) => Buffer.from(h).toString("hex").slice(0, 8)).join(" ")}…  (${r.publicKey.toBase58()})`);
    }
    return;
  }
  if (sub === "delegate-bank") {
    // Rebuild a private bank entirely from this wallet's ShareGrants — the
    // delegated-runner path: questions decrypted locally, never on chain.
    const bank = await delegateBank(new PublicKey(String(args.benchmark)));
    const out = String(args.out ?? join("bank", `delegate-${bank.benchmarkId}.json`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(bank, null, 2) + "\n");
    console.log(`wrote ${out} (${bank.items.length} items) — reconstructed from grants, KEEP PRIVATE`);
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
  if (sub === "reveal") {
    if (typeof args.chunk !== "string" || typeof args.part !== "string" || !args.chunk || !args.part
      || !Number.isInteger(Number(args.chunk)) || !Number.isInteger(Number(args.part))
      || Number(args.part) < 0 || Number(args.part) > 3)
      throw new Error("reveal needs --chunk <i> and --part <0..3> (each part is its own PDA — a missing/empty flag does NOT mean all parts)");
    await revealPart(new PublicKey(String(args.benchmark)), Number(args.chunk), Number(args.part));
    return;
  }
  if (sub === "verify") {
    const run = loadJson(String(args.run)) as RunArtifact;
    const idx = args["run-index"] !== undefined ? BigInt(String(args["run-index"])) : undefined;
    await verifyRun(new PublicKey(String(args.benchmark)), run, idx, undefined,
      args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "status") {
    await status(new PublicKey(String(args.benchmark)), undefined,
      args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json));
    return;
  }
  if (sub === "attest") {
    await attestRun(new PublicKey(String(args.run)));
    return;
  }
  if (sub === "record") {
    if (args.all) {
      const watch = Number(args.watch ?? 0) || 0;
      for (;;) {
        await recordAllScores();
        if (!watch) return;
        await new Promise((r) => setTimeout(r, watch * 1000));
      }
    }
    if (!args.run) throw new Error("usage: chain record --run <pubkey> | --all");
    await recordScore(new PublicKey(String(args.run)));
    return;
  }
  if (sub === "modelrec") {
    await modelRecordShow(String(cmd[1] ?? args.run ?? ""), args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json));
    return;
  }
  if (sub === "records") {
    await modelRecordList(args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json));
    return;
  }
  if (sub === "bank") {
    await bankShow(String(cmd[1] ?? ""), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "banks") {
    await bankList(args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json),
      args.kind ? String(args.kind) : undefined);
    return;
  }
  if (sub === "stats") {
    await chainStats(args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json));
    return;
  }
  if (sub === "feed") {
    await chainFeed(Number(args.limit ?? 40), args.type ? String(args.type) : undefined,
      Number(args.since ?? 0), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "export") {
    // No --snapshot → digest the live cluster (source: "live").
    await chainExport(args.snapshot ? String(args.snapshot) : undefined, args.out ? String(args.out) : undefined);
    return;
  }
  if (sub === "runs") {
    await runList({
      snapPath: args.snapshot ? String(args.snapshot) : undefined, json: Boolean(args.json),
      bank: args.bank ? String(args.bank) : undefined, model: args.model ? String(args.model) : undefined,
      minPct: args["min-pct"] !== undefined ? Number(args["min-pct"]) : undefined,
      status: args.status ? String(args.status) : undefined,
    });
    return;
  }
  if (sub === "gate") {
    const numF = (k: string) => {
      const v = args[k];
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`);
      return n;
    };
    if (cmd[1] === "--all" || args.all) {
      const policy: GatePolicy = {
        minPct: numF("min-pct"), minRuns: numF("min-runs"), minItems: numF("min-items"),
        minWilsonPct: numF("wilson"), vouchedOnly: Boolean(args.vouched),
        noPostReveal: Boolean(args["no-post-reveal"]),
      };
      if (policy.minPct === undefined && policy.minRuns === undefined &&
          policy.minItems === undefined && policy.minWilsonPct === undefined)
        throw new Error("a gate needs a criterion: --min-pct/--min-runs/--min-items/--wilson");
      await gateAll(policy, Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined,
        args.bank ? String(args.bank) : undefined);
      return;
    }
    const target = String(cmd[1] ?? args.model ?? args.run ?? "");
    if (!target) throw new Error("usage: chain gate <model_id|record-pk> [--min-pct N] [--min-runs N] [--min-items N] [--wilson N] [--vouched] [--no-post-reveal] [--json]");
    const num = (k: string) => {
      const v = args[k];
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`);
      return n;
    };
    const policy: GatePolicy = {
      minPct: num("min-pct"),
      minRuns: num("min-runs"),
      minItems: num("min-items"),
      minWilsonPct: num("wilson"),
      vouchedOnly: Boolean(args.vouched),
      noPostReveal: Boolean(args["no-post-reveal"]),
    };
    if (policy.minPct === undefined && policy.minRuns === undefined &&
        policy.minItems === undefined && policy.minWilsonPct === undefined)
      throw new Error("a gate needs a criterion: --min-pct/--min-runs/--min-items/--wilson");
    await gateModelRecord(target, policy, Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined,
      args.bank ? String(args.bank) : undefined);
    return;
  }
  if (sub === "history") {
    const target = String(cmd[1] ?? args.model ?? "");
    if (!target) throw new Error("usage: chain history <model_id|record-pk> [--json]");
    await chainHistory(target, Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "trail") {
    const run = cmd[1] ?? args.run;
    if (!run) throw new Error("usage: chain trail <run-pk> [--json] [--snapshot f]");
    await chainTrail(String(run), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "compare") {
    if (cmd[1] === "--all" || args.all) {
      await compareAll(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined, Number(args["min-shared"] ?? 1) || 1);
      return;
    }
    const a = cmd[1], b = cmd[2];
    if (!a || !b) throw new Error("usage: chain compare <model_id|record-pk> <model_id|record-pk> [--all] [--json] [--snapshot f]");
    await modelCompare(String(a), String(b), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "market") {
    const [m0] = cmd.slice(1);
    const bettor = args.bettor as string | undefined;
    if (m0 === "board") {
      await marketBoard(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "sweep") {
      await marketSweep(bettor, Number(args.watch ?? 0) || 0);
    } else if (m0 === "bounties") {
      await bountyList(args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json));
    } else if (m0 === "venue") {
      await marketVenue(String(cmd[2] ?? ""), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "positions") {
      await marketPositions(bettor, Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined,
        args.viewer ? String(args.viewer) : undefined);
    } else if (m0 === "open") {
      const run = new PublicKey(String(args.run));
      // --edges "40,55" = 3-way buckets; --threshold n = binary >= n.
      const edges = args.edges ? String(args.edges).split(",").map(Number) : [Number(args.threshold)];
      if (edges.some((e) => !Number.isFinite(e))) throw new Error("--edges 40,55[,64..] or --threshold n");
      await marketOpen(run, edges, BigInt(String(args.salt ?? "0")), timing(args), bettor);
    } else if (m0 === "duel") {
      // Head-to-head: does run A outscore run B on the same benchmark?
      await marketOpenDuel(new PublicKey(String(args["run-a"])), new PublicKey(String(args["run-b"])), BigInt(String(args.salt ?? "0")), timing(args), bettor);
    } else if (m0 === "bet") {
      const marketPk = new PublicKey(String(args.market));
      // --outcome i is canonical; --side yes|no maps onto binary markets (no=0, yes=1).
      let outcome = args.outcome !== undefined ? Number(args.outcome) : -1;
      if (outcome < 0) {
        const side = String(args.side);
        if (side !== "yes" && side !== "no") throw new Error("--outcome <i> or --side yes|no");
        outcome = side === "yes" ? 1 : 0;
      }
      await marketBet(marketPk, outcome, BigInt(String(args.lamports)), bettor);
    } else if (m0 === "resolve") {
      await marketResolve(new PublicKey(String(args.market)), bettor);
    } else if (m0 === "claim") {
      await marketClaim(new PublicKey(String(args.market)), bettor);
    } else if (m0 === "void") {
      await marketVoid(new PublicKey(String(args.market)), bettor);
    } else if (m0 === "expire") {
      await marketExpire(new PublicKey(String(args.market)), bettor);
    } else if (m0 === "claim-fee") {
      await marketClaimFee(new PublicKey(String(args.market)), bettor);
    } else if (m0 === "ladder") {
      const [m1] = cmd.slice(2);
      if (m1 === "open") {
        // --legs pk1,pk2,... (3..=8 pending runs, distinct runners, same bank — pairs are duels)
        const legs = String(args.legs).split(",").map((s) => new PublicKey(s.trim()));
        if (legs.length < 3) throw new Error("--legs <pk,pk,...> needs at least 3 runs (use `market duel` for pairs)");
        await ladderOpen(legs, BigInt(String(args.salt ?? "0")), timing(args), bettor);
      } else if (m1 === "bet") {
        const ladderPk = new PublicKey(String(args.market));
        const outcome = Number(args.outcome);
        if (!Number.isFinite(outcome)) throw new Error("--outcome <i> — the leg index");
        await ladderBet(ladderPk, outcome, BigInt(String(args.lamports)), bettor);
      } else if (m1 === "resolve") {
        await ladderResolve(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "claim") {
        await ladderClaim(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "void") {
        await ladderVoid(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "claim-fee") {
        await ladderClaimFee(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "show") {
        await ladderShow(new PublicKey(String(args.market)));
      } else throw new Error(`unknown ladder command: ${m1}`);
    } else if (m0 === "dark") {
      const [m1] = cmd.slice(2);
      if (m1 === "open") {
        // --edges "40,55" or --threshold n — same buckets as `market open`.
        const run = new PublicKey(String(args.run));
        const edges = args.edges ? String(args.edges).split(",").map(Number) : [Number(args.threshold)];
        if (edges.some((e) => !Number.isFinite(e))) throw new Error("--edges 40,55[,64..] or --threshold n");
        await darkOpen(run, edges, BigInt(String(args.salt ?? "0")), timing(args), bettor);
      } else if (m1 === "bet") {
        // Sealed position: --outcome stays OFF the wire; the preimage it
        // prints (pos-salt + outcome + salt) is the only way to reveal.
        const marketPk = new PublicKey(String(args.market));
        const outcome = Number(args.outcome);
        if (!Number.isFinite(outcome)) throw new Error("--outcome <i> — stays hidden inside the commitment");
        await darkBet(marketPk, outcome, BigInt(String(args.lamports)), BigInt(String(args["pos-salt"] ?? "0")), bettor);
      } else if (m1 === "resolve") {
        await darkResolve(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "reveal") {
        const outcome = Number(args.outcome);
        if (!Number.isFinite(outcome)) throw new Error("--outcome <i> --salt <hex> --pos-salt <n>");
        await darkReveal(new PublicKey(String(args.market)), BigInt(String(args["pos-salt"] ?? "0")), outcome, String(args.salt), bettor);
      } else if (m1 === "finalize") {
        await darkFinalize(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "claim") {
        await darkClaim(new PublicKey(String(args.market)), BigInt(String(args["pos-salt"] ?? "0")), bettor);
      } else if (m1 === "void") {
        await darkVoid(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "expire") {
        await darkExpire(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "claim-fee") {
        await darkClaimFee(new PublicKey(String(args.market)), bettor);
      } else if (m1 === "show") {
        await darkShow(new PublicKey(String(args.market)));
      } else throw new Error(`unknown dark command: ${m1}`);
    } else if (m0 === "bounty") {
      const [m1] = cmd.slice(2);
      if (m1 === "open") {
        const bank = new PublicKey(String(args.bank));
        const threshold = Number(args.threshold);
        const lamports = BigInt(String(args.lamports));
        const deadlineTs = deadline(args["deadline"] ?? args["resolve-by"]);
        if (!Number.isFinite(threshold) || lamports <= 0n || deadlineTs === 0n)
          throw new Error("--bank <pk> --threshold n --lamports n --deadline +secs|ts required");
        await bountyOpen(bank, threshold, lamports, deadlineTs, BigInt(String(args.salt ?? "0")), bettor);
      } else if (m1 === "claim") {
        // Permissionless trigger — the pot pays run.runner, verified on-chain.
        await bountyClaim(new PublicKey(String(args.bounty)), new PublicKey(String(args.run)), bettor);
      } else if (m1 === "expire") {
        await bountyExpire(new PublicKey(String(args.bounty)), bettor);
      } else if (m1 === "show") {
        await bountyShow(new PublicKey(String(args.bounty)));
      } else throw new Error(`unknown bounty command: ${m1}`);
    } else if (m0 === "show") {
      await marketShow(new PublicKey(String(args.market)));
    } else throw new Error(`unknown market command: ${m0}`);
    return;
  }
  throw new Error(`unknown chain command: ${sub}`);
}
