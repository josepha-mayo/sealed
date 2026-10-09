/**
 * Chain client: drives the Sealed program from a bank file (seal) and a run
 * artifact (score), and prints leaderboards (status).
 *
 * Env: ANCHOR_PROVIDER_URL (default http://127.0.0.1:8899), ANCHOR_WALLET
 *      (default ~/.config/solana/id.json), SEALED_CLUSTER_OFFSET (Arcium cluster
 *      offset; localnet value comes from `arcium` env, devnet is 456).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as AnchorTypes from "@anchor-lang/core";
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
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
  specBytes,
  unpackSpecs,
  type ItemChunkState,
  type ItemSpec,
  type PrivItemChunkState,
} from "./genbank.js";
import { type RunArtifact, runChunkOutputs } from "./run.js";
import { chunkOutLeaves, merkleProof, itemLeaf, merkleRoot, hex, genItemsFold, privItemsFold } from "./hash.js";
import { evalGate, wilsonLowerBoundPct, type GatePolicy, type GateVerdict, type GateCheck, type ScoreReceipt } from "./gate.js";
import { classifyBoard, proven, type BoardRun } from "./board.js";
import { decodeSnapshotSection, loadIdl, loadSnapshotJson, snapOf, type SnapAccount, type SnapMap } from "./snapshot.js";
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
  const idl = loadIdl("sealed");
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
  const idl = loadIdl("sealed");
  return new PublicKey(process.env.SEALED_PROGRAM_ID ?? idl.address);
}

function sealedProgram(kpPath?: string) {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const kp = kpPath
    ? loadKeypair(kpPath)
    : loadKeypair(process.env.ANCHOR_WALLET ?? join(homedir(), ".config", "solana", "id.json"));
  const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(kp), { preflightCommitment: "processed", commitment: "confirmed" });
  const idl = loadIdl("sealed");
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
  const idl = loadIdl("market");
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
export async function bankList(snapPath?: string, json = false, kind?: string, depth = false) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const sm = depth && snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "market") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [banks, runs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "Benchmark"), snapOf(ss, "Run")]
    : await Promise.all([acct().benchmark.all(), acct().run.all()]);
  const best = new Map<string, number>();
  const finalized = new Map<string, number>();
  const bankOfRun = new Map<string, string>();
  for (const r of runs) {
    const k = (r.account.benchmark as PublicKey).toBase58();
    bankOfRun.set(r.publicKey.toBase58(), k);
    if (r.account.status !== 1) continue;
    const items = Number(r.account.chunkCount) * 32;
    const pct = items ? (100 * Number(r.account.correct)) / items : 0;
    best.set(k, Math.max(best.get(k) ?? 0, pct));
    finalized.set(k, (finalized.get(k) ?? 0) + 1);
  }
  // --depth: lamports that flowed through each exam's venues.
  const depthLam = new Map<string, bigint>();
  if (depth) {
    const mAcct = () => (marketProgram().market.account as any);
    const [markets, darks, ladders, bounties]: SnapAccount[][] = sm
      ? ["Market", "DarkMarket", "Ladder", "Bounty"].map((n) => snapOf(sm, n))
      : await Promise.all([mAcct().market.all(), mAcct().darkMarket.all(), mAcct().ladder.all(), mAcct().bounty.all()]);
    const add = (bank: string | undefined, lam: bigint) => { if (bank) depthLam.set(bank, (depthLam.get(bank) ?? 0n) + lam); };
    for (const m of [...markets, ...darks])
      add(bankOfRun.get((m.account.run as PublicKey).toBase58()),
        m.account.totals ? (m.account.totals as any[]).reduce((s: bigint, t: any) => s + BigInt(t.toString()), 0n) : BigInt((m.account.poolTotal as any)?.toString() ?? "0"));
    for (const l of ladders) {
      const lam = (l.account.totals as any[]).reduce((s: bigint, t: any) => s + BigInt(t.toString()), 0n);
      for (const p of (l.account.legs as PublicKey[]).slice(0, Number(l.account.legCount))) add(bankOfRun.get(p.toBase58()), lam);
    }
    for (const b of bounties) add((b.account.bank as PublicKey).toBase58(), BigInt((b.account.amount as any)?.toString() ?? "0"));
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
      depthSol: depth ? Number(depthLam.get(pk) ?? 0n) / 1e9 : undefined,
    };
  }).sort((p, q) => depth ? ((q.depthSol ?? 0) - (p.depthSol ?? 0) || q.runs - p.runs) : (q.runs - p.runs || p.name.localeCompare(q.name)));
  if (json) { console.log(JSON.stringify(rows)); return rows; }
  console.log(`${rows.length} benchmarks — ${depth ? "market depth" : "run count"} first:`);
  for (const r of rows)
    console.log(`  ${r.pk}  ${r.name.padEnd(20)} ${r.kind.padEnd(9)} items=${String(r.items).padStart(3)} runs=${String(r.runs).padStart(3)}` +
      ` finalized=${String(r.finalized).padStart(3)} best=${r.best.toFixed(1)}%${r.reveals ? ` reveals=${r.reveals}` : ""}${r.depthSol !== undefined ? ` depth=${r.depthSol.toFixed(3)}◎` : ""}`);
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
  // the exam's difficulty curve — the score distribution across models,
  // percent-normalized (chunks are all 32 items on generated banks, but
  // authored banks vary, so compare percentages not raw counts).
  const pcts = fin.map((r) => (100 * Number(r.account.correct)) / Math.max(1, Number(r.account.chunkCount) * 32)).sort((a, b) => a - b);
  const q = (p: number) => (pcts.length ? pcts[Math.min(pcts.length - 1, Math.floor((pcts.length - 1) * p))] : 0);
  const scoreDist = pcts.length ? {
    min: +q(0).toFixed(1), p25: +q(0.25).toFixed(1), median: +q(0.5).toFixed(1),
    p75: +q(0.75).toFixed(1), max: +q(1).toFixed(1),
    spread: +(q(1) - q(0)).toFixed(1),
  } : null;
  // the exam's own leaderboard — best score per model id that raced it
  const byModel = new Map<string, { correct: number; items: number; runs: number; postReveal: boolean }>();
  for (const r of fin) {
    const id = String(r.account.modelId);
    const items2 = Number(r.account.chunkCount) * 32;
    const e = byModel.get(id) ?? { correct: -1, items: items2, runs: 0, postReveal: false };
    e.runs++; e.postReveal ||= !!r.account.postReveal;
    if (Number(r.account.correct) > e.correct) { e.correct = Number(r.account.correct); e.items = items2; }
    byModel.set(id, e);
  }
  const leaderboard = [...byModel.entries()]
    .map(([model, e]) => ({ model, best: e.correct, items: e.items, runs: e.runs,
      pct: e.items ? +(100 * e.correct / e.items).toFixed(1) : 0, postReveal: e.postReveal }))
    .sort((a, b) => b.pct - a.pct);
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
  // market depth — lamports that moved through venues pricing THIS exam's
  // runs (markets/ladders/darks key on run; bounties key on the bank).
  const runSet = new Set(bRuns.map((r) => r.publicKey.toBase58()));
  const depth = { venues: 0, lamports: 0n, resolved: 0n, open: 0n };
  for (const m of [...markets, ...darks]) {
    if (!runSet.has((m.account.run as PublicKey).toBase58())) continue;
    const pot = m.account.totals
      ? (m.account.totals as any[]).reduce((s: bigint, t: any) => s + BigInt(t.toString()), 0n)
      : BigInt((m.account.poolTotal as any)?.toString() ?? "0");
    depth.venues++; depth.lamports += pot;
    if (Number(m.account.status) === 1) depth.resolved += pot; else depth.open += pot;
  }
  for (const l of ladders) {
    if (!(l.account.legs as PublicKey[]).slice(0, Number(l.account.legCount)).some((p) => runSet.has(p.toBase58()))) continue;
    const pot = (l.account.totals as any[]).reduce((s: bigint, t: any) => s + BigInt(t.toString()), 0n);
    depth.venues++; depth.lamports += pot;
    if (Number(l.account.status) === 1) depth.resolved += pot; else depth.open += pot;
  }
  for (const b of bounties.filter((b) => (b.account.bank as PublicKey).toBase58() === pk)) {
    depth.venues++; depth.lamports += BigInt((b.account.amount as any)?.toString() ?? "0");
    if (Number(b.account.status) !== 0) depth.resolved += BigInt((b.account.amount as any)?.toString() ?? "0");
    else depth.open += BigInt((b.account.amount as any)?.toString() ?? "0");
  }
  const out = {
    pk, name: B.name, kind: BANK_KIND[B.kind as number] ?? String(B.kind),
    authority: (B.authority as PublicKey).toBase58(), status: B.status,
    items, chunksSealed: Number(B.chunksSealed), chunksTotal: Number(B.chunkCount),
    itemsRoot: Buffer.from(B.itemsRoot).toString("hex"),
    feeLamports: Number(B.feeLamports), createdAt: Number(B.createdAt),
    runs: { total: bRuns.length, finalized: fin.length, pending: bRuns.length - fin.length,
      postReveal: postRev.length, bestCorrect: best < 0 ? null : best, bestPct: best < 0 ? null : +(100 * best / Math.max(1, items)).toFixed(1),
      scoreDistPct: scoreDist, leaderboard },
    receipts: { total: bLogs.length, vouched: bLogs.filter((l) => l.account.vouchedAtRecord).length,
      postReveal: bLogs.filter((l) => l.account.postReveal).length },
    reveals: bReveals.map((r) => ({ pk: r.publicKey.toBase58(), chunk: r.account.chunkIndex, part: r.account.part, revealedAt: Number(r.account.revealedAt) }))
      .sort((a, b) => a.revealedAt - b.revealedAt),
    grants: bGrants.length,
    chunks: { public: bItem.length, private: bPriv.length },
    venues,
    marketDepth: depth.venues ? { venues: depth.venues, lamports: depth.lamports.toString(),
      resolved: depth.resolved.toString(), open: depth.open.toString() } : null,
  };
  if (json) { console.log(JSON.stringify(out)); return out; }
  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`bank ${pk}`);
  console.log(`  spec — "${out.name}" ${out.kind} · authority ${out.authority.slice(0, 12)}… · status=${out.status} · ${out.chunksSealed}/${out.chunksTotal} chunks sealed (${out.items} items) · fee ${(out.feeLamports / 1e9).toFixed(4)}◎ · created ${fmt(out.createdAt)}`);
  console.log(`  items_root — ${out.itemsRoot.slice(0, 24)}…  (chain items --benchmark ${pk.slice(0, 8)}… regenerates the exam offline)`);
  console.log(`  runs — ${out.runs.total} total · ${out.runs.finalized} finalized · ${out.runs.pending} pending · ${out.runs.postReveal} post-reveal${out.runs.bestCorrect !== null ? ` · best ${out.runs.bestCorrect}/${out.items} (${out.runs.bestPct}%)` : ""}`);
  if (out.runs.scoreDistPct) {
    const d = out.runs.scoreDistPct;
    console.log(`  difficulty — scores across models: min ${d.min}% · p25 ${d.p25}% · median ${d.median}% · p75 ${d.p75}% · max ${d.max}% (spread ${d.spread}pp — ${d.spread >= 30 ? "discriminating" : d.spread >= 10 ? "moderate" : "tight"} exam)`);
  }
  if (out.runs.leaderboard.length) {
    const lb = out.runs.leaderboard.slice(0, 6)
      .map((e: any) => `${e.model} ${e.best}/${e.items} (${e.pct}%)${e.runs > 1 ? ` ×${e.runs}` : ""}${e.postReveal ? " ⚠post-reveal" : ""}`)
      .join(" · ");
    console.log(`  leaderboard — ${out.runs.leaderboard.length} model(s) raced this exam: ${lb}${out.runs.leaderboard.length > 6 ? ` · +${out.runs.leaderboard.length - 6} more` : ""}`);
  }
  console.log(`  receipts — ${out.receipts.total} minted · ${out.receipts.vouched} vouched · ${out.receipts.postReveal} post-reveal`);
  if (out.reveals.length)
    for (const r of out.reveals) console.log(`  reveal — ${r.pk.slice(0, 12)}… chunk ${r.chunk} part ${r.part} @ ${fmt(r.revealedAt)}`);
  else console.log(`  reveals — none (answer fingerprints still sealed)`);
  console.log(`  grants — ${out.grants} reshare grant(s) · chunks stored: ${out.chunks.public} public + ${out.chunks.private} private`);
  if (!venues.length) console.log(`  venues — none priced runs on this bank`);
  for (const v of venues)
    console.log(`  venues — ${v.kind}: ${v.total} (${Object.entries(v.byStatus).map(([k, n]) => `${n} ${k}`).join(", ")})`);
  if (out.marketDepth) {
    const md = out.marketDepth;
    console.log(`  depth — ${md.venues} venue(s) moved ${(Number(md.lamports) / 1e9).toFixed(3)}◎ through this exam's runs (${(Number(md.resolved) / 1e9).toFixed(3)}◎ resolved · ${(Number(md.open) / 1e9).toFixed(3)}◎ still in play)`);
  }
  console.log(`  permalink — https://josepha-mayo.github.io/sealed/?pk=${out.pk}`);
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
  minPct?: number; status?: string; attested?: boolean; postReveal?: boolean;
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
      attested: !!r.attested, attestedAt: Number(r.attestedAt ?? 0),
      createdAt: Number(r.createdAt), finalizedAt: Number(r.finalizedAt),
    };
  }).filter((r) =>
    (!bankPks || bankPks.has(r.bank)) &&
    (!opts.model || r.model === opts.model) &&
    (opts.attested === undefined || r.attested === opts.attested) &&
    (opts.postReveal === undefined || r.postReveal === opts.postReveal) &&
    (opts.minPct === undefined || r.pct >= opts.minPct) &&
    (want === undefined || r.status === want))
    .sort((a, b) => b.pct - a.pct || b.finalizedAt - a.finalizedAt);
  if (opts.json) { console.log(JSON.stringify(rows)); return rows; }
  console.log(`${rows.length} run(s)${bankPks ? ` on ${opts.bank}` : ""}${opts.model ? ` by ${opts.model}` : ""} — score first:`);
  for (const r of rows.slice(0, 100))
    console.log(`  ${r.pk}  ${r.model.padEnd(24)} ${r.bankName.padEnd(18)} ${r.status === 1 ? `${String(r.correct).padStart(3)}/${r.items} (${r.pct.toFixed(1)}%)` : (["PENDING", "?", "CANCELLED"][r.status] ?? r.status)}${r.postReveal ? " post-reveal" : ""}${r.attested ? " attested" : ""}`);
  if (rows.length > 100) console.log(`  … ${rows.length - 100} more (narrow with --bank/--model/--min-pct)`);
  return rows;
}

/** `chain records [--wilson]` — the whole capability registry, accuracy-first.
 *  `--wilson` re-ranks on the Wilson 95% lower bound of cumulative accuracy —
 *  100% on 64 items can't sit above 87% on 4,000 on raw rate alone; the
 *  lower bound is the claim the ledger can actually defend. */
export async function modelRecordList(snapPath?: string, json = false, wilson = false, vouchedOnly = false) {
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
      lcb: wilsonLowerBoundPct(r.totalCorrect.toNumber(), r.totalItems.toNumber()),
      bestPct: r.bestItems ? 100 * r.bestCorrect / r.bestItems : 0,
      best: `${r.bestCorrect}/${r.bestItems}`,
      vouched: vAgg.get(pk.toBase58()),
      last: (r.lastRun as PublicKey).toBase58(),
    }))
    .sort((a: any, b: any) => wilson ? b.lcb - a.lcb || b.pct - a.pct : b.bestPct - a.bestPct || b.pct - a.pct)
    .filter((r: any) => !vouchedOnly || r.vouched);
  if (json) {
    console.log(JSON.stringify(rows.map((r: any) => ({
      record: r.pk.toBase58(), modelId: r.modelId, runs: r.runs,
      pct: r.pct, lcb: r.lcb, best: r.best, bestPct: r.bestPct,
      vouched: r.vouched ? `${r.vouched.c}/${r.vouched.i}` : null, lastRun: r.last,
    }))));
    return rows;
  }
  console.log(`${rows.length} model record(s) — cumulative MPC-scored performance${wilson ? " — ranked by Wilson 95% LCB" : ""}${vouchedOnly ? " — venue-attested receipts only" : ""}:`);
  for (const r of rows)
    console.log(`  ${r.modelId.padEnd(36)} runs=${r.runs}  agg=${r.pct.toFixed(1)}%${wilson ? `  LCB=${r.lcb.toFixed(1)}%` : ""}  best=${r.best} (${r.bestPct.toFixed(1)}%)` +
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
  console.log(`  permalink — https://josepha-mayo.github.io/sealed/?pk=${pda.toBase58()}`);
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

/** `chain compare <a> <b> --prove <file>` — mint a `sealed-match/v1` card:
 *  the head-to-head verdict as portable evidence. The card carries both
 *  records' PDA seeds, every receipt on every shared bank, the runs and
 *  banks those receipts point at, and the stored verdict — a verifier
 *  re-derives every address and replays the whole match offline. */
/** The card builder shared by `compareMatch` (one pair) and
 *  `compareMatchAll` (every pair with shared evidence). */
function buildMatchCard(recA: SnapAccount, recB: SnapAccount, logs: SnapAccount[],
    banks: SnapAccount[], runs: SnapAccount[], source: string) {
  const pkA = recA.publicKey, pkB = recB.publicKey;
  const b58 = (v: any) => v?.toBase58 ? v.toBase58() : String(v);
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const modelHash = (id: string) => createHash("sha256").update(Buffer.from(id, "utf8")).digest();
  const sharedSet = new Set(
    logs.filter((l) => b58(l.account.modelRecord) === pkA.toBase58()).map((l) => b58(l.account.benchmark))
      .filter((k) => logs.some((l) => b58(l.account.modelRecord) === pkB.toBase58() && b58(l.account.benchmark) === k)));
  const logsA = logs.filter((l) => b58(l.account.modelRecord) === pkA.toBase58() && sharedSet.has(b58(l.account.benchmark)));
  const logsB = logs.filter((l) => b58(l.account.modelRecord) === pkB.toBase58() && sharedSet.has(b58(l.account.benchmark)));
  const runPks = new Set([...logsA, ...logsB].map((l) => b58(l.account.run)));
  const embRuns = runs.filter((r) => runPks.has(r.publicKey.toBase58()));
  const embBanks = banks.filter((b) => sharedSet.has(b.publicKey.toBase58()));
  const bankName = new Map(embBanks.map((b) => [b.publicKey.toBase58(), String(b.account.name)]));
  const agg = (ls: SnapAccount[]) => {
    const m = new Map<string, { correct: number; items: number; runs: number }>();
    for (const l of ls) {
      const k = b58(l.account.benchmark);
      const e = m.get(k) ?? { correct: 0, items: 0, runs: 0 };
      e.correct += num(l.account.correct); e.items += num(l.account.items); e.runs++;
      m.set(k, e);
    }
    return m;
  };
  const a = agg(logsA), b = agg(logsB);
  const rows = [...sharedSet].map((k) => {
    const ea = a.get(k)!, eb = b.get(k)!;
    const pa = ea.items ? (100 * ea.correct) / ea.items : 0;
    const pb = eb.items ? (100 * eb.correct) / eb.items : 0;
    return { bank: k, name: bankName.get(k) ?? "?", a: ea, b: eb, pctA: pa, pctB: pb, delta: pa - pb };
  }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const pooled = (m: Map<string, { correct: number; items: number; runs: number }>) =>
    [...m.values()].reduce((s, e) => ({ c: s.c + e.correct, i: s.i + e.items }), { c: 0, i: 0 });
  const pA = pooled(a), pB = pooled(b);
  const pctA = pA.i ? (100 * pA.c) / pA.i : 0, pctB = pB.i ? (100 * pB.c) / pB.i : 0;
  const wins = { a: rows.filter((r) => r.delta > 0).length, tie: rows.filter((r) => r.delta === 0).length, b: rows.filter((r) => r.delta < 0).length };
  return {
    kind: "sealed-match/v1",
    generatedAt: new Date().toISOString(),
    source,
    programs: { sealed: sealedProgramId().toBase58() },
    a: { id: String(recA.account.modelId), recordPk: pkA.toBase58(), seeds: { prefix: "modelrec", modelHash: modelHash(String(recA.account.modelId)).toString("hex") } },
    b: { id: String(recB.account.modelId), recordPk: pkB.toBase58(), seeds: { prefix: "modelrec", modelHash: modelHash(String(recB.account.modelId)).toString("hex") } },
    banks: embBanks.map((x) => ({ pk: x.publicKey.toBase58(), name: String(x.account.name),
      authority: b58(x.account.authority), id: num(x.account.id), itemsRoot: Buffer.from(x.account.itemsRoot as number[]).toString("hex") })),
    runs: embRuns.map((r) => ({ pk: r.publicKey.toBase58(), benchmark: b58(r.account.benchmark),
      index: num(r.account.index), status: num(r.account.status), correct: num(r.account.correct),
      chunkCount: num(r.account.chunkCount), postReveal: !!r.account.postReveal })),
    receipts: {
      a: logsA.map((l) => ({ pk: l.publicKey.toBase58(), run: b58(l.account.run), benchmark: b58(l.account.benchmark),
        correct: num(l.account.correct), items: num(l.account.items), vouchedAtRecord: !!l.account.vouchedAtRecord, postReveal: !!l.account.postReveal })),
      b: logsB.map((l) => ({ pk: l.publicKey.toBase58(), run: b58(l.account.run), benchmark: b58(l.account.benchmark),
        correct: num(l.account.correct), items: num(l.account.items), vouchedAtRecord: !!l.account.vouchedAtRecord, postReveal: !!l.account.postReveal })),
    },
    verdict: { pooledA: pA.c, pooledItemsA: pA.i, pooledB: pB.c, pooledItemsB: pB.i,
      pctA, pctB, bankWins: wins, sharedBanks: rows.length,
      winner: pctA === pctB ? "tie" : pctA > pctB ? "a" : "b" },
  };
}

export async function compareMatch(keyA: string, keyB: string, out: string, snapPath?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const resolve = (keyOrName: string): PublicKey => {
    try { return new PublicKey(keyOrName); } catch { /* model_id */ }
    const h = createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest();
    return PublicKey.findProgramAddressSync([Buffer.from("modelrec"), h], sealedProgramId())[0];
  };
  const pkA = resolve(keyA), pkB = resolve(keyB);
  const [records, logs, banks, runs]: SnapAccount[][] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog"), snapOf(ss, "Benchmark"), snapOf(ss, "Run")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all(), acct().benchmark.all(), acct().run.all()]);
  const recA = records.find((r) => r.publicKey.equals(pkA));
  const recB = records.find((r) => r.publicKey.equals(pkB));
  if (!recA || !recB) throw new Error(`no ModelRecord for ${!recA ? keyA : keyB}`);
  const card = buildMatchCard(recA, recB, logs, banks, runs, snapPath ?? "live");
  writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
  console.log(`wrote ${out} — sealed-match/v1 card: ${card.a.id} vs ${card.b.id} · ${card.verdict.sharedBanks} shared banks · ` +
    `${card.verdict.bankWins.a}-${card.verdict.bankWins.tie}-${card.verdict.bankWins.b} · pooled ${card.verdict.pctA.toFixed(1)}% vs ${card.verdict.pctB.toFixed(1)}% (verify: chain compare --match-verify ${out})`);
  return card;
}

/** `chain compare --all --prove <dir>` — mint one sealed-match/v1 card per
 *  ordered pair of records sharing ≥1 bank's receipts (A-vs-B once, not
 *  both directions). Writes <dir>/<a>-vs-<b>.json + an index.json. */
export async function compareMatchAll(dir: string, snapPath?: string, minShared = 1) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [records, logs, banks, runs]: SnapAccount[][] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog"), snapOf(ss, "Benchmark"), snapOf(ss, "Run")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all(), acct().benchmark.all(), acct().run.all()]);
  const b58 = (v: any) => v?.toBase58 ? v.toBase58() : String(v);
  const byRec = new Map<string, Set<string>>();
  for (const l of logs) {
    const k = b58(l.account.modelRecord);
    if (!byRec.has(k)) byRec.set(k, new Set());
    byRec.get(k)!.add(b58(l.account.benchmark));
  }
  mkdirSync(dir, { recursive: true });
  const slug = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "_");
  const files: string[] = [];
  let minted = 0;
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const pkA = records[i].publicKey.toBase58(), pkB = records[j].publicKey.toBase58();
      const shared = [...(byRec.get(pkA) ?? [])].filter((k) => byRec.get(pkB)?.has(k));
      if (shared.length < minShared) continue;
      const card = buildMatchCard(records[i], records[j], logs, banks, runs, snapPath ?? "live");
      const file = `${slug(card.a.id)}-vs-${slug(card.b.id)}.json`;
      writeFileSync(`${dir}/${file}`, JSON.stringify(card, null, 2) + "\n");
      files.push(file); minted++;
      const v = card.verdict;
      console.log(`${card.a.id} vs ${card.b.id} — ${v.sharedBanks} shared · ${v.bankWins.a}-${v.bankWins.tie}-${v.bankWins.b} · ${v.pctA.toFixed(1)}% vs ${v.pctB.toFixed(1)}% → ${file}`);
    }
  }
  writeFileSync(`${dir}/index.json`, JSON.stringify(files));
  console.log(`${minted} sealed-match/v1 cards → ${dir} (+index.json) · verify all: chain compare --match-verify ${dir}`);
  return minted;
}

/** The per-card match verifier shared by single-file and directory modes:
 *  every PDA re-derives, per-bank aggregates recompute from embedded
 *  receipts, the stored verdict replays bit-for-bit. */
function verifyMatchCard(card: any, emit?: (what: string, ok: boolean, detail: string) => void, snapPath?: string) {
  const sealedId = new PublicKey(card.programs.sealed);
  const u64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const pk = (s: string) => new PublicKey(s);
  const derive = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, sealedId)[0].toBase58();
  let pass = 0, fail = 0;
  const fails: string[] = [];
  const rows: { what: string; ok: boolean; detail: string }[] = [];
  const check = (what: string, ok: boolean, detail = "") => {
    rows.push({ what, ok, detail });
    emit?.(what, ok, detail);
    if (!ok) fails.push(what);
    ok ? pass++ : fail++;
  };
  // 1. identity — every address re-derives from declared seeds
  check("record PDA a", derive([Buffer.from("modelrec"), Buffer.from(card.a.seeds.modelHash, "hex")]) === card.a.recordPk,
    `${card.a.recordPk.slice(0, 12)}… = [modelrec, sha256(${card.a.id})]`);
  check("record PDA b", derive([Buffer.from("modelrec"), Buffer.from(card.b.seeds.modelHash, "hex")]) === card.b.recordPk,
    `${card.b.recordPk.slice(0, 12)}… = [modelrec, sha256(${card.b.id})]`);
  let bankOk = 0;
  for (const b of card.banks)
    if (derive([Buffer.from("benchmark"), pk(b.authority).toBuffer(), u32le(b.id)]) === b.pk) bankOk++;
  check("bank PDAs", bankOk === card.banks.length, `${bankOk}/${card.banks.length} re-derived`);
  let runOk = 0;
  for (const r of card.runs)
    if (derive([Buffer.from("run"), pk(r.benchmark).toBuffer(), u64le(r.index)]) === r.pk) runOk++;
  check("run PDAs", runOk === card.runs.length, `${runOk}/${card.runs.length} re-derived`);
  const allRec = [...card.receipts.a, ...card.receipts.b];
  let logOk = 0;
  for (const l of allRec)
    if (derive([Buffer.from("scorelog"), pk(l.run).toBuffer()]) === l.pk) logOk++;
  check("receipt PDAs", logOk === allRec.length, `${logOk}/${allRec.length} re-derived`);
  // 2. the match replay — per-bank aggregates recomputed from receipts
  const bankPks = new Set(card.banks.map((b: any) => b.pk));
  const receiptsOnBanks = (ls: any[]) => ls.filter((l) => bankPks.has(l.benchmark));
  const agg = (ls: any[]) => {
    const m = new Map<string, { c: number; i: number }>();
    for (const l of receiptsOnBanks(ls)) {
      const e = m.get(l.benchmark) ?? { c: 0, i: 0 };
      e.c += l.correct; e.i += l.items; m.set(l.benchmark, e);
    }
    return m;
  };
  const ra = agg(card.receipts.a), rb = agg(card.receipts.b);
  const shared = [...ra.keys()].filter((k) => rb.has(k));
  check("shared banks", shared.length === card.verdict.sharedBanks,
    `${shared.length} recomputed = ${card.verdict.sharedBanks} stored`);
  const pA = [...ra.values()].reduce((s, e) => ({ c: s.c + e.c, i: s.i + e.i }), { c: 0, i: 0 });
  const pB = [...rb.values()].reduce((s, e) => ({ c: s.c + e.c, i: s.i + e.i }), { c: 0, i: 0 });
  check("pooled aggregates",
    pA.c === card.verdict.pooledA && pA.i === card.verdict.pooledItemsA && pB.c === card.verdict.pooledB && pB.i === card.verdict.pooledItemsB,
    `${pA.c}/${pA.i} vs ${pB.c}/${pB.i} recomputed = ${card.verdict.pooledA}/${card.verdict.pooledItemsA} vs ${card.verdict.pooledB}/${card.verdict.pooledItemsB} stored`);
  const wins = { a: 0, tie: 0, b: 0 };
  for (const k of shared) {
    const pa = ra.get(k)!.i ? (100 * ra.get(k)!.c) / ra.get(k)!.i : 0;
    const pb2 = rb.get(k)!.i ? (100 * rb.get(k)!.c) / rb.get(k)!.i : 0;
    pa > pb2 ? wins.a++ : pa === pb2 ? wins.tie++ : wins.b++;
  }
  check("bank wins", wins.a === card.verdict.bankWins.a && wins.tie === card.verdict.bankWins.tie && wins.b === card.verdict.bankWins.b,
    `${wins.a}-${wins.tie}-${wins.b} recomputed = ${card.verdict.bankWins.a}-${card.verdict.bankWins.tie}-${card.verdict.bankWins.b} stored`);
  const pctA = pA.i ? (100 * pA.c) / pA.i : 0, pctB = pB.i ? (100 * pB.c) / pB.i : 0;
  const winner = pctA === pctB ? "tie" : pctA > pctB ? "a" : "b";
  check("verdict replay", winner === card.verdict.winner && Math.abs(pctA - card.verdict.pctA) < 0.01 && Math.abs(pctB - card.verdict.pctB) < 0.01,
    `${card.a.id} ${pctA.toFixed(2)}% vs ${card.b.id} ${pctB.toFixed(2)}% → ${winner}`);

  // 3. snapshot binding — every receipt must equal its decoded ScoreLog
  // account AND belong to the side it claims (receipts.a → recordPk a).
  if (snapPath) {
    const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
    const logs = new Map(snapOf(ss, "ScoreLog").map((l) => [l.publicKey.toBase58(), l]));
    const recs = new Map(snapOf(ss, "ModelRecord").map((r) => [r.publicKey.toBase58(), r]));
    let bBad = 0, bN = 0;
    for (const side of ["a", "b"] as const) {
      for (const l of card.receipts[side]) {
        bN++;
        const real = logs.get(l.pk);
        if (!real || (real.account.run as PublicKey).toBase58() !== l.run ||
            (real.account.benchmark as PublicKey).toBase58() !== l.benchmark ||
            (real.account.modelRecord as PublicKey).toBase58() !== card[side].recordPk ||
            Number(real.account.correct) !== l.correct || Number(real.account.items) !== l.items ||
            Number(real.account.vouchedAtRecord ?? 0) !== (l.vouchedAtRecord ? 1 : 0) ||
            Number(real.account.postReveal ?? 0) !== (l.postReveal ? 1 : 0)) bBad++;
      }
    }
    const recA = recs.get(card.a.recordPk), recB = recs.get(card.b.recordPk);
    const idOk = !!recA && !!recB && String(recA.account.modelId) === card.a.id && String(recB.account.modelId) === card.b.id;
    check("snapshot binding", bBad === 0 && idOk,
      `${bN - bBad}/${bN} receipts == ScoreLog bytes, each bound to its side's record` +
      (idOk ? " · on-chain modelIds match" : " · MODEL ID MISMATCH"));
  }
  return { ok: fail === 0, pass, fail, fails, rows };
}

/** `chain compare --match-verify <file|dir>` — replay a sealed-match/v1 card
 *  keyless: both record PDAs, every bank/run/receipt PDA re-derived, the
 *  per-bank aggregates recomputed from embedded receipts, and the stored
 *  verdict replayed bit-for-bit. A directory batch-verifies every *.json
 *  card in it. Exit 1 on any violation. */
export async function matchVerify(file: string, json = false, snapPath?: string) {
  const { statSync, readdirSync } = await import("node:fs");
  if (statSync(file).isDirectory()) {
    const files = readdirSync(file).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
    if (!files.length) throw new Error(`no match cards (*.json) in ${file}`);
    let okAll = true;
    const results: any[] = [];
    if (!json) console.log(`verifying ${files.length} match card(s) in ${file}/`);
    for (const f of files) {
      try {
        const card = JSON.parse(readFileSync(`${file}/${f}`, "utf8"));
        if (card.kind !== "sealed-match/v1") throw new Error(`kind=${card.kind}`);
        const r = verifyMatchCard(card, undefined, snapPath);
        results.push({ file: f, a: card.a?.id ?? null, b: card.b?.id ?? null, ok: r.ok, pass: r.pass, fail: r.fail, fails: r.fails });
        if (!json) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${f.padEnd(44)} ${card.a?.id ?? "?"} vs ${card.b?.id ?? "?"} — ${r.pass} checks${r.ok ? "" : ` · ${r.fails.join("; ")}`}`);
        okAll &&= r.ok;
      } catch (e: any) { okAll = false; results.push({ file: f, ok: false, error: String(e?.message ?? e) }); if (!json) console.log(`  FAIL ${f} — ${e?.message ?? e}`); }
    }
    if (json) console.log(JSON.stringify({ dir: file, cards: results, ok: okAll }));
    else console.log(`${okAll ? "ALL MATCHES VERIFIED" : "VERIFICATION FAILED"} — ${files.length} card(s), ${file}`);
    if (!okAll) process.exit(1);
    return { ok: okAll, cards: results };
  }
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-match/v1") throw new Error(`not a sealed-match/v1 file (kind=${card.kind})`);
  const r = verifyMatchCard(card, (what, ok, detail) => { if (!json) console.log(`  ${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); }, snapPath);
  const verdict = r.fail === 0 ? "MATCH VERIFIED" : "MATCH FAILED";
  if (json) console.log(JSON.stringify({ file, kind: card.kind, a: card.a.id, b: card.b.id, verified: r.fail === 0,
    checks: r.rows, pass: r.pass, fail: r.fail, verdict: card.verdict }));
  else console.log(`${verdict} — ${card.a.id} vs ${card.b.id}: ${r.pass} checks pass, ${r.fail} fail · ${card.verdict.bankWins.a}-${card.verdict.bankWins.tie}-${card.verdict.bankWins.b} on ${card.verdict.sharedBanks} shared bank(s)`);
  if (r.fail) process.exitCode = 1;
  return { pass: r.pass, fail: r.fail };
}

/** `chain compare --all [--json]` — the paired-evidence leaderboard: every
 *  model×model pair's shared-bank result tallied into a win table. Aggregate
 *  accuracy ranks models that never faced the same exam; this ranks them on
 *  what they actually shared — and says how much of the ranking is grounded
 *  (pairs with zero shared banks count as unranked, not assumed). */
export async function compareAll(json = false, snapPath?: string, minShared = 1, wilson = false) {
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
  // --wilson: rank by the 95% Wilson lower confidence bound of the win
  // rate (ties count half, n = ranked pairs) — a 2–0 record can't sit above
  // a 15–2 one on thin evidence. Same math the capability gate applies to
  // accuracy; here it disciplines the *ranking*.
  for (const r of recs)
    (r as any).lcb = r.rankedPairs ? wilsonLowerBoundPct(r.wins + r.ties / 2, r.rankedPairs) : 0;
  const ranked = wilson
    ? recs.sort((x, y) => (y as any).lcb - (x as any).lcb || y.wins - x.wins || y.ppDelta - x.ppDelta)
    : recs.sort((x, y) => y.wins - x.wins || x.losses - y.losses || y.ppDelta - x.ppDelta);
  const total = (recs.length * (recs.length - 1)) / 2;
  if (json) { console.log(JSON.stringify({ ranked, unrankedPairs: unranked, totalPairs: total, ranking: wilson ? "wilson-lcb" : "wins" })); return ranked; }
  console.log(`paired-evidence leaderboard — ${recs.length} models, ${total} pairs ` +
    `(${total - unranked} rankable, ${unranked} disjoint${minShared > 1 ? ` or <${minShared} shared banks` : ""})` +
    (wilson ? ` — ranked by Wilson 95% LCB of win-rate` : ""));
  for (const r of ranked)
    console.log(`  ${r.modelId.padEnd(28)} W${String(r.wins).padStart(2)}-L${String(r.losses).padStart(2)}-T${String(r.ties).padStart(2)}` +
      `  ΣΔ${r.ppDelta >= 0 ? "+" : ""}${r.ppDelta.toFixed(0)}pp` +
      (wilson ? `  LCB ${(r as any).lcb.toFixed(1)}%` : "") +
      `  over ${r.sharedBanks} shared-bank result(s)`);
  console.log(`ranking grounded on shared benchmarks only — ${unranked} pair(s) had none and count as unranked` +
    (wilson ? `; order penalizes thin records (a 2–0 sits below a proven 15–2)` : ""));
  return ranked;
}

/** `chain board --prove <f>` — mint `sealed-board/v1`: the paired-evidence
 *  leaderboard as a portable artifact. A leaderboard is a CLAIM — this
 *  binds it to the receipts it's computed from, so a judge doesn't ask
 *  "is this table honest?", they replay it. `chain board --verify <f>`
 *  re-derives every record/receipt PDA, recomputes every aggregate, the
 *  shared-bank join, every pairwise verdict, and the Wilson ordering —
 *  all offline; with --snapshot every embedded receipt is also bound to
 *  its real ScoreLog account and Run.correct. */
export async function boardProve(out: string, snapPath?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  if (!ss) throw new Error("board cards are snapshot-only — the ledger they claim must be pinned bytes");
  const records = snapOf(ss, "ModelRecord"), logs = snapOf(ss, "ScoreLog");
  const recByPk = new Map(records.map((r) => [r.publicKey.toBase58(), r]));
  const models = records.map((r) => {
    const pk = r.publicKey.toBase58();
    const receipts = logs
      .filter((l) => (l.account.modelRecord as PublicKey).toBase58() === pk)
      .map((l) => ({
        pk: l.publicKey.toBase58(), run: (l.account.run as PublicKey).toBase58(),
        benchmark: (l.account.benchmark as PublicKey).toBase58(),
        correct: Number(l.account.correct), items: Number(l.account.items),
        vouched: Number(l.account.vouchedAtRecord ?? 0), postReveal: Number(l.account.postReveal ?? 0),
        recordedAt: Number(l.account.recordedAt), modelRecord: pk,
      }))
      .sort((a, b) => a.recordedAt - b.recordedAt || a.pk.localeCompare(b.pk));
    const a = r.account;
    return {
      recordPk: pk, modelId: a.modelId,
      record: {
        modelHash: Buffer.from(a.modelHash).toString("hex"),
        runsScored: Number(a.runsScored), totalCorrect: Number(a.totalCorrect), totalItems: Number(a.totalItems),
        bestCorrect: Number(a.bestCorrect), bestItems: Number(a.bestItems),
        bestRun: (a.bestRun as PublicKey).toBase58(), bestBank: (a.bestBank as PublicKey).toBase58(),
        lastRun: (a.lastRun as PublicKey).toBase58(),
        firstSeen: Number(a.firstSeen), lastScored: Number(a.lastScored),
      },
      receipts,
    };
  });
  // the shared-bank join + Wilson ordering — same math as compareAll
  const byBank = new Map<string, Map<string, { correct: number; items: number }>>();
  for (const m of models) {
    const e = new Map<string, { correct: number; items: number }>();
    for (const l of m.receipts) {
      const x = e.get(l.benchmark) ?? { correct: 0, items: 0 };
      x.correct += l.correct; x.items += l.items;
      e.set(l.benchmark, x);
    }
    byBank.set(m.recordPk, e);
  }
  const stats = new Map(models.map((m) => [m.recordPk, { wins: 0, losses: 0, ties: 0, rankedPairs: 0, sharedBanks: 0, ppDelta: 0 }]));
  const pairs: any[] = [];
  for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) {
    const A = models[i], B = models[j];
    const a = byBank.get(A.recordPk)!, b = byBank.get(B.recordPk)!;
    const shared = [...a.keys()].filter((k) => b.has(k));
    if (!shared.length) continue;
    const pa = shared.reduce((s, k) => s + a.get(k)!.correct, 0) / Math.max(1, shared.reduce((s, k) => s + a.get(k)!.items, 0));
    const pb = shared.reduce((s, k) => s + b.get(k)!.correct, 0) / Math.max(1, shared.reduce((s, k) => s + b.get(k)!.items, 0));
    const d = +(100 * (pa - pb)).toFixed(4);
    const sa = stats.get(A.recordPk)!, sb = stats.get(B.recordPk)!;
    sa.rankedPairs++; sb.rankedPairs++;
    sa.sharedBanks += shared.length; sb.sharedBanks += shared.length;
    sa.ppDelta = +(sa.ppDelta + d).toFixed(4); sb.ppDelta = +(sb.ppDelta - d).toFixed(4);
    const verdict = pa > pb ? "a" : pa < pb ? "b" : "tie";
    if (verdict === "a") { sa.wins++; sb.losses++; } else if (verdict === "b") { sb.wins++; sa.losses++; } else { sa.ties++; sb.ties++; }
    // canonical direction: a < b by model id — deltaPp always reads "a − b"
    const flip = A.modelId > B.modelId;
    pairs.push(flip
      ? { a: B.modelId, b: A.modelId, shared: shared.length, deltaPp: -d, verdict: verdict === "a" ? "b" : verdict === "b" ? "a" : "tie" }
      : { a: A.modelId, b: B.modelId, shared: shared.length, deltaPp: d, verdict });
  }
  const rows = models.map((m) => {
    const s = stats.get(m.recordPk)!;
    const items = m.receipts.reduce((x, l) => x + l.items, 0);
    const correct = m.receipts.reduce((x, l) => x + l.correct, 0);
    return {
      rank: 0, modelId: m.modelId, recordPk: m.recordPk, receipts: m.receipts, record: m.record,
      aggregate: { runs: m.receipts.length, correct, items, pct: items ? +(100 * correct / items).toFixed(4) : 0 },
      pairwise: { ...s, lcb: s.rankedPairs ? +wilsonLowerBoundPct(s.wins + s.ties / 2, s.rankedPairs).toFixed(4) : 0 },
    };
  });
  rows.sort((x, y) => y.pairwise.lcb - x.pairwise.lcb || y.pairwise.wins - x.pairwise.wins || y.pairwise.ppDelta - x.pairwise.ppDelta);
  rows.forEach((r, i) => (r.rank = i + 1));
  const total = (models.length * (models.length - 1)) / 2;
  const card = {
    kind: "sealed-board/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath,
    programs: { sealed: sealedProgramId().toBase58(), market: MARKET_PROGRAM_ID.toBase58() },
    policy: { metric: "wilson-lcb-95", ties: "half", minShared: 1 },
    totals: { models: models.length, receipts: logs.length, pairs: pairs.length, unrankedPairs: total - pairs.length },
    ranking: rows.map((r) => ({ rank: r.rank, modelId: r.modelId, recordPk: r.recordPk, aggregate: r.aggregate, pairwise: r.pairwise })),
    models: rows.map((r) => ({ recordPk: r.recordPk, modelId: r.modelId, record: r.record, receipts: r.receipts })),
    pairs,
  };
  writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
  console.log(`wrote ${out} — sealed-board/v1: ${models.length} models · ${logs.length} receipts · ${pairs.length} ranked pairs; verify: chain board --verify ${out} --snapshot ${snapPath}`);
  return card;
}

/** `chain board --verify <f> [--snapshot f2]` — replay a sealed-board/v1
 *  card: record/receipt PDAs re-derive, aggregates recompute from
 *  embedded receipts, the shared-bank join and Wilson ordering re-derive
 *  the printed ranking, and (with --snapshot) every receipt is bound to
 *  its real ScoreLog account byte-fields + the run's MPC score. */
export async function boardVerify(file: string, json = false, snapPath?: string): Promise<any> {
  const { statSync, readdirSync } = await import("node:fs");
  if (statSync(file).isDirectory()) {
    let okAll = true, n = 0;
    for (const f of readdirSync(file).filter((x) => x.endsWith(".json") && x !== "index.json").sort()) {
      const r = await boardVerify(`${file}/${f}`, json, snapPath); okAll &&= r.ok; n++;
    }
    if (!json) console.log(`${okAll ? "ALL VERIFIED" : "FAILED"} — ${n} board card(s)`);
    return { ok: okAll, pass: n, fail: okAll ? 0 : n };
  }
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-board/v1") throw new Error("not a sealed-board/v1 artifact");
  const spid = sealedProgramId();
  const lines: string[] = [];
  let pass = 0, fail = 0;
  const note = (ok: boolean, label: string, detail = "") => { lines.push(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

  // [1] record identity — PDA re-derives from the model id hash, and the
  // declared modelHash is that hash.
  let idBad = 0;
  for (const m of card.models) {
    const mh = createHash("sha256").update(m.modelId).digest("hex");
    const [recPda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), Buffer.from(mh, "hex")], spid);
    if (mh !== m.record.modelHash || recPda.toBase58() !== m.recordPk) idBad++;
  }
  note(idBad === 0, "record identity", `${card.models.length} record PDAs = [modelrec, sha256(modelId)] + modelHash matches`);

  // [2] receipt identity — [scorelog, run] PDAs + back-reference to the record.
  let rpBad = 0;
  for (const m of card.models) for (const l of m.receipts) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("scorelog"), new PublicKey(l.run).toBuffer()], spid);
    if (pda.toBase58() !== l.pk || l.modelRecord !== m.recordPk) rpBad++;
  }
  note(rpBad === 0, "receipt identity", `${card.models.reduce((s: number, m: any) => s + m.receipts.length, 0)} receipt PDAs = [scorelog, run], each bound to its record`);

  // [3] aggregates — declared record + aggregate rows recompute from receipts.
  let agBad = 0;
  for (const m of card.models) {
    const correct = m.receipts.reduce((s: number, l: any) => s + l.correct, 0);
    const items = m.receipts.reduce((s: number, l: any) => s + l.items, 0);
    const row = card.ranking.find((r: any) => r.recordPk === m.recordPk);
    if (correct !== m.record.totalCorrect || items !== m.record.totalItems ||
        m.receipts.length !== m.record.runsScored ||
        !row || row.aggregate.correct !== correct || row.aggregate.items !== items || row.aggregate.runs !== m.receipts.length) agBad++;
  }
  note(agBad === 0, "aggregates", "every record's totals + ranking row replay bit-exact from its embedded receipts");

  // [4] pairwise — the shared-bank join + every pair verdict re-derive.
  const byBank = new Map<string, Map<string, { correct: number; items: number }>>();
  for (const m of card.models) {
    const e = new Map<string, { correct: number; items: number }>();
    for (const l of m.receipts) {
      const x = e.get(l.benchmark) ?? { correct: 0, items: 0 };
      x.correct += l.correct; x.items += l.items; e.set(l.benchmark, x);
    }
    byBank.set(m.recordPk, e);
  }
  const rebuiltPairs: any[] = [];
  type Pw = { wins: number; losses: number; ties: number; rankedPairs: number; sharedBanks: number; ppDelta: number };
  const stats = new Map<string, Pw>(card.models.map((m: any) => [m.recordPk as string, { wins: 0, losses: 0, ties: 0, rankedPairs: 0, sharedBanks: 0, ppDelta: 0 } as Pw]));
  const idToPk = new Map(card.models.map((m: any) => [m.modelId, m.recordPk]));
  for (let i = 0; i < card.models.length; i++) for (let j = i + 1; j < card.models.length; j++) {
    const A = card.models[i], B = card.models[j];
    const a = byBank.get(A.recordPk)!, b = byBank.get(B.recordPk)!;
    const shared = [...a.keys()].filter((k) => b.has(k));
    if (!shared.length) continue;
    const pa = shared.reduce((s, k) => s + a.get(k)!.correct, 0) / Math.max(1, shared.reduce((s, k) => s + a.get(k)!.items, 0));
    const pb = shared.reduce((s, k) => s + b.get(k)!.correct, 0) / Math.max(1, shared.reduce((s, k) => s + b.get(k)!.items, 0));
    const d = +(100 * (pa - pb)).toFixed(4);
    const sa = stats.get(A.recordPk)!, sb = stats.get(B.recordPk)!;
    sa.rankedPairs++; sb.rankedPairs++;
    sa.sharedBanks += shared.length; sb.sharedBanks += shared.length;
    sa.ppDelta = +(sa.ppDelta + d).toFixed(4); sb.ppDelta = +(sb.ppDelta - d).toFixed(4);
    const verdict = pa > pb ? "a" : pa < pb ? "b" : "tie";
    if (verdict === "a") { sa.wins++; sb.losses++; } else if (verdict === "b") { sb.wins++; sa.losses++; } else { sa.ties++; sb.ties++; }
    // canonical direction: a < b by model id — deltaPp always reads "a − b"
    const flip = A.modelId > B.modelId;
    rebuiltPairs.push(flip
      ? { a: B.modelId, b: A.modelId, shared: shared.length, deltaPp: -d, verdict: verdict === "a" ? "b" : verdict === "b" ? "a" : "tie" }
      : { a: A.modelId, b: B.modelId, shared: shared.length, deltaPp: d, verdict });
  }
  const pairSort = (x: any, y: any) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b);
  note(JSON.stringify([...card.pairs].sort(pairSort)) === JSON.stringify([...rebuiltPairs].sort(pairSort)),
    "pairwise verdicts", `${rebuiltPairs.length} ranked pairs — shared banks, deltas, and every verdict recomputed`);
  let statBad = 0;
  for (const m of card.models) {
    const s = stats.get(m.recordPk)!, p = card.ranking.find((r: any) => r.recordPk === m.recordPk)?.pairwise;
    if (!p || s.wins !== p.wins || s.losses !== p.losses || s.ties !== p.ties ||
        s.rankedPairs !== p.rankedPairs || s.sharedBanks !== p.sharedBanks || Math.abs(s.ppDelta - p.ppDelta) > 0.001) statBad++;
  }
  note(statBad === 0, "pairwise tallies", "per-model W-L-T, ranked pairs, shared banks, ΣΔpp all re-derived equal");

  // [5] the ranking itself — Wilson LCB per model, then the printed order.
  let rankBad = 0;
  const order = card.models.map((m: any) => {
    const s = stats.get(m.recordPk)!;
    const lcb = s.rankedPairs ? wilsonLowerBoundPct(s.wins + s.ties / 2, s.rankedPairs) : 0;
    return { pk: m.recordPk, lcb: +lcb.toFixed(4), s };
  }).sort((x: any, y: any) => y.lcb - x.lcb || y.s.wins - x.s.wins || y.s.ppDelta - x.s.ppDelta);
  for (let i = 0; i < card.ranking.length; i++) {
    const r = card.ranking[i];
    if (r.recordPk !== order[i].pk || r.rank !== i + 1 ||
        Math.abs(r.pairwise.lcb - order[i].lcb) > 0.001) rankBad++;
  }
  note(rankBad === 0, "ranking", `Wilson-95 LCB order re-derived — #1 ${card.ranking[0]?.modelId ?? "?"}, ${card.ranking.length} ranked rows in declared order`);

  // [6] snapshot binding — every embedded receipt must equal the real
  // ScoreLog account's fields, and the run's MPC-written score.
  if (snapPath) {
    const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
    const logs = new Map(snapOf(ss, "ScoreLog").map((l) => [l.publicKey.toBase58(), l]));
    const runs = new Map(snapOf(ss, "Run").map((r) => [r.publicKey.toBase58(), r]));
    let bBad = 0, bN = 0;
    for (const m of card.models) for (const l of m.receipts) {
      bN++;
      const real = logs.get(l.pk), run = runs.get(l.run);
      if (!real || !run) { bBad++; continue; }
      if ((real.account.run as PublicKey).toBase58() !== l.run ||
          (real.account.benchmark as PublicKey).toBase58() !== l.benchmark ||
          (real.account.modelRecord as PublicKey).toBase58() !== m.recordPk ||
          Number(real.account.correct) !== l.correct || Number(real.account.items) !== l.items ||
          Number(real.account.vouchedAtRecord ?? 0) !== l.vouched || Number(real.account.postReveal ?? 0) !== l.postReveal ||
          Number(real.account.recordedAt) !== l.recordedAt ||
          Number((run.account as any).correct) !== l.correct) bBad++;
    }
    note(bBad === 0, "snapshot binding", `${bN} receipts equal their ScoreLog accounts field-for-field; every score == Run.correct`);
  }

  const ok = fail === 0;
  if (json) console.log(JSON.stringify({ kind: card.kind, ok, pass, fail, lines }, null, 2));
  else {
    console.log(`sealed-board/v1 — ${basename(file)}`);
    for (const l of lines) console.log(`  ${l}`);
    console.log(ok
      ? `BOARD VERIFIED — ${card.totals.models} models · ${card.totals.receipts} receipts · ${card.totals.pairs} ranked pairs; #1 ${card.ranking[0]?.modelId}`
      : "BOARD FAILED");
  }
  if (!ok) process.exitCode = 1;
  return { ok, pass, fail };
}

/** `chain bank <pk> --prove <f>` — mint `sealed-bank/v1`: one exam as a
 *  portable evidence card. Claims/boards cover the model axis, trails the
 *  money axis — the bank card covers the EXAM axis: the items_root
 *  commitment, every item-chunk PDA that fed the fold (in true landing
 *  order), and the complete run/reveal/grant surface the bank provably
 *  has. Snapshot-only: a card that can't bind to pinned bytes isn't
 *  evidence. */
export async function bankProve(bankKey: string, out: string, snapPath?: string) {
  if (!snapPath) throw new Error("bank cards are snapshot-only — the exam they claim must be pinned bytes");
  const snap = loadSnapshotJson(snapPath);
  const ss = decodeSnapshotSection(snap, "sealed");
  const spid = sealedProgramId();
  const banks = snapOf(ss, "Benchmark");
  const bank = banks.find((x) => x.publicKey.toBase58() === bankKey || x.account.name === bankKey);
  if (!bank) throw new Error(`no benchmark named/addressed ${bankKey} in snapshot`);
  const pk = bank.publicKey.toBase58();
  const B = bank.account as any;
  const onBank = (a: any) => (a.account.benchmark as PublicKey)?.toBase58() === pk;
  const items = snapOf(ss, "ItemChunk").filter(onBank)
    .map((c) => ({ pk: c.publicKey.toBase58(), index: Number(c.account.index),
      partsWritten: Number(c.account.partsWritten), mintOrder: (c.account.mintOrder as any[]).map(Number) }))
    .sort((a, b) => a.index - b.index);
  const privs = snapOf(ss, "PrivItemChunk").filter(onBank)
    .map((c) => ({ pk: c.publicKey.toBase58(), index: Number(c.account.index),
      partsWritten: Number(c.account.partsWritten), mintOrder: (c.account.mintOrder as any[]).map(Number) }))
    .sort((a, b) => a.index - b.index);
  const runs = snapOf(ss, "Run").filter(onBank)
    .map((r) => ({ pk: r.publicKey.toBase58(), index: Number(r.account.index), modelId: String(r.account.modelId),
      status: Number(r.account.status), correct: Number(r.account.correct), postReveal: Number(r.account.postReveal ?? 0),
      scoredMask: Number(r.account.scoredMask ?? 0), finalizedAt: Number(r.account.finalizedAt ?? 0) }))
    .sort((a, b) => a.index - b.index);
  const receipts = snapOf(ss, "ScoreLog").filter(onBank)
    .map((l) => ({ pk: l.publicKey.toBase58(), run: (l.account.run as PublicKey).toBase58(),
      modelRecord: (l.account.modelRecord as PublicKey).toBase58(),
      correct: Number(l.account.correct), items: Number(l.account.items),
      vouched: Number(l.account.vouchedAtRecord ?? 0), postReveal: Number(l.account.postReveal ?? 0),
      recordedAt: Number(l.account.recordedAt) }))
    .sort((a, b) => a.recordedAt - b.recordedAt || a.pk.localeCompare(b.pk));
  const reveals = snapOf(ss, "Reveal").filter(onBank)
    .map((r) => ({ pk: r.publicKey.toBase58(), chunkIndex: Number(r.account.chunkIndex),
      part: Number(r.account.part), revealedAt: Number(r.account.revealedAt) }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.part - b.part);
  const grants = snapOf(ss, "ShareGrant").filter(onBank)
    .map((g) => ({ pk: g.publicKey.toBase58(), chunkIndex: Number(g.account.chunkIndex),
      part: Number(g.account.part), viewer: new PublicKey(g.account.viewer).toBase58(),
      sharedAt: Number(g.account.sharedAt) }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.part - b.part || a.viewer.localeCompare(b.viewer));
  const card = {
    kind: "sealed-bank/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath,
    programs: { sealed: spid.toBase58() },
    bank: {
      pk, authority: (B.authority as PublicKey).toBase58(), id: Number(B.id),
      name: String(B.name), kind: Number(B.kind), items: Number(B.chunkCount) * CHUNK,
      chunkCount: Number(B.chunkCount), chunksSealed: Number(B.chunksSealed),
      itemsRoot: Buffer.from(B.itemsRoot).toString("hex"),
      feeLamports: Number(B.feeLamports), runCount: Number(B.runCount),
      revealCount: Number(B.revealCount ?? 0), createdAt: Number(B.createdAt), status: Number(B.status),
    },
    chunks: { public: items, private: privs },
    runs, receipts, reveals, grants,
    snapshot: createHash("sha256").update(readFileSync(snapPath)).digest("hex"),
  };
  writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
  console.log(`wrote ${out} — sealed-bank/v1: ${B.name} · ${items.length + privs.length} item chunks · ${runs.length} runs · ${receipts.length} receipts · ${reveals.length} reveals · ${grants.length} grants; verify: chain bank --verify ${out} --snapshot ${snapPath}`);
  return card;
}

/** `chain bank --verify <f> [--snapshot f2]` — replay a sealed-bank/v1
 *  card: bank PDA + fields, every item-chunk PDA, the items_root fold
 *  re-run from the pinned account bytes in landing order (generated:
 *  spec bytes; private: ciphertext+nonce — authored banks carry no
 *  on-chain fold to replay), and the full run/receipt/reveal/grant
 *  surface checked for completeness against the snapshot. */
export async function bankVerify(file: string, json = false, snapPath?: string): Promise<any> {
  const { statSync, readdirSync } = await import("node:fs");
  if (statSync(file).isDirectory()) {
    let okAll = true, n = 0;
    for (const f of readdirSync(file).filter((x) => x.endsWith(".json") && x !== "index.json").sort()) {
      const r = await bankVerify(`${file}/${f}`, json, snapPath); okAll &&= r.ok; n++;
    }
    if (!json) console.log(`${okAll ? "ALL VERIFIED" : "FAILED"} — ${n} bank card(s)`);
    return { ok: okAll, pass: n, fail: okAll ? 0 : n };
  }
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-bank/v1") throw new Error("not a sealed-bank/v1 artifact");
  const spid = sealedProgramId();
  const lines: string[] = [];
  let pass = 0, fail = 0;
  const note = (ok: boolean, label: string, detail = "") => { lines.push(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const raw = new Map<string, Buffer>((snap?.sealed ?? []).map((e: any) => [e.pubkey, Buffer.from(e.data, "base64")]));

  // [1] bank identity — PDA re-derives from [benchmark, authority, u32le(id)].
  const [bankPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("benchmark"), new PublicKey(card.bank.authority).toBuffer(), u32le(card.bank.id)], spid);
  note(bankPda.toBase58() === card.bank.pk, "bank PDA", `[benchmark, authority, id=${card.bank.id}] → ${card.bank.pk.slice(0, 8)}…`);

  // [2] chunk set — every listed chunk PDA re-derives, and the card's
  // enumeration is COMPLETE vs the snapshot (no chunk can hide).
  let cBad = 0;
  for (const c of card.chunks.public) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("items"), bankPda.toBuffer(), u16le(c.index)], spid);
    if (pda.toBase58() !== c.pk) cBad++;
  }
  for (const c of card.chunks.private) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("pitems"), bankPda.toBuffer(), u16le(c.index)], spid);
    if (pda.toBase58() !== c.pk) cBad++;
  }
  let complete = true, bound = 0;
  if (ss) {
    const onBank = (a: any) => (a.account.benchmark as PublicKey)?.toBase58() === card.bank.pk;
    const realI = snapOf(ss, "ItemChunk").filter(onBank), realP = snapOf(ss, "PrivItemChunk").filter(onBank);
    const cardSet = new Set([...card.chunks.public, ...card.chunks.private].map((c: any) => c.pk));
    const realSet = new Set([...realI, ...realP].map((c) => c.publicKey.toBase58()));
    complete = cardSet.size === realSet.size && [...cardSet].every((k) => realSet.has(k));
    for (const [list, real] of [[card.chunks.public, realI], [card.chunks.private, realP]] as const) {
      const rMap = new Map(real.map((c) => [c.publicKey.toBase58(), c]));
      for (const c of list) {
        const r = rMap.get(c.pk);
        if (r && Number(r.account.index) === c.index && Number(r.account.partsWritten) === c.partsWritten &&
            JSON.stringify((r.account.mintOrder as any[]).map(Number)) === JSON.stringify(c.mintOrder)) bound++;
      }
    }
  }
  note(cBad === 0 && complete && (!ss || bound === card.chunks.public.length + card.chunks.private.length),
    "chunk set", `${card.chunks.public.length} items + ${card.chunks.private.length} pitems PDAs re-derive${ss ? ` · ${bound} field-bound · complete` : ""}`);

  // [3] items_root — replay the on-chain fold from the PINNED account
  // bytes in mint_order landing sequence. Generated banks fold spec
  // bytes; private banks fold ciphertexts+nonces — both proofs that the
  // commitment equals exactly these chunks, nothing else.
  let foldMsg = "no snapshot — fold not replayed", foldOk = !!snapPath;
  if (snapPath) {
    const foldable = card.chunks.public.length ? card.chunks.public : card.chunks.private;
    const priv = !card.chunks.public.length && card.chunks.private.length > 0;
    if (!foldable.length) {
      foldMsg = `authored bank — items_root is an externally-committed merkle root (no on-chain fold); bound to account field`;
      foldOk = true;
    } else {
      try {
        const steps: { seq: number; ci: number; part: number; bytes: Uint8Array }[] = [];
        for (const c of foldable) {
          const buf = raw.get(c.pk);
          if (!buf) { foldOk = false; foldMsg = `chunk ${c.pk.slice(0, 8)}… not in snapshot`; break; }
          const st = priv ? decodePrivItemChunk(buf) : decodeItemChunk(buf);
          for (let part = 0; part * PART < CHUNK; part++) {
            if (!(st.partsWritten & (1 << part))) continue;
            const bytes = priv
              ? (() => { const s = st as PrivItemChunkState; const e = new Uint8Array(2 * 32 + 16);
                  for (let k = 0; k < 2; k++) e.set(s.ciphertexts[part * 2 + k], k * 32);
                  const nb = new Uint8Array(16); let n = s.nonces[part];
                  for (let i = 0; i < 16; i++) { nb[i] = Number(n & 0xffn); n >>= 8n; }
                  e.set(nb, 64); return e; })()
              : (() => { const s = st as ItemChunkState; const b = new Uint8Array(PART * 5);
                  for (let k = 0; k < PART; k++) b.set(specBytes(s.specs[part * PART + k]), k * 5); return b; })();
            steps.push({ seq: st.mintOrder[part], ci: c.index, part, bytes });
          }
        }
        if (foldOk) {
          let root: Uint8Array = new Uint8Array(32);
          for (const s of steps.sort((a, b) => a.seq - b.seq))
            root = priv ? privItemsFold(root, s.ci, s.part, s.bytes) : genItemsFold(root, s.ci, s.part, s.bytes);
          const got = Buffer.from(root).toString("hex");
          foldOk = got === card.bank.itemsRoot;
          foldMsg = `${steps.length} parts re-folded in landing order → ${got.slice(0, 12)}… ${got === card.bank.itemsRoot ? "== items_root" : `!= items_root ${card.bank.itemsRoot.slice(0, 12)}…`}`;
        }
      } catch (e) { foldOk = false; foldMsg = `fold replay threw: ${(e as Error).message}`; }
    }
  }
  note(foldOk, "items_root fold", foldMsg);

  // [4] bank fields — every declared field equals the decoded account.
  let fBad = 0;
  if (ss) {
    const real = snapOf(ss, "Benchmark").find((x) => x.publicKey.toBase58() === card.bank.pk)?.account;
    if (!real) fBad++;
    else {
      const cmp = (a: any, b: any) => String(a) === String(b);
      if (!cmp(real.authority.toBase58(), card.bank.authority) || !cmp(real.id, card.bank.id) ||
          !cmp(real.name, card.bank.name) || !cmp(real.kind, card.bank.kind) ||
          !cmp(real.chunkCount, card.bank.chunkCount) || !cmp(real.chunksSealed, card.bank.chunksSealed) ||
          Buffer.from(real.itemsRoot).toString("hex") !== card.bank.itemsRoot ||
          !cmp(real.feeLamports, card.bank.feeLamports) || !cmp(real.runCount, card.bank.runCount) ||
          !cmp(real.revealCount ?? 0, card.bank.revealCount) || !cmp(real.createdAt, card.bank.createdAt) ||
          !cmp(real.status, card.bank.status)) fBad++;
    }
    note(fBad === 0, "bank fields", "authority · id · name · kind · counts · items_root · fee · status all equal the decoded account");
  }

  // [5] run surface — PDAs re-derive + completeness vs snapshot.
  let rBad = 0;
  for (const r of card.runs) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("run"), bankPda.toBuffer(), u64le(BigInt(r.index))], spid);
    if (pda.toBase58() !== r.pk) rBad++;
  }
  let rBound = 0;
  if (ss) {
    const realRuns = new Map(snapOf(ss, "Run").filter((r) => (r.account.benchmark as PublicKey).toBase58() === card.bank.pk)
      .map((r) => [r.publicKey.toBase58(), r]));
    if (realRuns.size !== card.runs.length) rBad++;
    for (const r of card.runs) {
      const real = realRuns.get(r.pk)?.account;
      if (real && Number(real.index) === r.index && String(real.modelId) === r.modelId &&
          Number(real.status) === r.status && Number(real.correct) === r.correct &&
          Number(real.postReveal ?? 0) === r.postReveal) rBound++;
      else rBad++;
    }
  }
  note(rBad === 0, "run surface", `${card.runs.length} runs — PDAs re-derive${ss ? ` · ${rBound} field-bound · complete` : ""}`);

  // [6] disclosure surface — reveals + grants re-derive and enumerate
  // completely: the card claims "this is EVERYTHING disclosed on this exam".
  let dBad = 0;
  for (const r of card.reveals) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reveal"), bankPda.toBuffer(), u16le(r.chunkIndex), Uint8Array.of(r.part)], spid);
    if (pda.toBase58() !== r.pk) dBad++;
  }
  for (const g of card.grants) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant"), bankPda.toBuffer(), u16le(g.chunkIndex), Uint8Array.of(g.part), new PublicKey(g.viewer).toBuffer()], spid);
    if (pda.toBase58() !== g.pk) dBad++;
  }
  if (ss) {
    const onBank = (a: any) => (a.account.benchmark as PublicKey)?.toBase58() === card.bank.pk;
    if (snapOf(ss, "Reveal").filter(onBank).length !== card.reveals.length) dBad++;
    if (snapOf(ss, "ShareGrant").filter(onBank).length !== card.grants.length) dBad++;
  }
  note(dBad === 0, "disclosure surface", `${card.reveals.length} reveals + ${card.grants.length} grants — PDAs re-derive${ss ? " · counts complete" : ""}`);

  // [7] receipts — every ScoreLog on this bank enumerated + field-bound.
  let lBad = 0;
  if (ss) {
    const real = new Map(snapOf(ss, "ScoreLog").filter((l) => (l.account.benchmark as PublicKey).toBase58() === card.bank.pk)
      .map((l) => [l.publicKey.toBase58(), l]));
    if (real.size !== card.receipts.length) lBad++;
    for (const l of card.receipts) {
      const r = real.get(l.pk)?.account;
      if (!r || (r.run as PublicKey).toBase58() !== l.run ||
          (r.modelRecord as PublicKey).toBase58() !== l.modelRecord ||
          Number(r.correct) !== l.correct || Number(r.items) !== l.items ||
          Number(r.vouchedAtRecord ?? 0) !== l.vouched || Number(r.postReveal ?? 0) !== l.postReveal ||
          Number(r.recordedAt) !== l.recordedAt) lBad++;
    }
  }
  note(!ss || lBad === 0, "receipt surface", `${card.receipts.length} score receipts on this bank — field-bound${ss ? " · complete" : ""}`);

  // [8] snapshot binding.
  if (snapPath) {
    const digest = createHash("sha256").update(readFileSync(snapPath)).digest("hex");
    note(digest === card.snapshot, "snapshot binding", `sha256(${basename(snapPath)}) == card.snapshot`);
  }

  const ok = fail === 0;
  if (json) console.log(JSON.stringify({ kind: card.kind, ok, pass, fail, lines }, null, 2));
  else {
    console.log(`sealed-bank/v1 — ${basename(file)}`);
    for (const l of lines) console.log(`  ${l}`);
    console.log(ok
      ? `BANK VERIFIED — ${card.bank.name} · ${card.chunks.public.length + card.chunks.private.length} chunks · ${card.runs.length} runs · ${card.reveals.length} reveals · ${card.grants.length} grants`
      : "BANK FAILED");
  }
  if (!ok) process.exitCode = 1;
  return { ok, pass, fail };
}

/** `chain market position <pk> --prove <f>` — mints `sealed-position/v1`:
 *  the bettor's portable receipt. Both PDAs (position [position, venue,
 *  bettor] and its venue [market|ladder|dark, run|firstLeg, salt]), the
 *  stake payload (amounts, or dark commitment+nonce state), the venue's
 *  settlement fields, and the payable/lost/refund verdict — snapshot-bound. */
export async function positionProve(posPkStr: string, out: string, snapPath?: string) {
  let markets: SnapAccount[], ladders: SnapAccount[], darks: SnapAccount[],
      positions: SnapAccount[], darkPositions: SnapAccount[];
  if (snapPath) {
    const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
    [markets, ladders, darks, positions, darkPositions] =
      [snapOf(sm, "Market"), snapOf(sm, "Ladder"), snapOf(sm, "DarkMarket"), snapOf(sm, "Position"), snapOf(sm, "DarkPosition")];
  } else {
    const { market } = marketProgram();
    const mAcct = market.account as any;
    [markets, ladders, darks, positions, darkPositions] = await Promise.all([
      mAcct.market.all(), mAcct.ladder.all(), mAcct.darkMarket.all(),
      mAcct.position.all(), mAcct.darkPosition.all(),
    ]);
  }
  const pk = new PublicKey(posPkStr);
  const pos = positions.find((x) => x.publicKey.equals(pk));
  const dpos = darkPositions.find((x) => x.publicKey.equals(pk));
  if (!pos && !dpos) throw new Error(`position ${posPkStr} not found (checked Position + DarkPosition)`);
  const bettor = (pos ?? dpos)!.account.bettor.toBase58();
  const venuePk = (pos ?? dpos)!.account.market.toBase58();
  const maps = venueMapsOf(markets, ladders, darks);
  const venue = maps.mk.get(venuePk) ?? maps.lk.get(venuePk) ?? maps.dk.get(venuePk);
  if (!venue) throw new Error(`venue ${venuePk} missing — a position card can't claim a phantom venue`);
  // dark positions carry a bettor-chosen pos_salt seed — not stored on the
  // account. Recover it by probing the derivation space [0, 256).
  let posSalt: string | null = null;
  if (dpos) {
    for (let s = 0n; s < 256n; s++) {
      if (darkPosPda(new PublicKey(venuePk), new PublicKey(bettor), s).toBase58() === posPkStr) { posSalt = s.toString(); break; }
    }
    if (posSalt === null) throw new Error(`dark position pos_salt not in [0,256) — the seed is bettor-chosen and unrecoverable; this position can't be carded keyless`);
  }
  const row = classifyPositions(pos ? [pos] : [], dpos ? [dpos] : [], maps, bettor).rows[0];
  // the venue's PDA seeds — straight from its account fields.
  const rawVenue = [...markets, ...ladders, ...darks].find((v) => v.publicKey.toBase58() === venuePk)!.account as any;
  const seeds: any = venue.kind === "ladder"
    ? { firstLeg: rawVenue.legs[0].toBase58(), salt: rawVenue.salt.toString() }
    : { run: rawVenue.run.toBase58(), salt: rawVenue.salt.toString() };
  const card: any = {
    kind: "sealed-position/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath ?? "live",
    programs: { sealed: sealedProgramId().toBase58(), market: MARKET_PROGRAM_ID.toBase58() },
    snapshotSha256: snapPath ? createHash("sha256").update(readFileSync(snapPath)).digest("hex") : null,
    position: { pk: posPkStr, account: pos ? "position" : "dark", seeds: { venue: venuePk, bettor, posSalt } },
    stake: pos
      ? { amounts: (pos.account.amounts as any[]).map((a) => a.toString()) }
      : { amount: dpos!.account.amount.toString(), commitment: Buffer.from(dpos!.account.commitment as number[]).toString("hex"), revealed: dpos!.account.revealed },
    venue: {
      pk: venuePk, kind: venue.kind, seeds,
      status: venue.status, outcome: (venue as any).outcome ?? null, mask: (venue as any).mask ?? null,
      tallied: (venue as any).tallied ?? null,
      totals: (venue as any).totals?.map((t: bigint) => t.toString()) ?? null,
      poolTotal: (venue as any).poolTotal?.toString() ?? null,
      winTotal: (venue as any).winTotal?.toString() ?? null,
      feeBps: venue.feeBps,
    },
    verdict: { state: row.state, staked: row.staked.toString(), estPayout: row.est.toString(), note: row.note },
  };
  writeFileSync(out, JSON.stringify(card, null, 2));
  console.log(`sealed-position/v1 → ${out}`);
  console.log(`  ${posPkStr} — ${venue.kind} venue, ${row.state}${row.est > 0n ? ` ~${solAmt(row.est)} SOL` : ""}`);
  console.log(`  verify: sealed chain market position --verify ${out} --snapshot <snapshot.json>`);
  return card;
}

/** Replays `sealed-position/v1` keyless — six checks: both PDAs
 *  (position [position, venue, bettor]; venue per its kind), the stake
 *  payload field-bound to the snapshot account, the venue's settlement
 *  fields bound likewise, the payable/lost verdict re-derived by the same
 *  parimutuel math the dossiers use, and the snapshot sha. */
export async function positionVerify(file: string, json = false, snapPath?: string): Promise<any> {
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-position/v1") throw new Error("not a sealed-position/v1 artifact");
  let pass = 0, fail = 0;
  const lines: string[] = [];
  const note = (ok: boolean, name: string, detail = "") => { ok ? pass++ : fail++; lines.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const mpid = new PublicKey(card.programs.market);
  const venuePk = new PublicKey(card.venue.pk), bettorPk = new PublicKey(card.position.seeds.bettor);
  // [1] position PDA — dark positions carry the bettor-chosen pos_salt seed
  const posPda = card.position.account === "dark"
    ? darkPosPda(venuePk, bettorPk, BigInt(card.position.seeds.posSalt ?? "0"), mpid)
    : PublicKey.findProgramAddressSync([Buffer.from("position"), venuePk.toBuffer(), bettorPk.toBuffer()], mpid)[0];
  note(posPda.toBase58() === card.position.pk, "position PDA", card.position.account === "dark" ? `[darkpos, venue, bettor, pos_salt=${card.position.seeds.posSalt}]` : `[position, venue, bettor] @ market program`);
  // [2] venue PDA
  const salt = BigInt(card.venue.seeds.salt);
  const vseeds = card.venue.kind === "ladder"
    ? [Buffer.from("ladder"), new PublicKey(card.venue.seeds.firstLeg).toBuffer(), u64le(salt)]
    : card.venue.kind === "dark"
      ? [Buffer.from("dark"), new PublicKey(card.venue.seeds.run).toBuffer(), u64le(salt)]
      : [Buffer.from("market"), new PublicKey(card.venue.seeds.run).toBuffer(), u64le(salt)];
  const [venuePda] = PublicKey.findProgramAddressSync(vseeds, mpid);
  note(venuePda.toBase58() === card.venue.pk, "venue PDA", `${card.venue.kind} seeds re-derive`);
  // [3+4] snapshot account bindings
  let markets: SnapAccount[] = [], ladders: SnapAccount[] = [], darks: SnapAccount[] = [],
      positions: SnapAccount[] = [], darkPositions: SnapAccount[] = [];
  let bound = false;
  if (snapPath) {
    const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
    [markets, ladders, darks, positions, darkPositions] =
      [snapOf(sm, "Market"), snapOf(sm, "Ladder"), snapOf(sm, "DarkMarket"), snapOf(sm, "Position"), snapOf(sm, "DarkPosition")];
    bound = true;
  }
  const cmp = (a: any, b: any) => String(a) === String(b);
  const realPos = positions.find((x) => x.publicKey.toBase58() === card.position.pk)
    ?? darkPositions.find((x) => x.publicKey.toBase58() === card.position.pk);
  if (!bound || !realPos) note(false, "position account binding", bound ? "position not in the snapshot" : "no snapshot to bind against");
  else {
    let ok = cmp(realPos.account.bettor.toBase58(), card.position.seeds.bettor)
      && cmp(realPos.account.market.toBase58(), card.position.seeds.venue);
    if (card.position.account === "dark")
      ok &&= cmp(realPos.account.amount, card.stake.amount)
        && Buffer.from(realPos.account.commitment as number[]).toString("hex") === card.stake.commitment
        && cmp(realPos.account.revealed, card.stake.revealed);
    else
      ok &&= JSON.stringify((realPos.account.amounts as any[]).map((a) => a.toString())) === JSON.stringify(card.stake.amounts);
    note(ok, "stake binding", "bettor/venue/stake fields equal the decoded position account");
  }
  const realVenue = [...markets, ...ladders, ...darks].find((v) => v.publicKey.toBase58() === card.venue.pk)?.account as any;
  if (!bound || !realVenue) note(false, "venue binding", bound ? "venue not in the snapshot" : "no snapshot to bind against");
  else {
    const ok = cmp(realVenue.status, card.venue.status) && cmp(realVenue.feeBps, card.venue.feeBps)
      && (card.venue.outcome === null || cmp(realVenue.outcome, card.venue.outcome))
      && (card.venue.mask === null || cmp(realVenue.resultMask, card.venue.mask))
      && (card.venue.totals === null || JSON.stringify((realVenue.totals as any[]).map((t) => t.toString())) === JSON.stringify(card.venue.totals))
      && (card.venue.poolTotal === null || cmp(realVenue.poolTotal, card.venue.poolTotal))
      && (card.venue.winTotal === null || cmp(realVenue.winTotal, card.venue.winTotal))
      && (card.venue.tallied === null || cmp(realVenue.tallied, card.venue.tallied));
    note(ok, "venue binding", "status · outcome/mask · pools · fee all equal the decoded venue account");
  }
  // [5] verdict replay — the same parimutuel math the dossiers print.
  if (bound && realPos && realVenue) {
    const maps = venueMapsOf(markets, ladders, darks);
    const row = classifyPositions(card.position.account === "dark" ? [] : [realPos], card.position.account === "dark" ? [realPos] : [], maps, card.position.seeds.bettor).rows[0];
    const ok = !!row && row.state === card.verdict.state && row.est.toString() === card.verdict.estPayout && row.staked.toString() === card.verdict.staked;
    note(ok, "verdict replay", row ? `recomputed ${row.state}${row.est > 0n ? ` ~${solAmt(row.est)} SOL` : ""}` : "position unclassifiable");
  } else note(false, "verdict replay", "missing account binding — cannot replay");
  // [6] snapshot binding
  if (snapPath && card.snapshotSha256)
    note(createHash("sha256").update(readFileSync(snapPath)).digest("hex") === card.snapshotSha256, "snapshot binding", `sha256 ${card.snapshotSha256.slice(0, 16)}…`);
  const ok = fail === 0;
  if (json) console.log(JSON.stringify({ kind: card.kind, ok, pass, fail, lines }, null, 2));
  else {
    console.log(`sealed-position/v1 — ${basename(file)}`);
    for (const l of lines) console.log(`  ${l}`);
    console.log(ok
      ? `POSITION VERIFIED — ${card.verdict.state} · staked ${solAmt(BigInt(card.verdict.staked))} SOL${BigInt(card.verdict.estPayout) > 0n ? ` · pays ~${solAmt(BigInt(card.verdict.estPayout))} SOL` : ""} · ${card.venue.kind} venue`
      : "POSITION FAILED");
  }
  if (!ok) process.exitCode = 1;
  return { ok, pass, fail };
}

/** `chain market bounty card <pk> --prove <f>` — mints
 * `sealed-bounty/v1`: the sponsor's portable claim certificate. The
 * bounty PDA re-derives ([bounty, bank, sponsor, salt]), every account
 * field binds to the decoded ledger, and when claimed the
 * `bounty_qualifies` gate replays against the winner run —
 * same bank, postdates the bounty, runner ≠ sponsor, score ≥ threshold,
 * finalized-or-proven — plus the open/expired verdict and the snapshot
 * sha. */
export async function bountyProve(bountyPkStr: string, out: string, snapPath?: string) {
  const [bounties, runs, banks]: [SnapAccount[], SnapAccount[], SnapAccount[]] = snapPath
    ? (() => { const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
        const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
        return [snapOf(sm, "Bounty"), snapOf(ss, "Run"), snapOf(ss, "Benchmark")]; })()
    : await Promise.all([(marketProgram().market.account as any).bounty.all(),
        (sealedProgram().program.account as any).run.all(),
        (sealedProgram().program.account as any).benchmark.all()]);
  const pk = new PublicKey(bountyPkStr);
  const b = bounties.find((x) => x.publicKey.equals(pk));
  if (!b) throw new Error(`bounty ${bountyPkStr} not found`);
  const acct = b.account as any;
  const bank = banks.find((x) => x.publicKey.equals(acct.bank));
  const winner = acct.status === 1
    ? runs.find((x) => x.publicKey.equals(acct.winnerRun)) : undefined;
  if (acct.status === 1 && !winner) throw new Error("claimed bounty but winner run absent from the ledger — incomplete snapshot");
  const w = winner?.account as any;
  const card: any = {
    kind: "sealed-bounty/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath ?? "live",
    programs: { sealed: sealedProgramId().toBase58(), market: MARKET_PROGRAM_ID.toBase58() },
    snapshotSha256: snapPath ? createHash("sha256").update(readFileSync(snapPath)).digest("hex") : null,
    bounty: {
      pk: bountyPkStr,
      seeds: { bank: (acct.bank as PublicKey).toBase58(), sponsor: (acct.sponsor as PublicKey).toBase58(), salt: acct.salt.toString() },
      status: acct.status,
      threshold: Number(acct.threshold),
      amount: acct.amount.toString(),
      deadline: acct.deadline.toString(),
      createdAt: acct.createdAt.toString(),
      winnerRun: acct.status === 1 ? (acct.winnerRun as PublicKey).toBase58() : null,
      winningScore: acct.status === 1 ? Number(acct.winningScore) : null,
    },
    bank: bank ? { pk: bank.publicKey.toBase58(), name: (bank.account as any).name, capacity: Number((bank.account as any).chunkCount) * 32 } : null,
    winner: winner ? {
      run: winner.publicKey.toBase58(),
      runner: (w.runner as PublicKey).toBase58(),
      benchmark: (w.benchmark as PublicKey).toBase58(),
      correct: Number(w.correct), status: w.status,
      createdAt: w.createdAt.toString(), scoredMask: (w.scoredMask ?? 0).toString(),
      firstPendingAt: (w.firstPendingAt ?? 0).toString(), allQueuedAt: (w.allQueuedAt ?? 0).toString(),
      postReveal: !!w.postReveal,
    } : null,
    verdict: {
      state: acct.status === 1 ? "claimed" : "open",
      amount: acct.amount.toString(),
      note: acct.status === 1
        ? `run ${(acct.winnerRun as PublicKey).toBase58().slice(0, 12)}… scored ${acct.winningScore} ≥ threshold ${acct.threshold} — pot paid run.runner, no referee`
        : "pot still escrowed — first proven run ≥ threshold claims it",
    },
  };
  writeFileSync(out, JSON.stringify(card, null, 2));
  console.log(`sealed-bounty/v1 → ${out}`);
  console.log(`  ${bountyPkStr} — ${card.verdict.state} · ${acct.status === 1 ? "pot paid to runner" : `${solAmt(BigInt(card.bounty.amount))} SOL escrowed`} · threshold ${card.bounty.threshold}`);
  console.log(`  verify: sealed chain market bounty card --verify ${out} --snapshot <snapshot.json>`);
  return card;
}

/** Replays `sealed-bounty/v1` keyless — the sponsor-side twin of the
 *  bettor's position card: bounty PDA, account binding, the
 *  bounty_qualifies gate replayed over the embedded winner run, the
 *  claim verdict, and the snapshot sha. */
export async function bountyVerify(file: string, json = false, snapPath?: string): Promise<any> {
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-bounty/v1") throw new Error("not a sealed-bounty/v1 artifact");
  let pass = 0, fail = 0;
  const lines: string[] = [];
  const note = (ok: boolean, name: string, detail = "") => { ok ? pass++ : fail++; lines.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const mpid = new PublicKey(card.programs.market);
  // [1] bounty PDA — [bounty, bank, sponsor, salt]
  const [bountyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bounty"), new PublicKey(card.bounty.seeds.bank).toBuffer(),
     new PublicKey(card.bounty.seeds.sponsor).toBuffer(), u64le(BigInt(card.bounty.seeds.salt))], mpid);
  note(bountyPda.toBase58() === card.bounty.pk, "bounty PDA", "[bounty, bank, sponsor, salt] @ market program");
  // [2] account binding — every card field equals the decoded Bounty
  let bound = false, bAcct: any = null, winnerAcct: any = null;
  if (snapPath) {
    const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
    const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
    const found = snapOf(sm, "Bounty").find((x) => x.publicKey.toBase58() === card.bounty.pk);
    bAcct = found?.account as any;
    bound = true;
    if (card.bounty.status === 1)
      winnerAcct = (snapOf(ss, "Run").find((x) => x.publicKey.toBase58() === card.bounty.winnerRun)?.account) as any;
    const cmp = (a: any, b: any) => String(a) === String(b);
    note(!!bAcct && cmp(card.bounty.threshold, bAcct.threshold) && cmp(card.bounty.amount, bAcct.amount) &&
      cmp(card.bounty.status, bAcct.status) && cmp(card.bounty.deadline, bAcct.deadline) &&
      cmp(card.bounty.createdAt, bAcct.createdAt) &&
      cmp(card.bounty.seeds.bank, (bAcct.bank as PublicKey).toBase58()) &&
      cmp(card.bounty.seeds.sponsor, (bAcct.sponsor as PublicKey).toBase58()) &&
      cmp(card.bounty.winnerRun ?? "null", bAcct.status === 1 ? (bAcct.winnerRun as PublicKey).toBase58() : "null") &&
      cmp(card.bounty.winningScore ?? "null", bAcct.status === 1 ? bAcct.winningScore : "null"),
      "account binding", "threshold · amount · status · deadline · seeds · winner all equal the decoded Bounty");
  } else note(false, "account binding", "needs --snapshot");
  // [3] qualifies replay — the program's bounty_qualifies gate over the
  // embedded winner run (claimed cards only).
  if (card.bounty.status === 1) {
    const w = card.winner;
    if (w) {
      const sameBank = w.benchmark === card.bounty.seeds.bank;
      const postdates = BigInt(w.createdAt) >= BigInt(card.bounty.createdAt);
      const notSelf = w.runner !== card.bounty.seeds.sponsor;
      const meets = w.correct >= card.bounty.threshold;
      const scoreMatch = w.correct === card.bounty.winningScore;
      const provenNow = proven({ pubkey: w.run, benchmark: w.benchmark, runner: w.runner,
        status: w.status, correct: w.correct, createdAt: Number(w.createdAt),
        firstPendingAt: Number(w.firstPendingAt), allQueuedAt: Number(w.allQueuedAt),
        scoredMask: w.scoredMask, postReveal: w.postReveal } as BoardRun, Math.floor(Date.now() / 1000));
      const notPostReveal = !w.postReveal;
      note(sameBank && postdates && notSelf && meets && scoreMatch && provenNow && notPostReveal,
        "bounty_qualifies replay",
        `bank=${sameBank} postdates=${postdates} runner≠sponsor=${notSelf} score≥threshold=${meets} score==winning=${scoreMatch} proven=${provenNow} !post-reveal=${notPostReveal}`);
      if (winnerAcct) note(w.correct === Number(winnerAcct.correct) && w.runner === (winnerAcct.runner as PublicKey).toBase58(),
        "winner binding", "run account fields equal the decoded Run");
    } else note(false, "bounty_qualifies replay", "claimed card without a winner run");
  } else {
    // open card — a claim is still possible; the verdict is the gate
    // itself: anyone can CHECK whether a qualifying run exists.
    note(true, "verdict", "open — pot still escrowed, no referee needed to claim it");
  }
  // [4] bank context — threshold can't exceed the bank's capacity. When
  // the snapshot is present, capacity comes from the decoded Benchmark
  // account (a forged card shrinking card.bank.capacity dies here).
  if (card.bank) {
    let cap = card.bank.capacity;
    if (snapPath) {
      const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
      const realBank = snapOf(ss, "Benchmark").find((x) => x.publicKey.toBase58() === card.bank.pk)?.account as any;
      if (realBank) cap = Number(realBank.chunkCount) * 32;
    }
    note(card.bounty.threshold <= cap, "threshold ≤ capacity", `${card.bounty.threshold} ≤ ${cap} (${card.bank.name})`);
  }
  // [5] snapshot binding
  if (snapPath && card.snapshotSha256)
    note(createHash("sha256").update(readFileSync(snapPath)).digest("hex") === card.snapshotSha256, "snapshot binding", `sha256 ${card.snapshotSha256.slice(0, 16)}…`);
  const ok = fail === 0;
  if (json) console.log(JSON.stringify({ kind: card.kind, ok, pass, fail, lines }, null, 2));
  else {
    console.log(`sealed-bounty/v1 — ${basename(file)}`);
    for (const l of lines) console.log(`  ${l}`);
    console.log(ok
      ? `BOUNTY VERIFIED — ${card.verdict.state} · ${card.bounty.status === 1 ? `pot paid to runner · winner ${card.bounty.winningScore}/${card.bank?.capacity ?? "?"} beat threshold ${card.bounty.threshold}` : `${solAmt(BigInt(card.bounty.amount))} SOL escrowed · threshold ${card.bounty.threshold}`}`
      : "BOUNTY FAILED");
  }
  if (!ok) process.exitCode = 1;
  return { ok, pass, fail };
}

/** `chain grant <pk> --prove <f> --snapshot <f2>` — mints
 * `sealed-grant/v1`: the viewer's disclosure certificate. A ShareGrant
 * is the only on-chain proof that exam questions moved — reshare_part
 * re-encrypted one private-bank part to a delegate's x25519 key inside
 * MPC, and this card proves it: the 5-seed PDA re-derives ([grant,
 * bank, chunk_u16, part_u8, viewer32] — the viewer seed is raw x25519
 * bytes, not an ed25519 pubkey), every account field binds to the
 * decoded ShareGrant, the encryption_key echo proves the circuit wrote
 * to the key it was asked for, and the panel tally re-derives from the
 * snapshot. Answers are never in a grant — only the questions moved. */
export async function grantProve(grantPkStr: string, out: string, snapPath?: string) {
  const ss = snapPath
    ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed")
    : null;
  const [grants, banks]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "ShareGrant"), snapOf(ss, "Benchmark")]
    : await Promise.all([(sealedProgram().program.account as any).shareGrant.all(),
        (sealedProgram().program.account as any).benchmark.all()]);
  const pk = new PublicKey(grantPkStr);
  const g = grants.find((x) => x.publicKey.equals(pk));
  if (!g) throw new Error(`grant ${grantPkStr} not found`);
  const a = g.account as any;
  const viewerB58 = new PublicKey(Buffer.from(a.viewer)).toBase58();
  const bank = banks.find((x) => x.publicKey.equals(a.benchmark));
  const bankPk = (a.benchmark as PublicKey).toBase58();
  const onBank = grants.filter((x) => (x.account.benchmark as PublicKey).toBase58() === bankPk);
  const viewers = new Set(onBank.map((x) => new PublicKey(Buffer.from(x.account.viewer)).toBase58()));
  const fullPanels = [...viewers].filter((v) =>
    new Set(onBank.filter((x) => new PublicKey(Buffer.from(x.account.viewer)).toBase58() === v)
      .map((x) => Number(x.account.part))).size >= 4).length;
  const card: any = {
    kind: "sealed-grant/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath ?? "live",
    programs: { sealed: sealedProgramId().toBase58(), market: MARKET_PROGRAM_ID.toBase58() },
    snapshotSha256: snapPath ? createHash("sha256").update(readFileSync(snapPath)).digest("hex") : null,
    grant: {
      pk: grantPkStr,
      seeds: { bank: bankPk, chunkIndex: Number(a.chunkIndex), part: Number(a.part), viewer: viewerB58 },
      benchmark: bankPk,
      chunkIndex: Number(a.chunkIndex), part: Number(a.part),
      viewer: viewerB58,
      encryptionKey: new PublicKey(Buffer.from(a.encryptionKey)).toBase58(),
      nonce: a.nonce.toString(),
      ciphertexts: (a.ciphertexts as any[]).map((c) => new PublicKey(Buffer.from(c)).toBase58()),
      sharedAt: a.sharedAt.toString(),
    },
    bank: bank ? { pk: bank.publicKey.toBase58(), name: (bank.account as any).name,
      kind: Number((bank.account as any).kind), itemsRoot: Buffer.from((bank.account as any).itemsRoot).toString("hex") } : null,
    panel: { grantsOnBank: onBank.length, viewersOnBank: viewers.size, viewersAllParts: fullPanels },
    verdict: {
      state: "disclosed",
      note: `part ${a.part} of bank "${(bank?.account as any)?.name ?? bankPk.slice(0, 10)}" re-encrypted to viewer ${viewerB58.slice(0, 12)}… inside MPC — only that x25519 key opens the specs; answers never moved`,
    },
  };
  writeFileSync(out, JSON.stringify(card, null, 2));
  console.log(`sealed-grant/v1 → ${out}`);
  console.log(`  ${grantPkStr} — ${card.bank?.name ?? "?"} part ${card.grant.part} → viewer ${viewerB58.slice(0, 12)}… · panel ${card.panel.viewersOnBank} viewers / ${card.panel.grantsOnBank} grants`);
  console.log(`  verify: sealed chain grant --verify ${out} --snapshot <snapshot.json>`);
  return card;
}

/** Replays `sealed-grant/v1` keyless — six checks: the 5-seed PDA
 *  (viewer is raw x25519 bytes, not a pubkey), the account binding,
 *  the circuit's key echo, bank privacy semantics, the re-derived
 *  panel tally, and the snapshot sha. */
export async function grantVerify(file: string, json = false, snapPath?: string): Promise<any> {
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-grant/v1") throw new Error("not a sealed-grant/v1 artifact");
  let pass = 0, fail = 0;
  const lines: string[] = [];
  const note = (ok: boolean, name: string, detail = "") => { ok ? pass++ : fail++; lines.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const spid = new PublicKey(card.programs.sealed);
  const b58bytes = (s: string) => new PublicKey(s).toBuffer();
  // [1] grant PDA — [grant, bank, chunk_u16le, part_u8, viewer32]
  const [gPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("grant"), b58bytes(card.grant.seeds.bank), u16le(Number(card.grant.seeds.chunkIndex)),
     Uint8Array.of(Number(card.grant.seeds.part)), b58bytes(card.grant.seeds.viewer)], spid);
  note(gPda.toBase58() === card.grant.pk, "grant PDA", "[grant, bank, chunk, part, viewer] — viewer is x25519, not a wallet");
  // [2] account binding — every card field equals the decoded ShareGrant.
  let gAcct: any = null;
  if (snapPath) {
    const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
    const found = snapOf(ss, "ShareGrant").find((x) => x.publicKey.toBase58() === card.grant.pk);
    gAcct = found?.account as any;
    if (gAcct) {
      const cmp = (x: any, y: any) => String(x) === String(y);
      const same32 = (x: any, b58: string) => new PublicKey(Buffer.from(x)).toBase58() === b58;
      note(cmp(card.grant.benchmark, (gAcct.benchmark as PublicKey).toBase58()) &&
        cmp(card.grant.chunkIndex, gAcct.chunkIndex) && cmp(card.grant.part, gAcct.part) &&
        same32(gAcct.viewer, card.grant.viewer) && same32(gAcct.encryptionKey, card.grant.encryptionKey) &&
        cmp(card.grant.nonce, gAcct.nonce) && cmp(card.grant.sharedAt, gAcct.sharedAt) &&
        (gAcct.ciphertexts as any[]).every((c, i) => same32(c, card.grant.ciphertexts[i])),
        "account binding", "bank · chunk · part · viewer · encKey · nonce · ciphertexts · sharedAt all equal the decoded ShareGrant");
    } else note(false, "account binding", "grant not in the snapshot");
  } else note(false, "account binding", "needs --snapshot");
  // [3] key echo — the circuit echoes the key it encrypted to; a
  // re-targeted grant would break this equality.
  note(card.grant.encryptionKey === card.grant.viewer, "key echo", "encryption_key == viewer — the MPC bound output to the requested key");
  // [4] bank binding + privacy semantics — grants only carry meaning on
  // ciphertext banks: a grant on an authored bank would disclose public
  // specs, which isn't evidence of anything.
  if (card.bank) {
    const bankOk = card.grant.benchmark === card.bank.pk && card.grant.seeds.bank === card.bank.pk;
    note(bankOk && Number(card.bank.kind) === 2, "bank semantics",
      `${card.bank.name} kind=${card.bank.kind} — ciphertext-only exam; the questions moved without publishing`);
  }
  // [5] panel tally — who else was shown the exam? Re-derived from the
  // snapshot, not the card's say-so.
  if (snapPath && gAcct) {
    const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
    const onBank = snapOf(ss, "ShareGrant").filter((x) => (x.account.benchmark as PublicKey).toBase58() === card.grant.benchmark);
    const viewers = new Set(onBank.map((x) => new PublicKey(Buffer.from(x.account.viewer)).toBase58()));
    const full = [...viewers].filter((v) =>
      new Set(onBank.filter((x) => new PublicKey(Buffer.from(x.account.viewer)).toBase58() === v)
        .map((x) => Number(x.account.part))).size >= 4).length;
    note(onBank.length === card.panel.grantsOnBank && viewers.size === card.panel.viewersOnBank && full === card.panel.viewersAllParts,
      "panel tally", `${onBank.length} grant(s) · ${viewers.size} viewer(s) · ${full} full-panel — re-derived`);
  }
  // [6] snapshot binding
  if (snapPath && card.snapshotSha256)
    note(createHash("sha256").update(readFileSync(snapPath)).digest("hex") === card.snapshotSha256, "snapshot binding", `sha256 ${card.snapshotSha256.slice(0, 16)}…`);
  const ok = fail === 0;
  if (json) console.log(JSON.stringify({ kind: card.kind, ok, pass, fail, lines }, null, 2));
  else {
    console.log(`sealed-grant/v1 — ${basename(file)}`);
    for (const l of lines) console.log(`  ${l}`);
    console.log(ok
      ? `GRANT VERIFIED — ${card.bank?.name ?? "?"} part ${card.grant.part} → viewer ${card.grant.viewer.slice(0, 12)}… · ${card.panel.viewersOnBank} viewer(s) saw this exam · the answers never moved`
      : "GRANT FAILED");
  }
  if (!ok) process.exitCode = 1;
  return { ok, pass, fail };
}

/** `chain compare --matrix [--top N] [--min-shared K]` — the N×N
 *  tournament table: every pair's shared-bank verdict as a cell.
 *  Leaderboards tell you who's ahead; the grid shows WHO beat WHOM —
 *  a model strong against the top tier but absent from the bottom half
 *  reads differently than an aggregate rank. Cell = signed pp delta on
 *  shared banks (row − column), `—` = disjoint coverage (unranked, not
 *  assumed), `·` = diagonal. */
export async function compareMatrix(top = 12, minShared = 1, json = false, snapPath?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [records, logs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all()]);
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
    wins: 0, losses: 0, ties: 0, rankedPairs: 0, ppDelta: 0,
  }));
  const cell = new Map<string, number | null>();
  let unranked = 0;
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    const a = byBank.get(recs[i].pk) ?? new Map(), b = byBank.get(recs[j].pk) ?? new Map();
    const shared = [...a.keys()].filter((k) => b.has(k));
    if (shared.length < minShared) { unranked++; cell.set(`${i}:${j}`, null); cell.set(`${j}:${i}`, null); continue; }
    const pa = shared.reduce((s, k) => s + a.get(k)!.correct, 0) / Math.max(1, shared.reduce((s, k) => s + a.get(k)!.items, 0));
    const pb = shared.reduce((s, k) => s + b.get(k)!.correct, 0) / Math.max(1, shared.reduce((s, k) => s + b.get(k)!.items, 0));
    recs[i].rankedPairs++; recs[j].rankedPairs++;
    const d = 100 * (pa - pb);
    recs[i].ppDelta += d; recs[j].ppDelta -= d;
    cell.set(`${i}:${j}`, d); cell.set(`${j}:${i}`, -d);
    if (pa > pb) { recs[i].wins++; recs[j].losses++; }
    else if (pa < pb) { recs[j].wins++; recs[i].losses++; }
    else { recs[i].ties++; recs[j].ties++; }
  }
  const ranked = recs.map((r, i) => ({ ...r, i }))
    .sort((x, y) => y.wins - x.wins || x.losses - y.losses || y.ppDelta - x.ppDelta)
    .slice(0, top);
  if (json) {
    console.log(JSON.stringify({ top: ranked.map((r) => r.modelId),
      cells: ranked.map((r) => ranked.map((c) => (c.i === r.i ? "diag" : cell.get(`${r.i}:${c.i}`) ?? null))),
      unrankedPairs: unranked }));
    return ranked;
  }
  const abc = (n: number) => { let s = ""; n += 1; while (n > 0) { s = String.fromCharCode(96 + ((n - 1) % 26 + 1)) + s; n = Math.floor((n - 1) / 26); } return s; };
  console.log(`paired-evidence grid — top ${ranked.length} by W-L, cell = row−col pp delta on shared banks:`);
  console.log(`      ${ranked.map((_, k) => abc(k).padStart(5)).join("")}`);
  for (let k = 0; k < ranked.length; k++) {
    const r = ranked[k];
    console.log(`  ${abc(k).padStart(2)}  ${ranked.map((c) => {
      if (c.i === r.i) return "   · ";
      const v = cell.get(`${r.i}:${c.i}`);
      return v === null || v === undefined ? "   — " : `${v >= 0 ? "+" : ""}${v.toFixed(0)}`.padStart(4) + " ";
    }).join("")} ${r.modelId}`);
  }
  const coverage = ranked.filter((r) => r.rankedPairs === 0).length;
  console.log(`  ${coverage ? `${coverage} shown model(s) have zero ranked pairs · ` : ""}${unranked} pair(s) ledger-wide share <${minShared} bank(s) — "—" is honest absence, not a loss.`);
  return ranked;
}

/** `chain matrix [--banks N]` — the capability matrix: models × the
 *  most-run banks, each cell the model's BEST finalized score there.
 *  Leaderboards aggregate over different exams; this shows the exam-by-
 *  exam coverage — a model strong on one bank and absent on nine others
 *  looks exactly like that. Post-reveal runs can't prove anything (the
 *  answers were public) so they mark the cell with *. */
export async function chainMatrix(nBanks = 10, json = false, snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [banks, runs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "Benchmark"), snapOf(ss, "Run")]
    : await Promise.all([acct().benchmark.all(), acct().run.all()]);
  const bankBy = new Map(banks.map((b) => [b.publicKey.toBase58(), b]));
  const fin = runs.filter((r) => Number(r.account.status) === 1);
  // the most-run banks — coverage is what makes a column meaningful
  const runCount = new Map<string, number>();
  for (const r of fin) {
    const k = (r.account.benchmark as PublicKey).toBase58();
    runCount.set(k, (runCount.get(k) ?? 0) + 1);
  }
  const cols = [...runCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, nBanks)
    .map(([pk, n]) => {
      const b = bankBy.get(pk)?.account;
      const base = b ? String(b.name) : pk.slice(0, 8);
      const id = b?.id !== undefined ? String(b.id) : "";
      return { pk, n, base, id, name: base };
    });
  // names aren't unique — generated banks all share "sealed-gen"; disambiguate
  // colliding column labels with the bank's on-chain id
  const nameCount = new Map<string, number>();
  for (const c of cols) nameCount.set(c.base, (nameCount.get(c.base) ?? 0) + 1);
  for (const c of cols) if ((nameCount.get(c.base) ?? 0) > 1 || c.base.length > 16) c.name = c.id ? `${c.base.slice(0, 12)}·${c.id}` : `${c.base.slice(0, 12)}·${c.pk.slice(0, 4)}`;
  const colSet = new Set(cols.map((c) => c.pk));
  // cell[model][bank] = {bestPct, anyPostReveal}
  const cell = new Map<string, Map<string, { pct: number; post: boolean }>>();
  for (const r of fin) {
    const k = (r.account.benchmark as PublicKey).toBase58();
    if (!colSet.has(k)) continue;
    const m = String(r.account.modelId);
    const pct = (100 * Number(r.account.correct)) / Math.max(1, Number(r.account.chunkCount) * 32);
    const row = cell.get(m) ?? new Map<string, { pct: number; post: boolean }>();
    const cur = row.get(k);
    const post = Boolean(r.account.postReveal);
    // a post-reveal score never displaces a clean one at the same level —
    // display the best CLEAN score; mark * only if that's the best there is
    if (!cur || (cur.post && !post) || (cur.post === post && pct > cur.pct)) row.set(k, { pct, post });
    cell.set(m, row);
  }
  const rows = [...cell.entries()].map(([model, m]) => {
    const cells = cols.map((c) => m.get(c.pk) ?? null);
    const covered = cells.filter(Boolean).length;
    const mean = covered ? cells.reduce((s, c) => s + (c?.pct ?? 0), 0) / covered : 0;
    return { model, cells, covered, mean };
  }).sort((a, b) => b.covered - a.covered || b.mean - a.mean);
  const out = { banks: cols.map((c) => ({ pk: c.pk, name: c.name, runs: c.n })),
    matrix: rows.map((r) => ({ model: r.model, banksCovered: r.covered, meanPct: Math.round(r.mean * 10) / 10,
      scores: r.cells.map((c) => (c ? { pct: Math.round(c.pct * 10) / 10, postReveal: c.post } : null)) })) };
  if (json) { console.log(JSON.stringify(out)); return out; }
  const w = Math.min(22, Math.max(12, ...cols.map((c) => c.name.length)) + 2);
  console.log(`capability matrix — ${rows.length} models × top ${cols.length} banks (best finalized score%, * = post-reveal)`);
  console.log(`${" ".padEnd(26)}${cols.map((c) => c.name.slice(0, w - 2).padStart(w)).join("")}`);
  for (const r of rows.slice(0, 20)) {
    const cells = r.cells.map((c) => (c === null ? "—" : `${c.pct.toFixed(0)}%${c.post ? "*" : ""}`).padStart(w)).join("");
    console.log(`  ${r.model.slice(0, 24).padEnd(24)}${cells}`);
  }
  console.log(`coverage matters: a model absent on a bank can't be compared there — "—" is unproven, not zero`);
  return out;
}

/** `chain model <pk|model_id>` — the fused per-model dossier. Four lenses
 *  exist and none fuse: the registry record (receipts), the paired-
 *  evidence rank, the settlement record, and the market's belief. This
 *  composes all of them plus the run history into one page — the whole
 *  answer to "what does the system know about this model?". */
export async function chainModel(keyOrName: string, json = false, snapPath?: string) {
  // resolve the record the same way modelRecordShow does — pk or the
  // [modelrec, sha256(model_id)] PDA — then fuse every lens on top of it.
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  let pda: PublicKey;
  try { pda = new PublicKey(keyOrName); }
  catch { [pda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest()], sealedProgramId()); }
  const recAcc = ss ? snapOf(ss, "ModelRecord").find((x) => x.publicKey.equals(pda)) : null;
  const rec: any = ss ? recAcc?.account : await acct().modelRecord.fetchNullable(pda);
  if (!rec) { console.log(`no model record at ${keyOrName}`); process.exitCode = 2; return null; }
  const modelId: string = String(rec.modelId);
  // the lenses print their own headers — silence them as a batch (one
  // save/restore around the whole Promise.all; per-call save/restore
  // races and can leave the console muted)
  const origLog = console.log; console.log = () => {};
  let ranked: any, champs: any, senti: any, runsRows: any, mx: any;
  try {
    [ranked, champs, senti, runsRows, mx] = await Promise.all([
      compareAll(true, snapPath), marketChampions(true, snapPath),
      marketSentiment(true, snapPath), runList({ snapPath, json: true, model: modelId }),
      chainMatrix(8, true, snapPath),
    ]);
  } finally { console.log = origLog; }
  const rank = (ranked as any[])?.findIndex?.((r: any) => r.modelId === modelId) ?? -1;
  const rankRow = rank >= 0 ? (ranked as any[])[rank] : null;
  const champ = (champs as any[])?.find?.((r: any) => r.model === modelId) ?? null;
  const belIdx = (senti as any[])?.findIndex?.((r: any) => r.model === modelId) ?? -1;
  const bel = belIdx >= 0 ? (senti as any[])[belIdx] : null;
  const runs = (runsRows as any[]) ?? [];
  const fin = runs.filter((r: any) => Number(r.status) === 1);
  const totalItems = Number(rec.totalItems), totalCorrect = Number(rec.totalCorrect);
  const out = {
    model: modelId, record: pda.toBase58(),
    registry: { runs: Number(rec.runsScored), correct: totalCorrect, items: totalItems,
      accuracyPct: totalItems ? Math.round((totalCorrect / totalItems) * 10000) / 100 : 0,
      bestScore: `${rec.bestCorrect}/${rec.bestItems}` },
    pairedEvidence: rankRow ? { rank: rank + 1, wins: rankRow.wins, losses: rankRow.losses, ties: rankRow.ties,
      ppDelta: Math.round(rankRow.ppDelta * 100) / 100, sharedBankResults: rankRow.sharedBanks } : { rank: null, note: "no shared-bank pairs — evidence-disjoint" },
    settlement: champ ? { duels: `${champ.duelW}W-${champ.duelD}D-${champ.duelL}L`, duelWinPct: champ.duelWinPct,
      ladderLegs: `${champ.ladderWins}/${champ.ladderEntries}`, bounties: champ.bounties } : null,
    marketBelief: bel ? { impliedWinPct: bel.impliedWinPct, impliedScore: bel.impliedScore, stakeWeighed: bel.stakeWeighed, convictionRank: belIdx + 1 } : null,
    divergence: rankRow || bel ? { evidenceRank: rankRow ? rank + 1 : null, convictionRank: bel ? belIdx + 1 : null,
      gap: rankRow && bel ? rank + 1 - (belIdx + 1) : null } : null,
    coverage: (() => { const mrow = (mx?.matrix as any[])?.find?.((r: any) => r.model === modelId);
      return mrow ? { banksCovered: mrow.banksCovered, ofBanks: (mx.banks as any[]).length, meanPct: mrow.meanPct } : null; })(),
    runs: { total: runs.length, finalized: fin.length,
      recent: runs.slice(0, 10).map((r: any) => ({ pk: r.pk, score: `${r.correct}/${r.items}`, bank: r.bankName, status: r.status })) },
  };
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`model ${modelId} — the four lenses on one page`);
  console.log(`  registry    — ${out.registry.runs} receipts · ${out.registry.correct}/${out.registry.items} items (${out.registry.accuracyPct}%)${out.registry.bestScore ? ` · best ${out.registry.bestScore}` : ""}`);
  { // trajectory — finalized runs in time order as a sparkline: whether the
    // ledger watched this model climb or slide is visible at a glance.
    const ticks = "▁▂▃▄▅▆▇█";
    const byT = fin.filter((r: any) => r.finalizedAt > 0).sort((a: any, b: any) => a.finalizedAt - b.finalizedAt);
    if (byT.length >= 2) {
      const spark = byT.slice(-24).map((r: any) => ticks[Math.min(7, Math.max(0, Math.floor(r.pct / 12.5)))]);
      const trend = byT.length >= 4
        ? (() => { const h = Math.floor(byT.length / 2); const a = byT.slice(0, h).reduce((s, r) => s + r.pct, 0) / h, b = byT.slice(-h).reduce((s, r) => s + r.pct, 0) / h;
            return b - a > 5 ? "rising" : a - b > 5 ? "falling" : "flat"; })()
        : "short history";
      console.log(`  trajectory  — ${spark.join("")} (${byT.length} runs, ${new Date(byT[0].finalizedAt * 1000).toISOString().slice(0, 10)} → ${new Date(byT.at(-1)!.finalizedAt * 1000).toISOString().slice(0, 10)} · ${trend})`);
    }
  }
  console.log(`  evidence    — ${out.pairedEvidence.rank ? `paired rank #${out.pairedEvidence.rank} · ${out.pairedEvidence.wins}W-${out.pairedEvidence.losses}L-${out.pairedEvidence.ties}T · ΣΔ${out.pairedEvidence.ppDelta >= 0 ? "+" : ""}${out.pairedEvidence.ppDelta}pp over ${out.pairedEvidence.sharedBankResults} shared-bank result(s)` : out.pairedEvidence.note}`);
  console.log(`  settlement  — ${champ ? `${out.settlement!.duels} (${champ.duelWinPct ?? "—"}%) · legs ${out.settlement!.ladderLegs} · bounties ${out.settlement!.bounties}` : "no resolved venues"}`);
  console.log(`  belief      — ${bel ? `${bel.impliedWinPct !== null ? `wins ${bel.impliedWinPct}%` : ""}${bel.impliedScore !== null ? ` scores ~${bel.impliedScore}` : ""} (${bel.stakeWeighed} staked · conviction #${belIdx + 1})` : "no open book prices it"}`);
  if (out.divergence?.gap !== null && out.divergence?.gap !== undefined && out.divergence.gap !== 0)
    console.log(`  divergence  — evidence #${out.divergence.evidenceRank} vs conviction #${out.divergence.convictionRank} → gap ${out.divergence.gap > 0 ? "+" : ""}${out.divergence.gap} (${out.divergence.gap > 0 ? "priced above" : "priced below"} the receipts)`);
  console.log(out.coverage
    ? `  coverage    — ${out.coverage.banksCovered}/${out.coverage.ofBanks} most-run banks · mean best ${out.coverage.meanPct}% (chain matrix)`
    : `  coverage    — 0/${(mx?.banks as any[])?.length ?? 8} most-run banks — absent from the most-run suite`);
  console.log(`  runs        — ${out.runs.total} submitted · ${out.runs.finalized} finalized`);
  for (const r of out.runs.recent.slice(0, 8))
    console.log(`    ${String(r.pk).slice(0, 12)}… ${r.score} on ${r.bank} (status ${r.status})`);
  console.log(`  permalink   — https://josepha-mayo.github.io/sealed/?pk=${out.record}`);
  return out;
}

/** `chain report <model> [--out file]` — the dossier as a document: a
 *  sealed-report/v1 markdown you can hand a consumer — every lens, the
 *  receipt ledger, the venue settlement record, and the sha256 of the
 *  model's claim card so the report's claims re-verify against the card. */
export async function chainReport(modelStr: string, out?: string, snapPath?: string) {
  const origLog = console.log; console.log = () => {};
  let dossier: any, card: any;
  try {
    dossier = await chainModel(modelStr, true, snapPath);
    card = await chainProve(modelStr, undefined, snapPath);
  } finally { console.log = origLog; }
  if (!dossier || !card) { console.log(`no model record for ${modelStr}`); process.exitCode = 2; return; }
  // canonical content hash — generatedAt + source excluded so the digest is
  // stable: the same evidence fingerprints identically live or replayed.
  const canon = (v: any): string => JSON.stringify(v, (_k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x))
      return Object.keys(x).sort().reduce((o: any, k) => (o[k] = x[k], o), {});
    return x;
  });
  const { generatedAt: _drop, source: _drop2, ...cardBody } = card;
  const cardHash = createHash("sha256").update(canon(cardBody)).digest("hex");
  const d = dossier;
  const L: string[] = [];
  L.push(`# Capability report — ${d.model}`, "",
    `> sealed-report/v1 · generated ${new Date().toISOString()} · source ${snapPath ?? "live"}`,
    `> programs: sealed \`${card.programs.sealed}\` · market \`${card.programs.market}\``,
    `> record PDA \`${d.record}\` · claim-card content sha256 \`${cardHash}\` (canonical JSON, \`generatedAt\`/\`source\` excluded)`, "",
    "Every number below is replayable. Re-mint the card and compare fingerprints:",
    "```",
    `sealed chain prove "${d.model}" --out card.json --snapshot web/snapshot.json`,
    "sealed chain prove --verify card.json",
    "python3 -c 'import json,hashlib; c=json.load(open(\"card.json\")); c.pop(\"generatedAt\",None); c.pop(\"source\",None); print(hashlib.sha256(json.dumps(c,sort_keys=True,separators=(\",\",\":\")).encode()).hexdigest())'",
    "```", "");
  const r = d.registry;
  L.push("## Registry record", "",
    "| metric | value |", "|---|---|",
    `| receipts | ${r.runs} |`,
    `| aggregate | ${r.correct}/${r.items} items (${r.accuracyPct}%) |`,
    `| best run | ${r.bestScore} |`, "");
  L.push("## The four lenses", "",
    "| lens | reading |", "|---|---|");
  const e = d.pairedEvidence;
  L.push(`| paired evidence | ${e.rank ? `rank #${e.rank} · ${e.wins}W-${e.losses}L-${e.ties}T · ΣΔ${e.ppDelta >= 0 ? "+" : ""}${e.ppDelta}pp over ${e.sharedBankResults} shared-bank results` : e.note} |`);
  L.push(`| settlement | ${d.settlement ? `duels ${d.settlement.duels} (${d.settlement.duelWinPct ?? "—"}%) · ladder legs ${d.settlement.ladderLegs} · bounties ${d.settlement.bounties}` : "no resolved venues"} |`);
  L.push(`| market belief | ${d.marketBelief ? `${d.marketBelief.impliedWinPct !== null ? `wins ${d.marketBelief.impliedWinPct}%` : ""}${d.marketBelief.impliedScore !== null ? ` scores ~${d.marketBelief.impliedScore}` : ""} · ${d.marketBelief.stakeWeighed} staked · conviction #${d.marketBelief.convictionRank}` : "no open book prices it"} |`);
  if (d.divergence?.gap !== null && d.divergence?.gap !== undefined)
    L.push(`| divergence | evidence #${d.divergence.evidenceRank} vs conviction #${d.divergence.convictionRank} → ${d.divergence.gap > 0 ? "+" : ""}${d.divergence.gap} (${d.divergence.gap > 0 ? "priced above" : "priced below"} the receipts) |`);
  L.push(`| coverage | ${d.coverage ? `${d.coverage.banksCovered}/${d.coverage.ofBanks} most-run banks · mean best ${d.coverage.meanPct}%` : "absent from the most-run suite"} |`, "");
  L.push("## Score receipts", "",
    "| run | score | items | attested | post-reveal | recorded |", "|---|---|---|---|---|---|");
  for (const l of card.receipts)
    L.push(`| \`${l.run.slice(0, 12)}…\` | ${l.correct} | ${l.items} | ${l.vouched ? "yes" : "—"} | ${l.postReveal ? "YES" : "—"} | ${new Date(l.recordedAt * 1000).toISOString().slice(0, 10)} |`);
  L.push("", `_${card.receipts.length} receipts · ${card.verdicts.postRevealRuns} post-reveal run(s) flagged — post-reveal scores do not measure the same thing._`, "");
  const resolved = card.venues.filter((v: any) => v.status === 1);
  if (resolved.length) {
    L.push("## Settlement record", "",
      "| venue | kind | pot (lamports) | outcome |", "|---|---|---|---|");
    for (const v of resolved)
      L.push(`| \`${v.pk.slice(0, 12)}…\` | ${v.kind} | ${v.pot ?? v.pool ?? "—"} | ${v.outcome !== undefined ? v.outcome : v.resultMask ?? "—"} |`);
    L.push("", `_${resolved.length} resolved venues — every stored score re-derives from Run.correct._`, "");
  }
  L.push("## Honesty flags", "",
    `- post-reveal runs: ${card.verdicts.postRevealRuns}`,
    `- post-reveal receipts: ${card.verdicts.postRevealReceipts}`,
    `- co-participant runs embedded for venue replay: ${card.verdicts.coParticipantRuns}`, "");
  const md = L.join("\n") + "\n";
  if (out) { writeFileSync(out, md); console.log(`wrote ${out} — capability report for ${d.model} (${card.receipts.length} receipts, ${resolved.length} resolved venues)`); }
  else console.log(md);
  return { model: d.model, cardHash };
}

/** `chain report --verify <file.md>` — a report binds itself to a claim
 *  card by canonical sha256. The verifier re-mints the card for the named
 *  model (live or snapshot), recomputes the digest, checks the printed
 *  record PDA re-derives, and replays the bound card in full — so the
 *  document is only as honest as the evidence it fingerprints, and the
 *  evidence verifies. */
export async function reportVerify(file: string, snapPath?: string, json = false) {
  const md = readFileSync(file, "utf8");
  if (!md.includes("sealed-report/v1")) throw new Error(`not a sealed-report/v1 file (${file})`);
  const model = md.match(/^# Capability report — (.+)$/m)?.[1]?.trim();
  const wantHash = md.match(/claim-card content sha256 `([0-9a-f]{64})`/)?.[1];
  const recordPk = md.match(/record PDA `([1-9A-HJ-NP-Za-km-z]{32,44})`/)?.[1];
  if (!model || !wantHash || !recordPk)
    throw new Error("malformed report — missing model header, claim-card sha256, or record PDA line");
  const orig = console.log; console.log = () => {};
  let card: any;
  try { card = await chainProve(model, undefined, snapPath); }
  finally { console.log = orig; }
  if (!card) throw new Error(`no claim card for "${model}" — the report names a model with no record`);
  const canon = (v: any): string => JSON.stringify(v, (_k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x))
      return Object.keys(x).sort().reduce((o: any, k) => (o[k] = x[k], o), {});
    return x;
  });
  const { generatedAt: _d1, source: _d2, ...cardBody } = card;
  const gotHash = createHash("sha256").update(canon(cardBody)).digest("hex");
  const recPda = PublicKey.findProgramAddressSync(
    [Buffer.from("modelrec"), createHash("sha256").update(Buffer.from(model, "utf8")).digest()],
    sealedProgramId())[0].toBase58();
  let pass = 0, fail = 0;
  const rows: { what: string; ok: boolean; detail: string }[] = [];
  const check = (what: string, ok: boolean, detail = "") => {
    rows.push({ what, ok, detail });
    if (!json) console.log(`  ${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
    ok ? pass++ : fail++;
  };
  check("record PDA", recPda === recordPk && recPda === card.model.recordPk,
    `${recordPk.slice(0, 12)}… = [modelrec, sha256(${model})] = card's bound record`);
  check("card digest binding", gotHash === wantHash,
    `sha256(canonical card) ${gotHash.slice(0, 16)}… ${gotHash === wantHash ? "=" : "≠"} printed ${wantHash.slice(0, 16)}…`);
  const cr = verifyClaimCard(card);
  check("bound card replay", cr.ok, `${cr.pass} claim checks pass${cr.ok ? "" : ` · ${cr.fails.join("; ")}`}`);
  const verdict = fail === 0 ? "REPORT VERIFIED" : "REPORT FAILED";
  if (json) console.log(JSON.stringify({ file, kind: "sealed-report/v1", model, verified: fail === 0,
    cardHash: gotHash, checks: rows, pass, fail }));
  else console.log(`${verdict} — ${model}: ${pass} checks pass, ${fail} fail · bound card ${cr.pass}/${cr.pass + cr.fail} checks`);
  if (fail) process.exitCode = 1;
  return { pass, fail };
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
  console.log(`  permalink — https://josepha-mayo.github.io/sealed/?pk=${runPkStr}`);
  return out;
}

/** `chain trail <run> --prove <file>` — mint a `sealed-trail/v1` card: the
 *  money-trail as portable evidence. One run's full lifecycle — the bank's
 *  commitment, the MPC-written score, the registry receipt, and every venue
 *  that priced it — bound with PDA seeds so a verifier replays the whole
 *  chain offline: every address re-derives, every settlement re-checks
 *  against Run.correct. "The money followed the MPC score" as a document. */
export async function trailProve(runPkStr: string, out: string, snapPath?: string) {
  const runPk = new PublicKey(runPkStr);
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sealedAcct = () => (sealedProgram().program.account as any);
  const marketAcct = () => (marketProgram().market.account as any);
  const [runs, banks, logs, markets, darks, ladders, bounties, darkPoss]: SnapAccount[][] = ss
    ? [snapOf(ss, "Run"), snapOf(ss, "Benchmark"), snapOf(ss, "ScoreLog"),
       snapOf(sm!, "Market"), snapOf(sm!, "DarkMarket"), snapOf(sm!, "Ladder"), snapOf(sm!, "Bounty"), snapOf(sm!, "DarkPosition")]
    : await Promise.all([
        sealedAcct().run.all(), sealedAcct().benchmark.all(), sealedAcct().scoreLog.all(),
        marketAcct().market.all(), marketAcct().darkMarket.all(), marketAcct().ladder.all(), marketAcct().bounty.all(),
        marketAcct().darkPosition.all()]);
  const run = runs.find((r) => r.publicKey.equals(runPk));
  if (!run) throw new Error(`no run at ${runPkStr}`);
  const R = run.account as any;
  const b58 = (v: any) => v?.toBase58 ? v.toBase58() : String(v);
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const bank = banks.find((b) => b.publicKey.equals(R.benchmark));
  const B = bank?.account as any;
  const receipt = logs.find((l) => (l.account.run as PublicKey).equals(runPk));
  const venues: any[] = [];
  for (const m of markets) {
    const M = m.account as any;
    const isA = (M.run as PublicKey).equals(runPk);
    const isB = M.runB && !(M.runB as PublicKey).equals(PublicKey.default) && (M.runB as PublicKey).equals(runPk);
    if (!isA && !isB) continue;
    const duel = isB || (M.runB && !(M.runB as PublicKey).equals(PublicKey.default));
    venues.push({ kind: duel ? "duel" : "band", pk: m.publicKey.toBase58(),
      seeds: duel ? { runA: b58(M.run), runB: b58(M.runB), salt: num(M.salt) } : { run: b58(M.run), salt: num(M.salt) },
      status: num(M.status), side: duel ? (isA ? "a" : "b") : null,
      resolvedScore: num(M.resolvedScore), outcome: num(M.outcome),
      nOutcomes: num(M.nOutcomes), edges: (M.edges as any[]).map(Number),
      totals: (M.totals as any[]).map(Number) });
  }
  for (const d of darks) {
    const D = d.account as any;
    if (!(D.run as PublicKey).equals(runPk)) continue;
    // forfeited stake is real: every dark position on this venue that never
    // revealed (revealed = 255 sentinel — it stores the revealed BUCKET, not
    // a bool). Never-revealed stake forfeits into the pot at finalize.
    const forfeit = darkPoss
      .filter((p) => (p.account.market as PublicKey).equals(d.publicKey) && num((p.account as any).revealed) === 255)
      .reduce((s, p) => s + num((p.account as any).amount), 0);
    venues.push({ kind: "dark", pk: d.publicKey.toBase58(),
      seeds: { run: b58(D.run), salt: num(D.salt) },
      status: num(D.status), resolvedScore: num(D.resolvedScore), tallied: !!D.tallied,
      poolTotal: num(D.poolTotal), winTotal: num(D.winTotal),
      revealedCount: num(D.revealedCount), forfeitTotal: forfeit });
  }
  for (const l of ladders) {
    const L = l.account as any;
    const legs = (L.legs as PublicKey[]).slice(0, Number(L.legCount));
    const legIx = legs.findIndex((p) => p.equals(runPk));
    if (legIx < 0) continue;
    venues.push({ kind: "ladder", pk: l.publicKey.toBase58(),
      seeds: { firstLeg: b58(legs[0]), salt: num(L.salt) },
      status: num(L.status), legIndex: legIx, legCount: Number(L.legCount),
      resultMask: num(L.resultMask), totals: (L.totals as any[]).map(Number),
      legs: legs.map((lp) => {
        const lr = runs.find((r) => r.publicKey.equals(lp))?.account as any;
        return { pk: lp.toBase58(), benchmark: lr ? b58(lr.benchmark) : null,
          index: lr ? num(lr.index) : null, status: lr ? num(lr.status) : null,
          correct: lr ? num(lr.correct) : null };
      }) });
  }
  for (const b of bounties) {
    const Bo = b.account as any;
    if (!(Bo.winnerRun as PublicKey).equals(runPk)) continue;
    venues.push({ kind: "bounty", pk: b.publicKey.toBase58(),
      seeds: { bank: b58(Bo.bank), sponsor: b58(Bo.sponsor), salt: num(Bo.salt) },
      status: num(Bo.status), winnerRun: b58(Bo.winnerRun), winningScore: num(Bo.winningScore),
      threshold: num(Bo.threshold), amount: num(Bo.amount) });
  }
  const resolved = venues.filter((v) => v.status === 1);
  const mismatch = resolved.filter((v) => {
    if (v.kind === "band") return v.resolvedScore !== num(R.correct);
    if (v.kind === "duel") return (v.side === "a" ? v.resolvedScore >> 16 : v.resolvedScore & 0xffff) !== num(R.correct);
    if (v.kind === "dark") return v.resolvedScore !== num(R.correct);
    if (v.kind === "bounty") return v.winningScore !== num(R.correct);
    if (v.kind === "ladder") return v.legs[v.legIndex]?.correct !== num(R.correct);
    return false;
  });
  const pools = venues.reduce((s, v) => s + (v.totals ? v.totals.reduce((x: number, t: number) => x + t, 0) : (v.poolTotal ?? 0)), 0);
  const card = {
    kind: "sealed-trail/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath ?? "live",
    snapshotSha256: snapPath ? createHash("sha256").update(readFileSync(snapPath)).digest("hex") : null,
    programs: { sealed: sealedProgramId().toBase58(), market: MARKET_PROGRAM_ID.toBase58() },
    run: { pk: runPkStr, benchmark: b58(R.benchmark), index: num(R.index), modelId: String(R.modelId),
      status: num(R.status), correct: num(R.correct), chunkCount: num(R.chunkCount),
      postReveal: !!R.postReveal, runner: b58(R.runner), createdAt: num(R.createdAt) },
    bank: bank ? { pk: bank.publicKey.toBase58(), authority: b58(B.authority), id: num(B.id),
      name: String(B.name), kind: num(B.kind), itemsRoot: Buffer.from(B.itemsRoot as number[]).toString("hex") } : null,
    receipt: receipt ? { pk: receipt.publicKey.toBase58(), run: b58(receipt.account.run),
      recordedBy: b58(receipt.account.recordedBy), recordedAt: num(receipt.account.recordedAt),
      vouchedAtRecord: !!receipt.account.vouchedAtRecord, postReveal: !!receipt.account.postReveal } : null,
    venues,
    verdict: { venuesTotal: venues.length, resolvedVenues: resolved.length,
      scoreMismatches: mismatch.length, poolsLamports: pools },
  };
  writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
  console.log(`wrote ${out} — sealed-trail/v1 card: ${card.run.modelId} ${card.run.correct}/${card.run.chunkCount * 32} · ` +
    `${venues.length} venue(s) priced it (${resolved.length} resolved, ${mismatch.length} mismatch, ${(pools / 1e9).toFixed(3)}◎ pooled)` +
    ` (verify: chain trail --verify ${out})`);
  return card;
}

/** The per-card trail verifier shared by single-file and directory modes. */
function verifyTrailCard(card: any, emit?: (what: string, ok: boolean, detail: string) => void,
  snap?: { ss: SnapMap; sm: SnapMap; sha256?: string }) {
  const sealedId = new PublicKey(card.programs.sealed);
  const marketId = new PublicKey(card.programs.market);
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const u64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const pk = (s: string) => new PublicKey(s);
  const dv = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, sealedId)[0].toBase58();
  const dm = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, marketId)[0].toBase58();
  let pass = 0, fail = 0;
  const fails: string[] = [];
  const rows: { what: string; ok: boolean; detail: string }[] = [];
  const check = (what: string, ok: boolean, detail = "") => {
    rows.push({ what, ok, detail });
    emit?.(what, ok, detail);
    if (!ok) fails.push(what);
    ok ? pass++ : fail++;
  };
  if (snap?.sha256 && card.snapshotSha256)
    check("snapshot binding", snap.sha256 === card.snapshotSha256,
      `sha256 ${card.snapshotSha256.slice(0, 16)}… pins the card to this exact account set`);
  check("run PDA", dv([Buffer.from("run"), pk(card.run.benchmark).toBuffer(), u64le(card.run.index)]) === card.run.pk,
    `${card.run.pk.slice(0, 12)}… = [run, bank, u64le(${card.run.index})]`);
  if (card.bank)
    check("bank PDA", dv([Buffer.from("benchmark"), pk(card.bank.authority).toBuffer(), u32le(card.bank.id)]) === card.bank.pk,
      `${card.bank.pk.slice(0, 12)}… = [benchmark, authority, u32le(${card.bank.id})]`);
  if (card.receipt)
    check("receipt PDA", dv([Buffer.from("scorelog"), pk(card.run.pk).toBuffer()]) === card.receipt.pk,
      `${card.receipt.pk.slice(0, 12)}… = [scorelog, run]`);
  let vOk = 0;
  for (const v of card.venues) {
    const seeds: Buffer[] = v.kind === "band" ? [Buffer.from("market"), pk(v.seeds.run).toBuffer(), u64le(v.seeds.salt)]
      : v.kind === "duel" ? [Buffer.from("duel"), pk(v.seeds.runA).toBuffer(), pk(v.seeds.runB).toBuffer(), u64le(v.seeds.salt)]
      : v.kind === "dark" ? [Buffer.from("dark"), pk(v.seeds.run).toBuffer(), u64le(v.seeds.salt)]
      : v.kind === "ladder" ? [Buffer.from("ladder"), pk(v.seeds.firstLeg).toBuffer(), u64le(v.seeds.salt)]
      : [Buffer.from("bounty"), pk(v.seeds.bank).toBuffer(), pk(v.seeds.sponsor).toBuffer(), u64le(v.seeds.salt)];
    if (dm(seeds) === v.pk) vOk++;
    else rows.push({ what: `venue ${v.pk.slice(0, 8)}`, ok: false, detail: `${v.kind} PDA mismatch` });
  }
  check("venue PDAs", vOk === card.venues.length, `${vOk}/${card.venues.length} re-derived`);
  // account binding — the card's fields must equal the decoded account
  // bytes, not merely be self-consistent. A trail card that lies about
  // the run's score or a venue's escrow dies here.
  if (snap) {
    const runA = snapOf(snap.ss, "Run").find((x) => x.publicKey.toBase58() === card.run.pk)?.account as any;
    check("run binding", !!runA &&
      String(runA.correct) === String(card.run.correct) &&
      String(runA.status) === String(card.run.status) &&
      String(runA.runner) === card.run.runner &&
      String(runA.modelId) === card.run.modelId &&
      String(runA.benchmark) === card.run.benchmark &&
      String(!!runA.postReveal) === String(card.run.postReveal),
      "correct · status · runner · model · bank · post_reveal equal the decoded Run");
    const venueType: Record<string, string> = { band: "Market", duel: "Market", dark: "DarkMarket", ladder: "Ladder", bounty: "Bounty" };
    const darkPoss = snapOf(snap.sm, "DarkPosition");
    let bOk = 0, bN = 0;
    const eq = (a: any, b: any) => String(a) === String(b);
    for (const v of card.venues) {
      const acct = snapOf(snap.sm, venueType[v.kind] ?? "").find((x) => x.publicKey.toBase58() === v.pk)?.account as any;
      if (!acct) { rows.push({ what: `venue ${v.pk.slice(0, 8)}`, ok: false, detail: `${v.kind} account not in snapshot` }); continue; }
      bN++;
      const b58a = (x: any) => x?.toBase58 ? x.toBase58() : String(x);
      // the account's own fields must equal the declared seeds — a card
      // can't claim a salt/run/sponsor that differs from what the account
      // actually stores.
      const seedOk = v.kind === "band" ? b58a(acct.run) === v.seeds.run && eq(acct.salt, v.seeds.salt)
        : v.kind === "duel" ? b58a(acct.run) === v.seeds.runA && b58a(acct.runB) === v.seeds.runB && eq(acct.salt, v.seeds.salt)
        : v.kind === "dark" ? b58a(acct.run) === v.seeds.run && eq(acct.salt, v.seeds.salt)
        : v.kind === "ladder" ? b58a((acct.legs as any[])[0]) === v.seeds.firstLeg && eq(acct.salt, v.seeds.salt) &&
            b58a((acct.legs as any[])[v.legIndex]) === card.run.pk
        : b58a(acct.bank) === v.seeds.bank && b58a(acct.sponsor) === v.seeds.sponsor && eq(acct.salt, v.seeds.salt);
      const moneyOk = v.kind === "bounty" ? eq(v.amount, acct.amount)
        : v.kind === "dark"
          ? eq(v.poolTotal, acct.poolTotal) && eq(v.winTotal, acct.winTotal) &&
            eq(v.revealedCount, acct.revealedCount) && eq(!!v.tallied, !!acct.tallied) &&
            eq(v.forfeitTotal, darkPoss
              .filter((p) => (p.account.market as PublicKey).equals(pk(v.pk)) && num((p.account as any).revealed) === 255)
              .reduce((s, p) => s + num((p.account as any).amount), 0))
          : v.totals ? eq(JSON.stringify(v.totals), JSON.stringify((acct.totals as any[]).map((t: any) => Number(t))))
          : eq(v.poolTotal ?? 0, acct.poolTotal ?? 0);
      const scoreOk = v.kind === "bounty"
        ? eq(v.status, acct.status) && eq(v.threshold, acct.threshold) &&
          (acct.status === 1 ? eq(v.winningScore, acct.winningScore) && eq(v.winnerRun, acct.winnerRun) : true)
        : v.kind === "ladder"
          ? eq(v.status, acct.status) && eq(v.legCount, acct.legCount) &&
            (acct.status === 1 ? eq(v.resultMask, acct.resultMask) : true)
          : eq(v.status, acct.status) &&
            (acct.status === 1 ? eq(v.resolvedScore, acct.resolvedScore) : true) &&
            (v.outcome == null || acct.status !== 1 || eq(v.outcome, acct.outcome));
      if (seedOk && moneyOk && scoreOk) bOk++;
      else rows.push({ what: `venue ${v.pk.slice(0, 8)}`, ok: false, detail: `${v.kind} field(s) differ from account bytes` });
    }
    check("venue binding", bOk === bN && bN === card.venues.length, `${bOk}/${card.venues.length} venue accounts field-bound`);
  }
  const resolved = card.venues.filter((v: any) => v.status === 1);
  let sOk = 0;
  for (const v of resolved) {
    const ok = v.kind === "band" ? v.resolvedScore === card.run.correct
      : v.kind === "duel" ? (v.side === "a" ? v.resolvedScore >> 16 : v.resolvedScore & 0xffff) === card.run.correct
      : v.kind === "dark" ? v.resolvedScore === card.run.correct
      : v.kind === "bounty" ? v.winningScore === card.run.correct
      : v.legs[v.legIndex]?.correct === card.run.correct;
    if (ok) sOk++;
    else rows.push({ what: `settlement ${v.pk.slice(0, 8)}`, ok: false, detail: `${v.kind} score ≠ Run.correct=${card.run.correct}` });
  }
  check("settlements from Run.correct", sOk === resolved.length,
    `${sOk}/${resolved.length} resolved venue(s) replayed against the MPC-written score`);
  let legOk = 0, legN = 0;
  for (const v of card.venues.filter((x: any) => x.kind === "ladder")) {
    for (const l of v.legs) {
      legN++;
      if (l.benchmark != null && dv([Buffer.from("run"), pk(l.benchmark).toBuffer(), u64le(l.index)]) === l.pk) legOk++;
    }
    if (v.status === 1) {
      // re-argmax from the DECODED leg runs when the snapshot is present —
      // a forged card declaring a different argmax that still matches its
      // own rewritten scores dies here, not just on card-internal math.
      const runByPk = snap ? new Map(snapOf(snap.ss, "Run").map((x) => [x.publicKey.toBase58(), x.account as any])) : null;
      const legScore = (l: any) => {
        const d = runByPk?.get(l.pk);
        const st = d ? Number(d.status) : l.status;
        return st === 1 ? Number(d ? d.correct : l.correct) : 0;
      };
      const scores = v.legs.map(legScore);
      const best = Math.max(...scores);
      const mask = scores.reduce((m: number, s: number, i: number) => m | (s === best ? 1 << i : 0), 0);
      mask === v.resultMask ? legOk++ : rows.push({ what: `ladder ${v.pk.slice(0, 8)}`, ok: false, detail: `argmax mask ${mask} ≠ stored ${v.resultMask}` });
      legN++;
    }
  }
  if (legN) check("ladder legs + argmax", legOk === legN, `${legOk}/${legN} leg PDAs + result mask re-derived`);
  const pools = card.venues.reduce((s: number, v: any) => s + (v.totals ? v.totals.reduce((x: number, t: number) => x + t, 0) : (v.poolTotal ?? 0)), 0);
  check("pool accounting", pools === card.verdict.poolsLamports,
    `${pools} lamports (${(pools / 1e9).toFixed(4)}◎) recomputed = ${card.verdict.poolsLamports} stored`);
  const vd = card.verdict;
  check("verdict summary", vd.venuesTotal === card.venues.length && vd.resolvedVenues === resolved.length &&
    vd.scoreMismatches === resolved.length - sOk,
    `${vd.venuesTotal} venues · ${vd.resolvedVenues} resolved · ${vd.scoreMismatches} mismatch stored = recomputed`);
  return { ok: fail === 0, pass, fail, fails, rows };
}

/** `chain trail --verify <file|dir>` — replay a sealed-trail/v1 card keyless.
 *  A directory batch-verifies every *.json card in it (index.json skipped). */
export async function trailVerify(file: string, json = false, snapPath?: string) {
  const { statSync, readdirSync } = await import("node:fs");
  const snap = snapPath ? { ss: decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed"),
    sm: decodeSnapshotSection(loadSnapshotJson(snapPath), "market"),
    sha256: createHash("sha256").update(readFileSync(snapPath)).digest("hex") } : undefined;
  if (statSync(file).isDirectory()) {
    const files = readdirSync(file).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
    if (!files.length) throw new Error(`no trail cards (*.json) in ${file}`);
    let okAll = true;
    const results: any[] = [];
    if (!json) console.log(`verifying ${files.length} trail card(s) in ${file}/`);
    for (const f of files) {
      try {
        const card = JSON.parse(readFileSync(`${file}/${f}`, "utf8"));
        if (card.kind !== "sealed-trail/v1") throw new Error(`kind=${card.kind}`);
        const r = verifyTrailCard(card, undefined, snap);
        results.push({ file: f, model: card.run?.modelId ?? null, ok: r.ok, pass: r.pass, fail: r.fail, fails: r.fails });
        if (!json) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${f.padEnd(36)} ${card.run?.modelId ?? "?"} ${card.run?.correct}/${(card.run?.chunkCount ?? 0) * 32} — ${r.pass} checks${r.ok ? "" : ` · ${r.fails.join("; ")}`}`);
        okAll &&= r.ok;
      } catch (e: any) { okAll = false; results.push({ file: f, ok: false, error: String(e?.message ?? e) }); if (!json) console.log(`  FAIL ${f} — ${e?.message ?? e}`); }
    }
    if (json) console.log(JSON.stringify({ dir: file, cards: results, ok: okAll }));
    else console.log(`${okAll ? "ALL TRAILS VERIFIED" : "VERIFICATION FAILED"} — ${files.length} card(s), ${file}`);
    if (!okAll) process.exit(1);
    return { ok: okAll, cards: results };
  }
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-trail/v1") throw new Error(`not a sealed-trail/v1 file (kind=${card.kind})`);
  const r = verifyTrailCard(card, (what, ok, detail) => { if (!json) console.log(`  ${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); }, snap);
  const verdict = r.fail === 0 ? "TRAIL VERIFIED" : "TRAIL FAILED";
  if (json) console.log(JSON.stringify({ file, kind: card.kind, run: card.run.pk, model: card.run.modelId,
    verified: r.fail === 0, checks: r.rows, pass: r.pass, fail: r.fail, verdict: card.verdict }));
  else console.log(`${verdict} — ${card.run.modelId} ${card.run.correct}/${card.run.chunkCount * 32}: ${r.pass} checks pass, ${r.fail} fail · ` +
    `${card.verdict.venuesTotal} venue(s) priced this score`);
  if (r.fail) process.exitCode = 1;
  return { pass: r.pass, fail: r.fail };
}

/** `chain artifact <file|dir>` — the universal verifier: read any file this
 *  system emits, detect its sealed-X/v1 kind, and route it to the right
 *  keyless replay. One command verifies everything — a judge never has to
 *  know which flag goes with which artifact. A directory verifies every
 *  artifact inside it (mixed kinds welcome). */
/** cwd-forgiveness for file INPUTS (never outputs): under
 *  `yarn --cwd packages/harness` a judge's `docs/evidence/x.json` misses
 *  cwd but exists at repo root — resolve there before statSync. */
function resolveInputPath(p: string): string {
  return (!/^https?:\/\//.test(p) && !existsSync(p) && existsSync(join(ROOT, p))) ? join(ROOT, p) : p;
}

export async function artifactVerify(target: string, json = false, snapPath?: string, recursive = false) {
  const { statSync, readdirSync } = await import("node:fs");
  target = resolveInputPath(target);
  // URL targets — the shareable deep links work from the terminal too:
  // `?card=<path>` resolves to the hosted artifact bytes; a bare .json/.md
  // URL is fetched directly. The verify path is identical to local files.
  if (/^https?:\/\//.test(target)) {
    const u = new URL(target);
    const card = u.searchParams.get("card");
    const tamper = u.searchParams.get("tamper");
    if (card !== null) {
      if (!/^[a-zA-Z0-9._/-]+\.(json|md)$/.test(card)) throw new Error(`unsafe ?card= path: ${card}`);
      target = new URL(card, u).href; // resolve against the page's directory
    } else if (tamper !== null) {
      // ?tamper=<file> — the lie-exhibit deep link resolves to tamper/<file>
      if (!/^[a-zA-Z0-9._-]+\.json$/.test(tamper)) throw new Error(`unsafe ?tamper= path: ${tamper}`);
      target = new URL(`tamper/${tamper}`, u).href;
    }
    if (!json) console.log(`fetching ${target}`);
    const r = await fetch(target);
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${target}`);
    const raw = await r.text();
    const { writeFileSync: wf, mkdtempSync: md } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: jn } = await import("node:path");
    const tmp = jn(md(jn(tmpdir(), "sealed-url-")), target.split("/").pop() ?? "artifact.json");
    wf(tmp, raw);
    return artifactVerify(tmp, json, snapPath, false);
  }
  const kindOf = (f: string): string | null => {
    const raw = readFileSync(f, "utf8");
    try { return JSON.parse(raw).kind ?? null; }
    catch { return raw.includes("sealed-report/v1") ? "sealed-report/v1" : null; }
  };
  const ROUTES = ARTIFACT_ROUTES(snapPath, json);
  if (statSync(target).isDirectory()) {
    const isArtifactFile = (f: string) => (f.endsWith(".json") || f.endsWith(".md")) &&
      !["index.json", "SHA256SUMS", "README.md"].includes(f);
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      for (const f of readdirSync(dir).sort()) {
        const full = `${dir}/${f}`;
        if (statSync(full).isDirectory()) { if (recursive && depth < 3) walk(full, depth + 1); continue; }
        if (isArtifactFile(f)) files.push(full);
      }
    };
    walk(target, 0);
    if (!files.length) throw new Error(`no artifacts (*.json|*.md) in ${target}${recursive ? " (recursive)" : ""}`);
    let okAll = true;
    const results: any[] = [];
    if (!json) console.log(`scanning ${files.length} candidate file(s) in ${target}${recursive ? " (recursive)" : ""}`);
    const orig = console.log;
    for (const full of files) {
      const f = full.slice(target.length + 1);
      try {
        const kind = kindOf(full);
        const route = kind ? ROUTES[kind] : null;
        if (!route) { results.push({ file: f, kind: kind ?? null, ok: true, skipped: true });
          if (!json) console.log(`  SKIP ${f} — ${kind ? `unrecognized kind ${kind}` : "not a sealed artifact"}`); continue; }
        console.log = () => {};
        const r = await route(full).finally(() => { console.log = orig; });
        const ok = (r.ok ?? (r.fail === 0)) === true;
        results.push({ file: f, kind, ok, pass: r.pass, fail: r.fail });
        if (!json) console.log(`  ${ok ? "PASS" : "FAIL"} ${f.padEnd(46)} ${(kind ?? "?").padEnd(17)} — ${r.pass} checks`);
        okAll &&= ok;
      } catch (e: any) {
        console.log = orig;
        okAll = false; results.push({ file: f, ok: false, error: String(e?.message ?? e) });
        if (!json) console.log(`  FAIL ${f} — ${e?.message ?? e}`);
      }
    }
    if (json) console.log(JSON.stringify({ dir: target, artifacts: results, ok: okAll }));
    else {
      const byKind = new Map<string, number>();
      let skipped = 0;
      for (const r of results) {
        if (r.skipped) { skipped++; continue; }
        if (r.kind) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
      }
      console.log(`${okAll ? "ALL ARTIFACTS VERIFIED" : "VERIFICATION FAILED"} — ${results.length - skipped} artifact(s) replayed, ${skipped} non-artifact(s) skipped, ${target}` +
        (byKind.size > 1 ? ` · ${[...byKind].map(([k, n]) => `${n}× ${k}`).join(", ")}` : ""));
    }
    if (!okAll) process.exitCode = 1;
    return { ok: okAll, artifacts: results };
  }
  const kind = kindOf(target);
  const route = kind ? ROUTES[kind] : null;
  if (!route) throw new Error(`unrecognized artifact: ${target} (kind=${kind ?? "?"} — expected sealed-claim|policy|match|trail|report|evidence-digest|board|bank|catalog|position|bounty|grant/v1)`);
  if (!json) console.log(`detected ${kind} — routing to its verifier`);
  return route(target);
}

/** One route table — kind → its keyless verifier. Shared by the universal
 *  verifier, the forgery lab, and tamper-exhibit replays. */
const ARTIFACT_ROUTES = (snapPath?: string, json = false): Record<string, (f: string) => Promise<any>> => ({
  "sealed-claim/v1": (f) => chainProveVerify(f, undefined, json, snapPath),
  "sealed-policy/v1": (f) => gateCertVerify(f, json),
  "sealed-match/v1": (f) => matchVerify(f, json, snapPath),
  "sealed-trail/v1": (f) => trailVerify(f, json, snapPath),
  "sealed-report/v1": (f) => reportVerify(f, snapPath, json),
  "sealed-evidence-digest/v1": (f) => digestVerify(f, json, snapPath),
  "sealed-board/v1": (f) => boardVerify(f, json, snapPath),
  "sealed-bank/v1": (f) => bankVerify(f, json, snapPath),
  "sealed-catalog/v1": (f) => catalogVerify(f, json),
  "sealed-position/v1": (f) => positionVerify(f, json, snapPath),
  "sealed-bounty/v1": (f) => bountyVerify(f, json, snapPath),
  "sealed-grant/v1": (f) => grantVerify(f, json, snapPath),
  "sealed-tamper/v1": (f) => tamperCardVerify(f, json, snapPath),
});

/** `chain artifact --tamper <file>` — the forgery lab for the terminal:
 *  mutate the card's own fields, re-run its verifier, and prove each
 *  forgery dies. Same checks as the in-page lab and `verify.py --tamper`
 *  — three surfaces, three languages of attack. */
const TAMPER_DEFS: Record<string, { label: string; mutate: (c: any) => void }[]> = {
  "sealed-board/v1": [
    { label: "inflate a receipt's score", mutate: (c) => { c.models[0].receipts[0].correct += 1; } },
    { label: "swap the #1 rank", mutate: (c) => { const t = c.ranking[0]; c.ranking[0] = c.ranking[1]; c.ranking[1] = t; } },
    { label: "un-vouch an attested receipt", mutate: (c) => { const l = c.models.flatMap((m: any) => m.receipts).find((x: any) => x.vouched === 1); l.vouched = 0; } },
  ],
  "sealed-match/v1": [
    { label: "flip the head-to-head verdict", mutate: (c) => { c.verdict.winner = c.verdict.winner === "a" ? "b" : "a"; } },
    { label: "launder the loser — rename side A's model", mutate: (c) => { c.a.id = "totally-different-model"; } },
  ],
  "sealed-claim/v1": [
    { label: "mint a phantom receipt", mutate: (c) => { const r = JSON.parse(JSON.stringify(c.receipts[0])); r.correct += 1; c.receipts.push(r); } },
    { label: "launder the receipts — rename the model", mutate: (c) => { c.model.id = "gpt-9000-ultra"; } },
  ],
  "sealed-trail/v1": [
    { label: "rewrite the settled money", mutate: (c) => {
      const v = (c.venues ?? []).find((v: any) => v && (v.poolTotal != null || (v.totals ?? []).length || v.amount != null));
      if (v?.poolTotal != null) v.poolTotal += 1;
      else if (v?.totals?.length) v.totals[0] += 1;
      else if (v?.amount != null) v.amount += 1;
      else c.run.correct = (c.run.correct ?? 0) + 1; // no venues — forge the MPC's count itself
    } },
    { label: "substitute the oracle — rewrite the MPC's score", mutate: (c) => {
      if (!c.run) return;
      c.run.correct = (c.run.correct ?? 0) + 1;
      const v = (c.venues ?? []).find((x: any) => x?.status === 1);
      if (v) { // keep the card self-consistent — binding must still kill it
        if (v.resolvedScore != null) v.resolvedScore += 1;
        if (v.winningScore != null) v.winningScore += 1;
        if (v.kind === "ladder" && v.legs?.[v.legIndex]) v.legs[v.legIndex].correct += 1;
      }
    } },
  ],
  "sealed-evidence-digest/v1": [
    { label: "re-age the ledger", mutate: (c) => { c.counts.runs = 9999; } },
  ],
  "sealed-bank/v1": [
    { label: "mint a phantom run on the exam", mutate: (c) => { const r = JSON.parse(JSON.stringify(c.runs[0])); r.correct = (r.correct ?? 0) + 1; c.runs.push(r); } },
  ],
  "sealed-catalog/v1": [
    { label: "erase an artifact from the index", mutate: (c) => { c.artifacts.splice(3, 1); c.count -= 1; } },
  ],
  "sealed-bounty/v1": [
    { label: "steal the bounty below threshold", mutate: (c) => {
      if (c.winner) { c.winner.correct = c.bounty.threshold - 1; c.bounty.winningScore = c.bounty.threshold - 1; }
      else { c.bounty.threshold = 0; } // open bounty — drop the bar so anyone qualifies
    } },
  ],
  "sealed-grant/v1": [
    { label: "redirect the disclosure to another viewer", mutate: (c) => { const v = c.grant.viewer; c.grant.viewer = v.slice(0, -1) + (v.endsWith("x") ? "y" : "x"); c.grant.seeds.viewer = c.grant.viewer; } },
  ],
  "sealed-policy/v1": [
    { label: "flip a model's gate verdict", mutate: (c) => { const m = c.models.find((m: any) => !m.verdict.pass); m.verdict.pass = true; m.verdict.reason = "forged"; } },
  ],
  "sealed-position/v1": [
    { label: "inflate a winning stake", mutate: (c) => {
      if (c.stake.amounts) { c.stake.amounts[1] = "900000000"; c.verdict.estPayout = "999000000"; c.verdict.staked = "930000000"; }
      else { c.stake.amount = String(BigInt(c.stake.amount) * 2n); if (c.verdict.staked) c.verdict.staked = c.stake.amount; }
    } },
  ],
};

export async function artifactTamper(target: string, snapPath?: string, recursive = false, exhibitDir?: string) {
  const { writeFileSync, mkdtempSync, statSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  target = resolveInputPath(target);
  // URL targets — the same deep links as artifactVerify: fetch the hosted
  // bytes to a temp file and forge those, not a committed fixture.
  if (/^https?:\/\//.test(target)) {
    const u = new URL(target);
    const card = u.searchParams.get("card");
    if (card !== null) {
      if (!/^[a-zA-Z0-9._/-]+\.(json|md)$/.test(card)) throw new Error(`unsafe ?card= path: ${card}`);
      target = new URL(card, u).href;
    }
    console.log(`fetching ${target}`);
    const r = await fetch(target);
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${target}`);
    const tmp = join(mkdtempSync(join(tmpdir(), "sealed-url-")), target.split("/").pop() ?? "artifact.json");
    writeFileSync(tmp, await r.text());
    return artifactTamper(tmp, snapPath, false, exhibitDir);
  }
  // dir mode: attack every artifact that has a canned forgery — the whole
  // evidence tree proves it can't be lied to, one pass.
  if (statSync(target).isDirectory()) {
    const files: string[] = [];
    const walk = (d: string, depth: number) => {
      for (const f of readdirSync(d).sort()) {
        const full = join(d, f);
        if (statSync(full).isDirectory()) { if (recursive && depth < 3) walk(full, depth + 1); continue; }
        if (!f.endsWith(".json") || ["index.json", "SHA256SUMS"].includes(f)) continue;
        try { const k = JSON.parse(readFileSync(full, "utf8")).kind; if (k && TAMPER_DEFS[k]) files.push(full); } catch {}
      }
    };
    walk(target, 0);
    if (!files.length) throw new Error(`no artifacts with canned attacks in ${target}`);
    console.log(`sealed-tamper/v1 — attacking ${files.length} artifact(s) in ${target}${recursive ? " (recursive)" : ""}`);
    let allOk = true, attacks = 0;
    for (const f of files) {
      const r = await artifactTamper(f, snapPath) as any;
      allOk &&= r.ok; attacks += r.attacks;
    }
    console.log(`\n${allOk ? "ALL FORGERIES CAUGHT" : "SOME FORGERY PASSED"} — ${attacks} attack(s) across ${files.length} artifact(s)`);
    if (!allOk) process.exitCode = 1;
    return { ok: allOk, attacks, artifacts: files.length };
  }
  const raw = readFileSync(target, "utf8");
  let kind: string | null = null;
  try { kind = JSON.parse(raw).kind ?? null; }
  catch { if (raw.includes("sealed-report/v1")) kind = "sealed-report/v1"; }
  if (!kind) throw new Error(`not a sealed artifact: ${target}`);
  const defs = TAMPER_DEFS[kind];
  console.log(`sealed-tamper/v1 — ${kind} · ${defs?.length ?? 0} canned attack(s)`);
  if (!defs?.length) {
    console.log("  (no canned mutations for this kind — markdown reports are replayed wholesale)");
    return { ok: true, attacks: 0 };
  }
  const base = JSON.parse(raw);
  const verify = ARTIFACT_ROUTES(snapPath, false)[kind];
  if (!verify) throw new Error(`no verifier route for ${kind}`);
  const dir = mkdtempSync(join(tmpdir(), "sealed-tamper-"));
  let caught = 0;
  const orig = console.log;
  for (let i = 0; i < defs.length; i++) {
    const forged = JSON.parse(JSON.stringify(base));
    defs[i].mutate(forged);
    const fp = join(dir, `forged-${i}.json`);
    writeFileSync(fp, JSON.stringify(forged, null, 2));
    let ok = true, detail = "";
    const savedExit = process.exitCode;
    const lines: string[] = [];
    console.log = (...a: any[]) => { lines.push(a.map(String).join(" ")); };
    try { const r = await verify(fp); ok = (r.ok ?? (r.fail === 0)) === true; }
    catch (e: any) { ok = false; detail = ` (${e?.message ?? e})`; }
    finally { console.log = orig; process.exitCode = savedExit; }
    if (!ok) {
      caught++;
      console.log(`  FORGERY CAUGHT — ${defs[i].label}${detail}`);
      // the lie exhibit: a sealed-tamper/v1 card IS the forged artifact,
      // wrapped with the attack name + the check(s) it died at. Verifying
      // the exhibit positively replays the rejection.
      if (exhibitDir) {
        const died = lines.filter((l) => /\bFAIL\b|✗/.test(l))
          .map((l) => l.replace(/^.*?(?:\bFAIL\b|✗)\s*/, "").split("—")[0].trim())
          .filter(Boolean);
        // a forgery that throws (malformed-by-construction) names its death
        // too — record the thrown signature so verification stays strict.
        const expectThrow = !died.length && detail ? detail.trim().replace(/^\(|\)$/g, "") : undefined;
        const exhibit = {
          kind: "sealed-tamper/v1",
          attack: defs[i].label,
          targetKind: kind,
          targetCard: target.split("/").pop(),
          expectFail: died,
          ...(expectThrow ? { expectThrow } : {}),
          forgedAt: new Date().toISOString(),
          forged,
        };
        const slug = defs[i].label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const out = `${exhibitDir}/${(target.split("/").pop() ?? "card").replace(/\.json$/, "")}.${slug}.json`;
        writeFileSync(out, JSON.stringify(exhibit, null, 2) + "\n");
        console.log(`    → exhibit written: ${out} (died at ${died.join(", ") || "thrown error"})`);
      }
    }
    else console.log(`  FORGERY ACCEPTED — ${defs[i].label} — THE VERIFIER TOOK A LIE`);
  }
  console.log(caught === defs.length
    ? `ALL ${caught} FORGERIES CAUGHT — the verifier rejects its own lies`
    : `${caught}/${defs.length} caught — ${defs.length - caught} forgery(ies) verified`);
  if (caught !== defs.length) process.exitCode = 1;
  return { ok: caught === defs.length, attacks: defs.length, caught };
}

/** `sealed-tamper/v1` — the lie exhibit. The payload IS a forged artifact
 *  (kind + attack + the checks it died at recorded at mint time). Verifying
 *  an exhibit replays the forgery against the REAL verifier and asserts it
 *  still dies at the same named check — proof, pinned in the bundle, that
 *  the evidence base defends itself. A "fixed" forgery (one that now
 *  verifies) FAILS the exhibit. */
export async function tamperCardVerify(file: string, json = false, snapPath?: string) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-tamper/v1") throw new Error(`not a sealed-tamper/v1 exhibit (kind=${card.kind})`);
  if (!card.forged || card.forged.kind !== card.targetKind)
    throw new Error("exhibit carries no forged target card");
  // the inner verifier must run in TEXT mode — json mode prints no
  // "FAIL <check>" lines, and those names are what the exhibit asserts.
  const route = ARTIFACT_ROUTES(snapPath, false)[card.targetKind];
  if (!route) throw new Error(`no verifier route for ${card.targetKind}`);
  const tmp = join(mkdtempSync(join(tmpdir(), "sealed-exhibit-")), "forged.json");
  writeFileSync(tmp, JSON.stringify(card.forged, null, 2));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { lines.push(a.map(String).join(" ")); };
  let ok = true, err = "";
  const saved = process.exitCode;
  try { const r = await route(tmp); ok = (r.ok ?? (r.fail === 0)) === true; }
  catch (e: any) { ok = false; err = String(e?.message ?? e); }
  finally { console.log = orig; process.exitCode = saved; }
  const died = lines.filter((l) => /\bFAIL\b|✗/.test(l))
    .map((l) => l.replace(/^.*?(?:\bFAIL\b|✗)\s*/, "").split("—")[0].trim()).filter(Boolean);
  const expected: string[] = card.expectFail ?? [];
  // strict: EVERY recorded check must fire — an exhibit that claims it died
  // at "account binding" but actually dies earlier is a lie about its lie.
  const checksNamed = expected.every((x) => died.includes(x));
  // a thrown rejection carries its signature in expectThrow — require the
  // replay to throw the same message head.
  const throwNamed = typeof card.expectThrow === "string" &&
    err.includes(card.expectThrow.slice(0, 60));
  const named = expected.length ? checksNamed : (card.expectThrow ? throwNamed : true);
  const pass = !ok && named;
  if (!json) {
    console.log(`  ${!ok ? "PASS" : "FAIL"} inner forgery rejected — the ${card.targetKind} verifier refused it${err ? ` (${err})` : ""}`);
    for (const f of died.slice(0, 4)) console.log(`       died at: ${f}`);
    console.log(`  ${named ? "PASS" : "FAIL"} named check — expected ${expected.join(", ") || card.expectThrow || "(any rejection)"}`);
    console.log(`${pass ? "TAMPER EXHIBIT VERIFIED" : "EXHIBIT FAILED"} — "${card.attack}" on ${card.targetCard ?? "?"}`);
  }
  return { ok: pass, pass: pass ? 2 : 0, fail: pass ? 0 : 1 };
}

/** Walk an evidence tree and list every sealed artifact with a
 *  human title. Shared by `chain catalog` (print/emit) and
 *  `catalogVerify` (completeness replay) — one scan, three uses. */
async function scanArtifacts(dir: string) {
  const { statSync, readdirSync } = await import("node:fs");
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const f of readdirSync(d).sort()) {
      const full = `${d}/${f}`;
      if (statSync(full).isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
      if (!(f.endsWith(".json") || f.endsWith(".md"))) continue;
      if (["index.json", "artifacts.json", "SHA256SUMS", "README.md"].includes(f)) continue;
      files.push(full);
    }
  };
  walk(dir, 0);
  const titleOf = (raw: any, file: string): string => {
    const base = file.split("/").pop()!.replace(/\.(json|md)$/, "");
    switch (raw?.kind) {
      case "sealed-claim/v1": return raw.model?.id ?? base;
      case "sealed-match/v1": return raw.a?.id && raw.b?.id ? `${raw.a.id} vs ${raw.b.id}` : base;
      case "sealed-policy/v1": {
        const p = raw.policy ?? {};
        return [`≥${p.minPct}%`, `≥${p.minRuns} runs`, p.vouchedOnly ? "vouched" : "", p.noPostReveal ? "no post-reveal" : "", p.bank ? `bank ${String(p.bank).slice(0, 8)}…` : ""].filter(Boolean).join(" · ");
      }
      case "sealed-bank/v1": return `${raw.bank?.name ?? base} (${["authored", "generated", "private"][raw.bank?.kind] ?? "bank"})`;
      case "sealed-evidence-digest/v1": return "whole-ledger digest";
      case "sealed-board/v1": return "paired-evidence leaderboard";
      case "sealed-position/v1": return `${raw.verdict?.state ?? "?"} · ${raw.venue?.kind ?? "?"} venue — ${String(raw.position?.seeds?.bettor ?? "").slice(0, 8)}…`;
      case "sealed-bounty/v1": return `${raw.verdict?.state ?? (raw.bounty?.status === 1 ? "claimed" : "open")} · ${(Number(raw.bounty?.amount ?? 0) / 1e9).toFixed(3)} SOL · ≥${raw.bounty?.threshold ?? "?"}/${raw.bank?.capacity ?? "?"} — ${String(raw.bounty?.seeds?.sponsor ?? "").slice(0, 8)}…`;
      case "sealed-grant/v1": return `${raw.bank?.name ?? "?"} part ${raw.grant?.part ?? "?"} → ${String(raw.grant?.viewer ?? "").slice(0, 8)}… · ${raw.panel?.viewersOnBank ?? "?"} viewer(s)`;
      case "sealed-trail/v1": return `run ${String(raw.run?.pk ?? base).slice(0, 8)}… (${base})`;
      case "sealed-tamper/v1": return `forgery: ${raw.attack ?? "?"} → ${raw.targetCard ?? base}`;
      default: return base;
    }
  };
  const out: { path: string; kind: string; title: string }[] = [];
  for (const full of files) {
    const raw = readFileSync(full, "utf8");
    let kind: string | null = null, parsed: any = null;
    try { parsed = JSON.parse(raw); kind = parsed.kind ?? null; }
    catch { kind = raw.includes("sealed-report/v1") ? "sealed-report/v1" : null; }
    if (!kind || !kind.startsWith("sealed-")) continue;
    out.push({ path: full.slice(dir.length + 1), kind, title: titleOf(parsed, full) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** `sealed-catalog/v1` — the evidence table of contents, itself verifiable.
 *  `chain catalog` prints it; `--emit` writes docs/evidence/artifacts.json
 *  (+ the served copy web/artifacts.json); `--check` proves the committed
 *  index is complete — an unlisted artifact fails the build. */
export async function chainCatalog(dir = "docs/evidence", emit = false, check = false, json = false) {
  const { writeFileSync } = await import("node:fs");
  const artifacts = await scanArtifacts(dir);
  const byKind = new Map<string, number>();
  for (const a of artifacts) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  const doc = {
    kind: "sealed-catalog/v1",
    root: dir,
    count: artifacts.length,
    byKind: Object.fromEntries([...byKind].sort()),
    artifacts,
  };
  if (check) {
    const committed = JSON.parse(readFileSync(`${dir}/artifacts.json`, "utf8"));
    const same = JSON.stringify(committed.artifacts) === JSON.stringify(artifacts);
    if (json) console.log(JSON.stringify({ ok: same, count: artifacts.length }));
    else {
      if (same) console.log(`CATALOG COMPLETE — ${artifacts.length} artifact(s), every sealed-*/v1 file under ${dir}/ is listed`);
      else {
        const have = new Set<string>(committed.artifacts.map((a: any) => String(a.path)));
        const want = new Set(artifacts.map((a) => a.path));
        for (const p of artifacts.map((a) => a.path).filter((p) => !have.has(p))) console.log(`  MISSING from index: ${p}`);
        for (const p of [...have].filter((p) => !want.has(p))) console.log(`  STALE in index: ${p}`);
        console.log(`CATALOG DRIFT — ${dir}/artifacts.json does not match the tree (run: chain catalog --emit)`);
      }
    }
    if (!same) process.exitCode = 1;
    return { ok: same };
  }
  if (emit) {
    const { dirname, join } = await import("node:path");
    const body = JSON.stringify(doc, null, 2) + "\n";
    writeFileSync(`${dir}/artifacts.json`, body);
    // mirror the served copy — docs/evidence → <repo>/web; foreign trees skip.
    const webCopy = join(dirname(dirname(dir)), "web", "artifacts.json");
    try { const { existsSync } = await import("node:fs"); if (existsSync(dirname(webCopy))) writeFileSync(webCopy, body); } catch { /* web/ absent — fine */ }
    console.log(`wrote ${dir}/artifacts.json (+ web/ mirror when the tree is docs/evidence) — ${artifacts.length} artifact(s), ${byKind.size} kinds`);
    return { ok: true, count: artifacts.length };
  }
  if (json) console.log(JSON.stringify(doc));
  else {
    console.log(`sealed-catalog/v1 — ${artifacts.length} artifact(s) under ${dir}/`);
    for (const [k, n] of [...byKind].sort()) {
      console.log(`\n${k} — ${n}`);
      for (const a of artifacts.filter((x) => x.kind === k)) console.log(`  ${a.path.padEnd(52)} ${a.title}`);
    }
  }
  return { ok: true, count: artifacts.length };
}

/** Replays a committed `sealed-catalog/v1` index against the tree it covers:
 *  completeness (scan == index), existence + kind-honesty (every listed file
 *  parses to its declared kind), and hash-binding (every entry's sha256 is
 *  the one pinned in SHA256SUMS). The table of contents is itself evidence. */
export async function catalogVerify(f: string, json = false) {
  const { dirname } = await import("node:path");
  const dir = dirname(f);
  const doc = JSON.parse(readFileSync(f, "utf8"));
  const pass: string[] = [], fail: string[] = [];
  const ck = (name: string, ok: boolean, detail = "") => { (ok ? pass : fail).push(name); if (!json) console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  ck("kind", doc.kind === "sealed-catalog/v1");
  const fresh = await scanArtifacts(dir);
  ck("completeness", JSON.stringify(fresh) === JSON.stringify(doc.artifacts), `${doc.artifacts?.length ?? 0} listed / ${fresh.length} found`);
  const declared = new Map<string, string>((doc.artifacts ?? []).map((a: any) => [a.path, a.kind]));
  let kindOk = true, missing = 0;
  for (const [p, k] of declared) {
    try {
      const raw = readFileSync(`${dir}/${p}`, "utf8");
      const actual = p.endsWith(".md") ? (raw.includes("sealed-report/v1") ? "sealed-report/v1" : null) : JSON.parse(raw).kind;
      if (actual !== k) { kindOk = false; if (!json) console.log(`    ${p}: declared ${k}, file says ${actual}`); }
    } catch { missing++; kindOk = false; }
  }
  ck("existence + kind honesty", kindOk, missing ? `${missing} listed file(s) unreadable` : `${declared.size} files parse to their declared kind`);
  try {
    const sums = readFileSync(`${dir}/SHA256SUMS`, "utf8");
    const pinned = new Map(sums.trim().split("\n").map((l) => { const i = l.indexOf("  "); return [l.slice(i + 2).replace(/^\.\//, ""), l.slice(0, i)]; }));
    let hashOk = true, bound = 0;
    for (const p of declared.keys()) {
      const want = pinned.get(p);
      if (!want) { hashOk = false; if (!json) console.log(`    ${p}: not pinned in SHA256SUMS`); continue; }
      const got = createHash("sha256").update(readFileSync(`${dir}/${p}`)).digest("hex");
      if (got !== want) { hashOk = false; if (!json) console.log(`    ${p}: sha256 ${got.slice(0, 12)}… != pinned ${want.slice(0, 12)}…`); }
      else bound++;
    }
    ck("hash binding", hashOk, `${bound}/${declared.size} entries sha256-match SHA256SUMS`);
  } catch { ck("hash binding", false, "SHA256SUMS unreadable beside the catalog"); }
  const ok = fail.length === 0;
  if (!json) console.log(`${ok ? "CATALOG VERIFIED" : "CATALOG FAILED"} — ${pass.length} pass, ${fail.length} fail`);
  if (!ok) process.exitCode = 1;
  return { ok, pass: pass.length, fail: fail.length };
}

/** `sealed-fingerprint/v1` — the whole evidence base as ONE sha256.
 *  SHA256SUMS pins every docs/evidence byte, MANIFEST pins every web byte
 *  (including snapshot.json + the served artifact copies); the bundle root
 *  binds the two manifests, so changing any single byte anywhere in the
 *  trees breaks it. Every pinned file is re-hashed before the root prints —
 *  the fingerprint is earned, not asserted. */
export async function chainFingerprint(evidenceDir: string, webDir: string, json = false) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const shaBytes = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const shaFile = (f: string) => shaBytes(readFileSync(f));
  const resolve = (d: string, mf: string) =>
    existsSync(join(d, mf)) ? d : existsSync(join("..", "..", d, mf)) ? join("..", "..", d) : d;
  evidenceDir = resolve(evidenceDir, "SHA256SUMS");
  webDir = resolve(webDir, "MANIFEST");
  const parseSums = (mf: string) =>
    readFileSync(mf, "utf8").split("\n").map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.match(/^([0-9a-f]{64})\s+[ *]?(.+)$/);
      if (!m) throw new Error(`malformed manifest line in ${mf}: ${l}`);
      return { hash: m[1], rel: m[2].replace(/^\.\//, "") };
    });
  const evMf = join(evidenceDir, "SHA256SUMS"), webMf = join(webDir, "MANIFEST");
  const ev = parseSums(evMf), web = parseSums(webMf);
  const bad: string[] = [];
  for (const [entries, base] of [[ev, evidenceDir], [web, webDir]] as const) {
    for (const e of entries) {
      try { if (shaFile(join(base, e.rel)) !== e.hash) bad.push(`${base}/${e.rel}`); }
      catch { bad.push(`${base}/${e.rel}`); }
    }
  }
  const evidenceRoot = shaFile(evMf), webRoot = shaFile(webMf);
  const snapshotHash = shaFile(join(webDir, "snapshot.json"));
  const bundleRoot = shaBytes(`sealed-fingerprint/v1\n${evidenceRoot}\n${webRoot}\n`);
  const total = ev.length + web.length, ok = bad.length === 0;
  const out = {
    kind: "sealed-fingerprint/v1", snapshot: snapshotHash,
    evidenceRoot, evidenceFiles: ev.length, webRoot, webFiles: web.length,
    bundleRoot, filesHashed: total - bad.length, filesTotal: total,
    mismatches: bad.length ? bad : undefined,
  };
  if (json) console.log(JSON.stringify(out));
  else {
    console.log(`sealed-fingerprint/v1 — the whole evidence base as one hash`);
    console.log(`  snapshot.json     ${snapshotHash}`);
    console.log(`  docs/evidence     ${evidenceRoot}  (${ev.length} pinned file(s))`);
    console.log(`  web bundle        ${webRoot}  (${web.length} pinned file(s))`);
    console.log(`  re-hash check     ${ok ? "PASS" : "FAIL"} — ${total - bad.length}/${total} file(s) match${ok ? "" : ` · ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}`}`);
    console.log(`  BUNDLE ROOT       ${bundleRoot}`);
  }
  if (!ok) process.exitCode = 1;
  return out;
}

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** `chain fingerprint --anchor [file]` — notarize the bundle root on-chain:
 *  a memo tx carrying `sealed-fingerprint/v1 <root>` posts to devnet, so the
 *  evidence hash is timestamped by the ledger itself. The emitted
 *  `sealed-anchor/v1` doc lives OUTSIDE the pinned trees — anchoring the
 *  bundle inside the bundle would change the very root it claims. Anyone
 *  can check the memo via the printed explorer link, no tooling needed. */
export async function fingerprintAnchor(outFile: string, evDir: string, webDir: string, kpPath?: string, rpcUrl?: string) {
  const { writeFileSync } = await import("node:fs");
  const fp = await chainFingerprint(evDir, webDir, false);
  if (process.exitCode === 1) throw new Error("manifest re-hash failed — refusing to anchor a dirty bundle");
  const kp = loadKeypair(kpPath ?? process.env.ANCHOR_WALLET ?? join(homedir(), ".config", "solana", "id.json"));
  const url = rpcUrl ?? process.env.SEALED_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(url, "confirmed");
  const memo = `sealed-fingerprint/v1 ${fp.bundleRoot}`;
  const tx = new Transaction().add({
    keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }],
    programId: MEMO_PROGRAM_ID, data: Buffer.from(memo, "utf8"),
  });
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
  const st = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const devnet = /devnet|testnet|127\.0\.0\.1|localhost/.test(url);
  const doc = {
    kind: "sealed-anchor/v1", bundleRoot: fp.bundleRoot, memo,
    signature: sig, cluster: url, payer: kp.publicKey.toBase58(),
    slot: st?.slot ?? null, blockTime: st?.blockTime ?? null,
    explorer: devnet
      ? `https://explorer.solana.com/tx/${sig}?cluster=${url.includes("devnet") ? "devnet" : "custom&customUrl=" + encodeURIComponent(url)}`
      : `https://explorer.solana.com/tx/${sig}`,
  };
  writeFileSync(outFile, JSON.stringify(doc, null, 2) + "\n");
  console.log(`\nanchored — ${memo}`);
  console.log(`  signature   ${sig}  ·  slot ${doc.slot ?? "?"}  ·  ${new Date((doc.blockTime ?? 0) * 1000).toISOString()}`);
  console.log(`  explorer    ${doc.explorer}`);
  console.log(`  wrote ${outFile} (outside the manifests — anchoring the bundle inside the bundle would move the root)`);
  return doc;
}

/** `chain fingerprint --check-anchor <file>` — fetch the notarization tx
 *  back from the cluster and prove the chain carries the claimed root;
 *  then compare that root against the CURRENT tree (anchors go stale the
 *  moment evidence moves — DRIFT just means: re-anchor at freeze). */
export async function anchorVerify(file: string, evDir: string, webDir: string, rpcUrl?: string) {
  const { readFileSync } = await import("node:fs");
  const rows: string[] = [];
  const pass = (n: string, d: string) => rows.push(`  ✓ ${n} — ${d}`);
  const fail = (n: string, d: string) => { rows.push(`  ✗ ${n} — ${d}`); process.exitCode = 1; };
  let nBad = 0;
  const f = (n: string, d: string) => { nBad++; fail(n, d); };
  const a = JSON.parse(readFileSync(file, "utf8"));
  if (a.kind !== "sealed-anchor/v1") throw new Error(`not a sealed-anchor/v1 doc (kind=${a.kind})`);
  console.log(`sealed-anchor/v1 — ${file}`);
  const url = rpcUrl ?? a.cluster ?? "https://api.devnet.solana.com";
  const conn = new Connection(url, "confirmed");
  const st = await conn.getTransaction(a.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!st) { f("on-chain fetch", `${a.signature} not found on ${url}`); }
  else {
    const logs = st.meta?.logMessages ?? [];
    const memoLog = logs.map((l) => l.match(/^Program log: Memo \(len \d+\): "(.*)"$/)?.[1]).find(Boolean);
    if (memoLog === a.memo) pass("memo on-chain", `the ledger carries "${memoLog}" — timestamped at slot ${st.slot}, blockTime ${new Date((st.blockTime ?? 0) * 1000).toISOString()}`);
    else f("memo on-chain", `tx exists but memo differs — got "${memoLog ?? "(none)"}", wanted "${a.memo}"`);
    const declared = `sealed-fingerprint/v1 ${a.bundleRoot}`;
    memoLog === declared ? pass("root in memo", "the memo embeds the claimed BUNDLE ROOT")
      : f("root in memo", `memo="${memoLog ?? "(none)"}" ≠ "${declared}"`);
  }
  const cur = await chainFingerprint(evDir, webDir, false);
  cur.bundleRoot === a.bundleRoot
    ? pass("anchor vs current", "the anchored root IS the current bundle root — evidence unchanged since notarization")
    : rows.push(`  ! anchor vs current — DRIFT: anchored ${a.bundleRoot.slice(0, 16)}… ≠ current ${cur.bundleRoot.slice(0, 16)}… — evidence moved since the anchor; re-anchor at freeze (this check can't fail, staleness is information)`);
  console.log(rows.join("\n"));
  console.log(`${nBad === 0 ? "ANCHOR VERIFIED" : "ANCHOR FAILED"} — ${a.signature} on ${url}`);
  return { ok: nBad === 0, drift: cur.bundleRoot !== a.bundleRoot };
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
  // the venue's book — every stake classified the same way `positions`
  // does (me=null = all bettors), so the dossier shows WHO is in.
  const { rows: book } = classifyPositions(pos, dpos, venueMapsOf(markets, ladders, darks), null);
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
  if (book.length) out.book = book.map((r) => ({ position: r.posPk, bettor: r.bettor, state: r.state, staked: r.staked.toString(), est: r.est.toString(), note: r.note }));
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
  for (const r of book)
    console.log(`    ${r.bettor?.slice(0, 12)}…  ${solAmt(r.staked)}◎ ${r.est > 0n ? `→ ~${solAmt(r.est)}◎ ` : ""}${r.state}${r.posPk ? `  · position ${r.posPk.slice(0, 12)}…` : ""}`);
  console.log(`  permalink — https://josepha-mayo.github.io/sealed/?pk=${pkStr}`);
  return out;
}

/** `chain market quote <venue> --outcome <i> --lamports <n>` — the
 *  bettor's pre-trade simulator: "if I stake N on outcome i and it
 *  wins, what pays back?" Runs the venue's own pro-rata math locally
 *  (parimutuel: your winnings = your share of the winning pool × the
 *  post-fee pot) so nobody has to eyeball a payout or send a tx to
 *  find out. Covers bands/duels (per-outcome), ladders (per-leg win),
 *  and darks (commit-and-pray — the quote shows best/worst reveal cases). */
export async function marketQuote(pkStr: string, outcome: number, lamports: bigint, json = false, snapPath?: string) {
  const pk = new PublicKey(pkStr);
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [markets, ladders, darks]: Acct[][] =
    sm ? ["Market", "Ladder", "DarkMarket"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "ladder", "darkMarket"].map((n) => (mAcct() as any)[n].all()));
  const venue =
    markets.find((x) => x.publicKey.equals(pk)) ? { k: "band", a: markets.find((x) => x.publicKey.equals(pk))!.account as any } :
    ladders.find((x) => x.publicKey.equals(pk)) ? { k: "ladder", a: ladders.find((x) => x.publicKey.equals(pk))!.account as any } :
    darks.find((x) => x.publicKey.equals(pk)) ? { k: "dark", a: darks.find((x) => x.publicKey.equals(pk))!.account as any } : null;
  if (!venue) { console.log(`no venue at ${pkStr}`); process.exitCode = 2; return null; }
  const a = venue.a;
  if (Number(a.status) !== 0) { console.log(`venue is ${["open","resolved","expired"][Number(a.status)] ?? a.status} — quotes only apply while open`); process.exitCode = 1; return null; }
  const fee = (pot: bigint) => pot - (pot * BigInt(Number(a.feeBps ?? 0))) / 10000n;
  const sol = (x: bigint | number) => (Number(x) / 1e9).toFixed(4);
  let out: any;
  if (venue.k === "dark") {
    // commit is sealed: the quote is a range over reveal scenarios.
    const pool = BigInt(a.poolTotal.toString()) + lamports;
    const win = BigInt(a.winTotal.toString());
    const best = lamports * fee(pool) / (win + lamports);       // you alone on the winning side
    const worst = win > 0n ? lamports * fee(pool) / (win + lamports) : best;
    out = { venue: pkStr, kind: "dark", stake: lamports.toString(), outcome: "(sealed — commitment binds to the encrypted side)",
      scenarios: { if_only_you_win: sol(best) + " ◎", if_winTotal_stays: sol(worst) + " ◎", if_no_reveal: "gross refund" },
      note: `pool would be ${sol(pool)} ◎; winners split post-fee pro-rata — sealed losers forfeit into it` };
  } else {
    const totals = (a.totals as any[]).map((t) => BigInt(t.toString()));
    // totals is a fixed 8-slot array — live outcomes are nOutcomes for
    // bands/duels and legCount for ladders (the program slices the same way)
    const n = venue.k === "ladder" ? Number(a.legCount) : Number(a.nOutcomes);
    if (outcome < 0 || outcome >= n) { console.log(`outcome ${outcome} out of range — this venue has ${n} ${venue.k === "ladder" ? "leg(s)" : "bucket(s)"}`); process.exitCode = 2; return null; }
    const winTotal = totals[outcome] + lamports;
    const pot = totals.reduce((s, t) => s + t, 0n) + lamports;
    const est = lamports * fee(pot) / winTotal;
    const impliedPct = Number(winTotal * 10000n / pot) / 100;
    out = { venue: pkStr, kind: venue.k === "ladder" ? `ladder leg ${outcome}` : `outcome ${outcome}`,
      stake: lamports.toString(), estPayoutIfWins: est.toString(), estSol: sol(est),
      impliedChancePct: impliedPct, roiPct: est > 0n ? Number((est - lamports) * 10000n / lamports) / 100 : -100,
      note: `pool ${sol(pot)} ◎ → winning side splits ${sol(fee(pot))} ◎ post-fee; your share ${sol(lamports)}/${sol(winTotal)} of that side` };
  }
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`quote — ${pkStr.slice(0, 12)}… (${venue.k})`);
  if (venue.k === "dark") {
    console.log(`  stake ${sol(lamports)} ◎ sealed — payout depends on who reveals:`);
    console.log(`    only you win   → ~${(out as any).scenarios.if_only_you_win}`);
    console.log(`    win pool stays → ~${(out as any).scenarios.if_winTotal_stays}`);
    console.log(`    zero reveals   → ${(out as any).scenarios.if_no_reveal}`);
  } else {
    console.log(`  stake ${sol(lamports)} ◎ on ${out.kind} → ~${(out as any).estSol} ◎ back if it wins (${(out as any).roiPct >= 0 ? "+" : ""}${(out as any).roiPct}% ROI)`);
    console.log(`  book implies ${(out as any).impliedChancePct}% on that side — ${(out as any).note}`);
  }
  return out;
}

/** `chain market odds [venue]` — what the stakes BELIEVE. A prediction
 *  market's product is its implied-probability distribution; this renders
 *  it: per-outcome implied share + decimal odds (post-fee pot ÷ side) for
 *  one venue, or every open venue compactly when no key is given. Dark
 *  markets list pool-only — a sealed book can't express a side. */
export async function marketOdds(pkStr: string | undefined, json = false, snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [markets, ladders, darks]: Acct[][] =
    sm ? ["Market", "Ladder", "DarkMarket"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "ladder", "darkMarket"].map((n) => (mAcct() as any)[n].all()));
  const runs: Acct[] = ss ? snapOf(ss, "Run") : await (sealedProgram().program.account as any).run.all();
  const model = new Map(runs.map((r) => [r.publicKey.toBase58(), String(r.account.modelId)]));

  const fee = (bps: number, pot: bigint) => pot - (pot * BigInt(bps)) / 10000n;
  type Leg = { label: string; impliedPct: number; decimal: number };
  const board = (pkB58: string, kind: string, totals: bigint[], labels: string[], feeBps: number) => {
    const pot = totals.reduce((s, t) => s + t, 0n);
    const legs: Leg[] = totals.map((t, i) => ({
      label: labels[i],
      impliedPct: pot > 0n ? Number(t * 10000n / pot) / 100 : 0,
      decimal: t > 0n && pot > 0n ? Number((fee(feeBps, pot) * 100n) / t) / 100 : 0,
    }));
    return { venue: pkB58, kind, pool: (Number(pot) / 1e9).toFixed(4) + " ◎", legs };
  };
  const DUEL = ["A wins", "B wins", "tie"];

  const out: any[] = [];
  const only = pkStr ? new PublicKey(pkStr) : null;
  for (const m of markets) {
    const M = m.account as any;
    if (only && !m.publicKey.equals(only)) continue;
    if (Number(M.status) !== 0) continue;
    const duel = M.runB && !(M.runB as PublicKey).equals(PublicKey.default);
    const n = Number(M.nOutcomes);
    const labels = Array.from({ length: n }, (_, i) => duel
      ? `${DUEL[i]}${i < 2 ? ` · ${model.get((i === 0 ? M.run : M.runB).toBase58()) ?? "?"}` : ""}`
      : `[${i}] ${outcomeLabel(n, (M.edges as any[]).map(Number), i)}`);
    out.push(board(m.publicKey.toBase58(), duel ? "duel" : "band",
      (M.totals as any[]).map((t) => BigInt(t.toString())).slice(0, n), labels, Number(M.feeBps)));
  }
  for (const l of ladders) {
    const L = l.account as any;
    if (only && !l.publicKey.equals(only)) continue;
    if (Number(L.status) !== 0) continue;
    const n = Number(L.legCount);
    const labels = Array.from({ length: n }, (_, i) =>
      `leg ${i} · ${model.get((L.legs as PublicKey[])[i].toBase58()) ?? "?"}`);
    out.push(board(l.publicKey.toBase58(), "ladder", (L.totals as any[]).map((t) => BigInt(t.toString())).slice(0, n), labels, Number(L.feeBps)));
  }
  const darkRows: any[] = [];
  for (const d of darks) {
    const D = d.account as any;
    if (only && !d.publicKey.equals(only)) continue;
    if (Number(D.status) !== 0) continue;
    darkRows.push({ venue: d.publicKey.toBase58(), kind: "dark",
      pool: (Number(D.poolTotal) / 1e9).toFixed(4) + " ◎",
      legs: [], note: "sealed book — sides don't express until reveal" });
  }
  out.push(...darkRows);
  if (only && !out.length) { console.log(`no open venue at ${pkStr}`); process.exitCode = 2; return null; }
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`market odds — ${out.length} open venue(s), implied by the books themselves`);
  const funded = out.filter((v) => v.legs.length ? v.legs.some((l: Leg) => l.impliedPct > 0) : parseFloat(v.pool) > 0);
  const empty = out.length - funded.length;
  for (const v of funded.sort((a, b) => parseFloat(b.pool) - parseFloat(a.pool))) {
    if (!v.legs.length) { console.log(`  ${v.kind.padEnd(6)} ${v.venue.slice(0, 12)}… pool ${v.pool} — ${v.note}`); continue; }
    const top = v.legs.reduce((a: Leg, b: Leg) => (b.impliedPct > a.impliedPct ? b : a));
    console.log(`  ${v.kind.padEnd(6)} ${v.venue.slice(0, 12)}… pool ${v.pool} — book's pick: ${top.label} @ ${top.impliedPct}%`);
    for (const leg of v.legs)
      console.log(`      ${leg.label.padEnd(34)} ${String(leg.impliedPct).padStart(6)}%   ${leg.decimal.toFixed(2)}x`);
  }
  if (empty) console.log(`  … and ${empty} venue(s) with empty books — open but nothing staked yet`);
  return out;
}

/** `chain market sentiment` — the stakes' opinion, aggregated per model.
 *  `odds` shows one book; this pools every open funded venue into a
 *  stake-weighted belief per model: duels/ladders contribute win
 *  probability, bands contribute an implied expected score (Σ share ×
 *  band midpoint). The paired-evidence leaderboard (`compare --all`)
 *  says what the data PROVES; this says what the money EXPECTS — the
 *  two columns side by side are the project's thesis. */
export async function marketSentiment(json = false, snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [markets, ladders]: Acct[][] =
    sm ? ["Market", "Ladder"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "ladder"].map((n) => (mAcct() as any)[n].all()));
  const runs: Acct[] = ss ? snapOf(ss, "Run") : await (sealedProgram().program.account as any).run.all();
  const model = new Map(runs.map((r) => [r.publicKey.toBase58(), String(r.account.modelId)]));

  type Row = { winStake: bigint; winShare: number; venues: Set<string>; scoreStake: bigint; scoreNum: number };
  const acc = new Map<string, Row>();
  const row = (m: string) => { if (!acc.has(m)) acc.set(m, { winStake: 0n, winShare: 0, venues: new Set(), scoreStake: 0n, scoreNum: 0 }); return acc.get(m)!; };
  const addWin = (m: string | undefined, share: number, stake: bigint, venue: string) => {
    if (!m) return; const r = row(m); r.winStake += stake; r.winShare += share * Number(stake); r.venues.add(venue);
  };
  const addScore = (m: string | undefined, expected: number, pool: bigint, venue: string) => {
    if (!m) return; const r = row(m); r.scoreStake += pool; r.scoreNum += expected * Number(pool); r.venues.add(venue);
  };

  for (const m of markets) {
    const M = m.account as any;
    if (Number(M.status) !== 0) continue;
    const n = Number(M.nOutcomes);
    const totals = (M.totals as any[]).map((t) => BigInt(t.toString())).slice(0, n);
    const pot = totals.reduce((s, t) => s + t, 0n);
    if (!pot) continue;
    const venue = m.publicKey.toBase58();
    const duel = M.runB && !(M.runB as PublicKey).equals(PublicKey.default);
    if (duel) {
      const a = model.get((M.run as PublicKey).toBase58()), b = model.get((M.runB as PublicKey).toBase58());
      // a model's duel win-expectation counts its own side + half the tie book
      addWin(a, (Number(totals[0]) + Number(totals[2]) / 2) / Number(pot), pot, venue);
      addWin(b, (Number(totals[1]) + Number(totals[2]) / 2) / Number(pot), pot, venue);
    } else {
      // band → implied expected score: Σ implied-share × band midpoint
      // (top open bucket uses its lower edge — conservative)
      const edges = (M.edges as any[]).map(Number);
      let expected = 0;
      for (let i = 0; i < n; i++) {
        const lo = i === 0 ? 0 : edges[i - 1];
        const hi = i === n - 1 ? null : edges[i];
        const mid = hi === null ? lo : lo === 0 ? hi / 2 : (lo + hi - 1) / 2;
        expected += (Number(totals[i]) / Number(pot)) * mid;
      }
      addScore(model.get((M.run as PublicKey).toBase58()), expected, pot, venue);
    }
  }
  for (const l of ladders) {
    const L = l.account as any;
    if (Number(L.status) !== 0) continue;
    const n = Number(L.legCount);
    const totals = (L.totals as any[]).map((t) => BigInt(t.toString())).slice(0, n);
    const pot = totals.reduce((s, t) => s + t, 0n);
    if (!pot) continue;
    const venue = l.publicKey.toBase58();
    for (let i = 0; i < n; i++)
      addWin(model.get((L.legs as PublicKey[])[i].toBase58()), Number(totals[i]) / Number(pot), pot, venue);
  }

  const rows = [...acc.entries()].map(([m, r]) => ({
    model: m,
    impliedWinPct: r.winStake > 0n ? Math.round((r.winShare / Number(r.winStake)) * 10000) / 100 : null,
    impliedScore: r.scoreStake > 0n ? Math.round((r.scoreNum / Number(r.scoreStake)) * 100) / 100 : null,
    stakeWeighed: (Number(r.winStake + r.scoreStake) / 1e9).toFixed(4) + " ◎",
    venues: r.venues.size,
  })).sort((a, b) => parseFloat(b.stakeWeighed) - parseFloat(a.stakeWeighed));
  if (json) { console.log(JSON.stringify(rows)); return rows; }
  console.log(`market sentiment — stake-weighted belief per model (${rows.length} model(s) priced)`);
  for (const r of rows)
    console.log(`  ${r.model.padEnd(28)} ${r.impliedWinPct !== null ? `wins ${String(r.impliedWinPct).padStart(6)}%` : "—".padStart(10)}  ${r.impliedScore !== null ? `scores ~${r.impliedScore}` : ""}  (${r.stakeWeighed} across ${r.venues} venue(s))`);
  return rows;
}

/** `chain market calibration` — did the books see it coming? For every
 *  RESOLVED venue with a non-empty book: the implied share the actual
 *  winner carried at close, a per-venue Brier score, and whether the
 *  favorite hit. The closing-line record is the only honest report card
 *  a prediction market has — and here it's computable because every
 *  resolution re-derives from Run.correct. Dark books stay excluded:
 *  sealed commitments carry no ex-ante price. */
export async function marketCalibration(json = false, snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [markets, ladders]: Acct[][] =
    sm ? ["Market", "Ladder"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "ladder"].map((n) => (mAcct() as any)[n].all()));

  type Row = { venue: string; kind: string; n: number; pot: string;
    winners: number[]; impliedWinnerPct: number; brier: number; favoriteHit: boolean };
  const rows: Row[] = [];
  const evalBook = (pk: string, kind: string, totals: bigint[], winners: number[]) => {
    const pot = totals.reduce((s, t) => s + t, 0n);
    if (!pot || !winners.length) return;
    const n = totals.length;
    const p = totals.map((t) => Number(t) / Number(pot));
    const wset = new Set(winners);
    const brier = p.reduce((s, pi, i) => s + (pi - (wset.has(i) ? 1 : 0)) ** 2, 0);
    const fav = p.indexOf(Math.max(...p));
    rows.push({ venue: pk, kind, n, pot: (Number(pot) / 1e9).toFixed(4) + " ◎",
      winners, impliedWinnerPct: Math.round(winners.reduce((s, w) => s + p[w], 0) * 10000) / 100,
      brier: Math.round(brier * 10000) / 10000, favoriteHit: wset.has(fav) });
  };
  for (const m of markets) {
    const M = m.account as any;
    if (Number(M.status) !== 1) continue;
    const n = Number(M.nOutcomes);
    evalBook(m.publicKey.toBase58(),
      M.runB && !(M.runB as PublicKey).equals(PublicKey.default) ? "duel" : "band",
      (M.totals as any[]).map((t) => BigInt(t.toString())).slice(0, n), [Number(M.outcome)]);
  }
  for (const l of ladders) {
    const L = l.account as any;
    if (Number(L.status) !== 1) continue;
    const n = Number(L.legCount), mask = Number(L.resultMask);
    const winners: number[] = [];
    for (let i = 0; i < n; i++) if ((mask >> i) & 1) winners.push(i);
    evalBook(l.publicKey.toBase58(), "ladder",
      (L.totals as any[]).map((t) => BigInt(t.toString())).slice(0, n), winners);
  }
  const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  const summary = {
    venuesScored: rows.length,
    favoriteHitRatePct: Math.round(100 * mean(rows.map((r) => (r.favoriteHit ? 1 : 0)))) ,
    meanImpliedWinnerPct: Math.round(mean(rows.map((r) => r.impliedWinnerPct)) * 100) / 100,
    meanBrier: Math.round(mean(rows.map((r) => r.brier)) * 10000) / 10000,
    uniformBaselinePct: Math.round(mean(rows.map((r) => 100 / r.n)) * 100) / 100,
    uniformBrier: Math.round(mean(rows.map((r) => (1 - 1 / r.n) ** 2 + (r.n - 1) * (1 / r.n) ** 2)) * 10000) / 10000,
  };
  const out = { summary, venues: rows };
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`market calibration — ${rows.length} resolved venues with books, vs what Run.correct landed`);
  console.log(`  favorites hit ${summary.favoriteHitRatePct}% · winners carried ${summary.meanImpliedWinnerPct}% implied at close (uniform baseline ${summary.uniformBaselinePct}%)`);
  console.log(`  Brier ${summary.meanBrier} vs uniform ${summary.uniformBrier} — lower is sharper`);
  const miss = rows.filter((r) => !r.favoriteHit).sort((a, b) => b.impliedWinnerPct - a.impliedWinnerPct).slice(0, 8);
  if (miss.length) {
    console.log(`  favorite misses (winner's closing share):`);
    for (const r of miss) console.log(`    ${r.kind.padEnd(6)} ${r.venue.slice(0, 12)}… winner carried ${r.impliedWinnerPct}% across ${r.n} outcome(s)`);
  }
  return out;
}

/** `chain market divergence` — where the money disagrees with the
 *  receipts. Two honest rankings exist: paired evidence (compare --all)
 *  and conviction (stake weighed, market sentiment). Sort both, diff the
 *  positions: a positive gap means the market prices a model ABOVE its
 *  evidence (evidence ranks it worse — overvalued), negative means below
 *  (money underweights the receipts). Models
 *  appearing on only one side are shown — a model the evidence can't
 *  rank but money priced is itself a finding. */
export async function marketDivergence(json = false, snapPath?: string) {
  const origLog = console.log; console.log = () => {};
  let ranked: any, senti: any;
  try {
    [ranked, senti] = await Promise.all([compareAll(true, snapPath), marketSentiment(true, snapPath)]);
  } finally { console.log = origLog; }
  const evRank = new Map<string, { rank: number; wins: number; losses: number; ties: number; shared: number }>();
  (ranked ?? []).forEach((r: any, i: number) => evRank.set(r.modelId, { rank: i + 1, wins: r.wins, losses: r.losses, ties: r.ties, shared: r.sharedBanks }));
  const blRank = new Map<string, { rank: number; win: number | null; score: number | null; stake: string; venues: number }>();
  (senti ?? []).forEach((r: any, i: number) => blRank.set(r.model, { rank: i + 1, win: r.impliedWinPct, score: r.impliedScore, stake: r.stakeWeighed, venues: r.venues }));
  const models = [...new Set([...evRank.keys(), ...blRank.keys()])];
  const rows = models.map((m) => {
    const e = evRank.get(m), b = blRank.get(m);
    return { model: m,
      evidence: e ? { rank: e.rank, wins: e.wins, losses: e.losses, ties: e.ties, sharedBanks: e.shared } : null,
      belief: b ? { rank: b.rank, impliedWinPct: b.win, impliedScore: b.score, stakeWeighed: b.stake, venues: b.venues } : null,
      gap: e && b ? e.rank - b.rank : null };
  }).sort((x, y) => Math.abs(y.gap ?? -1) - Math.abs(x.gap ?? -1));
  if (json) { console.log(JSON.stringify(rows)); return rows; }
  console.log(`market divergence — evidence rank vs conviction rank (+gap = money prices it ABOVE the receipts; − = below)`);
  for (const r of rows) {
    const e = r.evidence ? `#${r.evidence.rank} (${r.evidence.wins}W-${r.evidence.losses}L-${r.evidence.ties}T)` : "unranked";
    const b = r.belief ? `#${r.belief.rank} (${r.belief.stakeWeighed})` : "unpriced";
    const g = r.gap === null ? "  — " : (r.gap > 0 ? `+${r.gap}` : `${r.gap}`).padStart(4);
    console.log(`  ${r.model.padEnd(28)} evidence ${e.padEnd(22)} conviction ${b.padEnd(22)} gap ${g}`);
  }
  console.log(`a model with no shared-bank evidence is unranked; a model with no funded book is unpriced — both absences are signal`);
  return rows;
}

/** `chain market champions` — the SETTLEMENT record, per model.
 *  Registry ranks by score receipts, sentiment by belief, compare by
 *  paired evidence — this ranks by what money actually resolved on:
 *  duel W-D-L, ladder leg wins (dead-heat masks count each co-winner),
 *  bounty claims. A model's champion record is the one opinion it
 *  can't argue with — someone paid to be wrong about it. */
export async function marketChampions(json = false, snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const mAcct = () => (marketProgram().market.account as any);
  type Acct = { publicKey: PublicKey; account: any };
  const [markets, ladders, bounties]: Acct[][] =
    sm ? ["Market", "Ladder", "Bounty"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "ladder", "bounty"].map((n) => (mAcct() as any)[n].all()));
  const runs: Acct[] = ss ? snapOf(ss, "Run") : await (sealedProgram().program.account as any).run.all();
  const model = new Map(runs.map((r) => [r.publicKey.toBase58(), String(r.account.modelId)]));

  type Row = { duels: [number, number, number]; ladderWins: number; ladderEntries: number; bounties: number };
  const acc = new Map<string, Row>();
  const row = (m?: string) => { if (!m) return null; if (!acc.has(m)) acc.set(m, { duels: [0, 0, 0], ladderWins: 0, ladderEntries: 0, bounties: 0 }); return acc.get(m)!; };

  for (const m of markets) {
    const M = m.account as any;
    if (Number(M.status) !== 1) continue;
    const duel = M.runB && !(M.runB as PublicKey).equals(PublicKey.default);
    if (!duel) continue;
    const a = model.get((M.run as PublicKey).toBase58()), b = model.get((M.runB as PublicKey).toBase58());
    const o = Number(M.outcome);
    if (o === 0) { if (row(a)) row(a)!.duels[0]++; if (row(b)) row(b)!.duels[2]++; }
    else if (o === 1) { if (row(b)) row(b)!.duels[0]++; if (row(a)) row(a)!.duels[2]++; }
    else { if (row(a)) row(a)!.duels[1]++; if (row(b)) row(b)!.duels[1]++; }
  }
  for (const l of ladders) {
    const L = l.account as any;
    if (Number(L.status) !== 1) continue;
    const n = Number(L.legCount), mask = Number(L.resultMask);
    for (let i = 0; i < n; i++) {
      const r = row(model.get((L.legs as PublicKey[])[i].toBase58()));
      if (!r) continue;
      r.ladderEntries++;
      if ((mask >> i) & 1) r.ladderWins++;
    }
  }
  for (const b of bounties) {
    const B = b.account as any;
    if (Number(B.status) !== 1) continue;
    const r = row(model.get((B.winnerRun as PublicKey).toBase58()));
    if (r) r.bounties++;
  }
  const rows = [...acc.entries()].map(([m, r]) => {
    const decided = r.duels[0] + r.duels[2];
    return { model: m, duelW: r.duels[0], duelD: r.duels[1], duelL: r.duels[2],
      duelWinPct: decided ? Math.round((r.duels[0] / decided) * 10000) / 100 : null,
      ladderWins: r.ladderWins, ladderEntries: r.ladderEntries,
      ladderWinPct: r.ladderEntries ? Math.round((r.ladderWins / r.ladderEntries) * 10000) / 100 : null,
      bounties: r.bounties,
      venues: decided + r.duels[1] + r.ladderEntries + r.bounties };
  }).sort((a, b) => (b.duelW * 3 + b.ladderWins + b.bounties * 2) - (a.duelW * 3 + a.ladderWins + a.bounties * 2));
  if (json) { console.log(JSON.stringify(rows)); return rows; }
  console.log(`market champions — the settlement record (${rows.length} model(s) with resolved venues)`);
  for (const r of rows)
    console.log(`  ${r.model.padEnd(28)} duels ${r.duelW}W-${r.duelD}D-${r.duelL}L${r.duelWinPct !== null ? ` (${r.duelWinPct}%)` : ""} · legs ${r.ladderWins}/${r.ladderEntries}${r.ladderWinPct !== null ? ` (${r.ladderWinPct}%)` : ""} · bounties ${r.bounties}`);
  return rows;
}

/** `chain wallet <pk> [--json]` — the actor dossier: everything one
 *  address did across both programs — banks it authors, runs it
 *  submitted, receipts it recorded, venues it created or sponsors,
 *  positions it holds, and reshare grants addressed to it. `bank` is
 *  the subject view, `market venue` the instrument view, `wallet` the
 *  actor view — the audit triangle closes. */
export async function walletShow(pkStr: string, json = false, snapPath?: string) {
  const pk = new PublicKey(pkStr);
  const me = pk.toBase58();
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sAcct = () => sealedProgram().program;
  const mAcct = () => marketProgram().market;
  type Acct = { publicKey: PublicKey; account: any };
  const [banks, runs, logs, grants]: Acct[][] =
    ss ? ["Benchmark", "Run", "ScoreLog", "ShareGrant"].map((n) => snapOf(ss, n))
       : await Promise.all(["benchmark", "run", "scoreLog", "shareGrant"].map((n) => tolerantAll(sAcct(), n)));
  const [markets, darks, ladders, bounties, positions, darkPositions]: Acct[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty", "Position", "DarkPosition"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty", "position", "darkPosition"].map((n) => tolerantAll(mAcct(), n)));
  const pkOf = (v: any): string => (v?.toBase58 ? v.toBase58() : typeof v === "string" ? v : Buffer.from(v ?? []).toString("hex"));
  const isMe = (v: any) => pkOf(v) === me;
  const bankName = new Map(banks.map((b) => [b.publicKey.toBase58(), b.account.name as string]));

  const myBanks = banks.filter((b) => isMe(b.account.authority));
  const myRuns = runs.filter((r) => isMe(r.account.runner));
  const myReceipts = logs.filter((l) => isMe(l.account.recordedBy));
  const myGrants = grants.filter((g) => isMe(g.account.viewer));
  const myMarkets = markets.filter((m) => isMe(m.account.authority));
  const myDarks = darks.filter((d) => isMe(d.account.authority));
  const myLadders = ladders.filter((l) => isMe(l.account.authority));
  const myBounties = bounties.filter((b) => isMe(b.account.sponsor));
  const myPositions = positions.filter((p) => isMe(p.account.bettor));
  const myDarkPositions = darkPositions.filter((p) => isMe(p.account.bettor));

  const fin = myRuns.filter((r) => r.account.status === 1);
  const wagered = myPositions.reduce((s, p) => s + (p.account.amounts as any[]).reduce((a: number, b: any) => a + Number(b), 0), 0)
    + myDarkPositions.reduce((s, p) => s + Number(p.account.amount ?? 0), 0);
  const escrowed = myBounties.filter((b) => b.account.status === 0).reduce((s, b) => s + Number(b.account.amount), 0);
  // actor P&L — the same payout classification positions/position use,
  // summed by state: what this wallet is owed, lost, forfeited, refunded.
  const { rows: pnlRows } = classifyPositions(myPositions, myDarkPositions, venueMapsOf(markets, ladders, darks), me);
  const pnl = { payable: 0n, refund: 0n, lost: 0n, forfeit: 0n, live: 0n, sealed: 0n };
  let pnlEst = 0n;
  for (const r of pnlRows) {
    if (r.state === "payable") { pnl.payable += r.staked; pnlEst += r.est; }
    else if (r.state === "refund") { pnl.refund += r.staked; pnlEst += r.est; }
    else if (r.state === "lost") pnl.lost += r.staked;
    else if (r.state === "forfeit") pnl.forfeit += r.staked;
    else if (r.state === "sealed") pnl.sealed += r.staked;
    else pnl.live += r.staked;
  }
  // runner-side income: claimed bounties whose winning run this key operated.
  // (claim zeroes Bounty.amount — the paid pot lives in the BountyClaimed
  // event, not account state — so we report wins, not lamports.)
  const runByPk = new Map(runs.map((r) => [r.publicKey.toBase58(), r]));
  const myWins = bounties.filter((b) => {
    if (Number(b.account.status) !== 1) return false;
    const wr = runByPk.get(pkOf(b.account.winnerRun));
    return wr ? isMe(wr.account.runner) : false;
  });

  const out = {
    wallet: me,
    banksAuthored: myBanks.map((b) => ({ pk: b.publicKey.toBase58(), name: b.account.name, kind: BANK_KIND[b.account.kind as number] })),
    runs: { total: myRuns.length, finalized: fin.length, postReveal: myRuns.filter((r) => r.account.postReveal).length,
      recent: myRuns.slice().sort((a, b) => Number(b.account.createdAt) - Number(a.account.createdAt)).slice(0, 10)
        .map((r) => ({ pk: r.publicKey.toBase58(), modelId: r.account.modelId, score: `${r.account.correct}/${Number(r.account.chunkCount) * 32}`,
          bank: bankName.get((r.account.benchmark as PublicKey).toBase58()) ?? "?", status: r.account.status })) },
    receiptsRecorded: myReceipts.length,
    venuesCreated: myMarkets.length + myDarks.length + myLadders.length,
    bountiesSponsored: { total: myBounties.length, openLamports: escrowed },
    bountiesWon: { total: myWins.length,
      wins: myWins.map((b) => ({ pk: b.publicKey.toBase58(), threshold: Number(b.account.threshold),
        winningScore: Number(b.account.winningScore), bank: bankName.get((b.account.bank as PublicKey).toBase58()) ?? "?" })) },
    positions: { count: myPositions.length + myDarkPositions.length, wageredLamports: wagered,
      pnl: { payable: pnl.payable.toString(), payableEst: pnlEst.toString(), refund: pnl.refund.toString(),
        lost: pnl.lost.toString(), forfeit: pnl.forfeit.toString(), live: pnl.live.toString(), sealed: pnl.sealed.toString() } },
    grantsHeld: myGrants.map((g) => ({ pk: g.publicKey.toBase58(), bank: bankName.get((g.account.benchmark as PublicKey).toBase58()) ?? "?", part: g.account.part, sharedAt: Number(g.account.sharedAt) })),
  };
  if (json) { console.log(JSON.stringify(out)); return out; }
  const sol = (x: number) => (x / 1e9).toFixed(4);
  console.log(`wallet ${me}`);
  if (myBanks.length) for (const b of out.banksAuthored) console.log(`  bank — ${b.pk} "${b.name}" (${b.kind})`);
  if (myRuns.length) {
    console.log(`  runs — ${out.runs.total} submitted · ${out.runs.finalized} finalized · ${out.runs.postReveal} post-reveal`);
    for (const r of out.runs.recent) console.log(`    ${r.pk.slice(0, 12)}… ${r.modelId} → ${r.score} on ${r.bank} (status ${r.status})`);
  }
  if (out.receiptsRecorded) console.log(`  receipts — ${out.receiptsRecorded} recorded by this key`);
  if (out.venuesCreated) console.log(`  venues — ${myMarkets.length} band/duel · ${myDarks.length} dark · ${myLadders.length} ladder created`);
  if (out.bountiesSponsored.total) console.log(`  bounties — ${out.bountiesSponsored.total} sponsored · ${sol(out.bountiesSponsored.openLamports)}◎ still escrowed`);
  if (out.bountiesWon.total) {
    console.log(`  bounties won — ${out.bountiesWon.total} claimed by this key's runs (pot paid to runner at claim)`);
    for (const w of out.bountiesWon.wins) console.log(`    ${w.pk.slice(0, 12)}… score ${w.winningScore} ≥ ${w.threshold} on ${w.bank}`);
  }
  if (out.positions.count) {
    console.log(`  positions — ${out.positions.count} held · ${sol(out.positions.wageredLamports)}◎ wagered`);
    const P = out.positions.pnl, f = (x: string) => sol(Number(x));
    const parts = [
      BigInt(P.payable) > 0n || BigInt(P.payableEst) > 0n ? `${f(P.payableEst)}◎ payable` : "",
      BigInt(P.refund) > 0n ? `${f(P.refund)}◎ refundable` : "",
      BigInt(P.lost) > 0n ? `${f(P.lost)}◎ lost` : "",
      BigInt(P.forfeit) > 0n ? `${f(P.forfeit)}◎ forfeited` : "",
      BigInt(P.sealed) > 0n ? `${f(P.sealed)}◎ sealed` : "",
      BigInt(P.live) > 0n ? `${f(P.live)}◎ live` : "",
    ].filter(Boolean).join(" · ");
    if (parts) console.log(`    P&L — ${parts}`);
  }
  if (out.grantsHeld.length) for (const g of out.grantsHeld)
    console.log(`  grant — ${g.pk.slice(0, 12)}… ${g.bank} part ${g.part} shared ${new Date(g.sharedAt * 1000).toISOString().slice(0, 16).replace("T", " ")}`);
  if (!myBanks.length && !myRuns.length && !myReceipts.length && !out.venuesCreated &&
      !out.bountiesSponsored.total && !out.bountiesWon.total && !out.positions.count && !out.grantsHeld.length)
    console.log(`  no footprint — this key authored no banks, runs, venues, positions, or grants`);
  console.log(`  permalink — https://josepha-mayo.github.io/sealed/?pk=${me}`);
  return out;
}

/** `chain tour` — the project demos itself: one command walks the
 *  whole evidence story on the RICHEST objects in the ledger (not
 *  hardcoded pks — they're picked live): headline stats → search →
 *  a run's custody trail → its filtered feed → a venue's book → an
 *  actor's P&L → the portable digest. replay.txt made executable. */
export async function chainTour(snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sAcct = () => sealedProgram().program;
  const mAcct = () => marketProgram().market;
  type Acct = { publicKey: PublicKey; account: any };
  const [runs, logs, banks]: Acct[][] =
    ss ? ["Run", "ScoreLog", "Benchmark"].map((n) => snapOf(ss, n))
       : await Promise.all(["run", "scoreLog", "benchmark"].map((n) => tolerantAll(sAcct(), n)));
  const [markets, positions]: Acct[][] =
    sm ? ["Market", "Position"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "position"].map((n) => tolerantAll(mAcct(), n)));

  // pick the richest exhibits: the run touched by the most venues,
  // the venue with the biggest book, the bettor with the most positions.
  const venueRuns = new Map<string, number>();
  for (const m of markets) {
    const a = (m.account.run as PublicKey)?.toBase58?.();
    if (a) venueRuns.set(a, (venueRuns.get(a) ?? 0) + 1);
    const b = (m.account.runB as PublicKey)?.toBase58?.();
    if (b && b !== PublicKey.default.toBase58()) venueRuns.set(b, (venueRuns.get(b) ?? 0) + 1);
  }
  const tourRun = [...venueRuns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? runs.find((r) => Number(r.account.status) === 1)?.publicKey.toBase58();
  const bookSize = new Map<string, number>();
  for (const p of positions) {
    const v = (p.account.market as PublicKey)?.toBase58?.();
    if (v) bookSize.set(v, (bookSize.get(v) ?? 0) + 1);
  }
  const tourVenue = [...bookSize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? markets[0]?.publicKey.toBase58();
  const tourWallet = positions.find((p) => (p.account.market as PublicKey)?.toBase58?.() === tourVenue)
    ?.account.bettor?.toBase58?.() ?? null;
  const tourBank = banks[0]?.publicKey.toBase58();

  const H = (s: string) => console.log(`\n════ ${s} ${"═".repeat(Math.max(0, 72 - s.length))}`);
  console.log(`sealed tour — the ledger narrates itself (${snapPath ? "offline replay" : "live"})`);

  H("1/7 · the whole system in one table — chain stats");
  await chainStats(snapPath);

  if (tourBank) {
    H(`2/7 · what is this key? — chain search ${tourBank.slice(0, 8)}…`);
    await chainSearch(tourBank, false, snapPath);
  }
  if (tourRun) {
    H(`3/7 · one run's custody chain — chain trail ${tourRun.slice(0, 8)}… (${venueRuns.get(tourRun) ?? 0} venue(s) priced it)`);
    await chainTrail(tourRun, false, snapPath);
    H(`4/7 · its chronology — chain feed --pk ${tourRun.slice(0, 8)}…`);
    await chainFeed(10, undefined, 0, false, snapPath, tourRun);
  }
  if (tourVenue) {
    H(`5/7 · the instrument's book — chain market venue ${tourVenue.slice(0, 8)}… (${bookSize.get(tourVenue) ?? 0} position(s))`);
    await marketVenue(tourVenue, false, snapPath);
  }
  if (tourWallet) {
    H(`6/7 · an actor's P&L — chain wallet ${tourWallet.slice(0, 8)}…`);
    await walletShow(tourWallet, false, snapPath);
  }
  H(`7/7 · what the money learned — and where it disagrees`);
  await marketSentiment(false, snapPath);
  {
    const origLog = console.log; console.log = () => {};
    let dRows: any;
    try { dRows = await marketDivergence(true, snapPath); } finally { console.log = origLog; }
    const top = (dRows ?? []).filter((r: any) => r.gap !== null && r.gap !== 0).slice(0, 3);
    if (top.length) {
      console.log(`\n  the disagreements (chain market divergence):`);
      for (const r of top)
        console.log(`    ${r.model.padEnd(28)} evidence #${r.evidence.rank} vs conviction #${r.belief.rank} — priced ${r.gap > 0 ? "ABOVE" : "below"} its receipts by ${Math.abs(r.gap)} place(s)`);
    }
  }
  {
    const origLog = console.log; console.log = () => {};
    let anoms: any;
    try { anoms = await chainAnomalies(true, snapPath); } finally { console.log = origLog; }
    if (anoms) {
      console.log(`\n  and because evidence you can't attack isn't evidence — chain anomalies:`);
      for (const x of anoms.findings.filter((f: any) => f.sev !== "ok").slice(0, 4))
        console.log(`    [${x.sev}] ${x.what} — ${x.count ? x.count : "none"} · drill → ${x.drill}`);
      console.log(`    ${anoms.clean} of ${anoms.findings.length} hostile checks come back clean`);
    }
  }
  console.log(`\nportable artifacts — what you hand a consumer:`);
  console.log(`      sealed chain prove <model> --out c.json     → claim card (verify: --verify c.json [--min-pct N])`);
  console.log(`      sealed chain report <model>                 → sealed-report/v1 printable document`);
  console.log(`      sealed chain gate --all <policy> --cert p.json → sealed-policy/v1 governance certificate`);
  console.log(`      sealed chain artifact docs/evidence --recursive → replay ALL 138 committed artifacts in one pass`);
  console.log(`      sealed chain artifact <file> --tamper       → try to break it — forge the card, watch the named check kill it`);
  console.log(`      sealed chain fingerprint                    → the whole evidence base as ONE sha256`);
  console.log(`      sealed chain export --snapshot <file>       → the portable digest · diff <a> <b> reproducibility`);
  console.log(`      https://josepha-mayo.github.io/sealed/?pk=<key>  → every one of these verifiable in the browser`);
}

/** `chain search <pk>` — the universal resolver (CLI mirror of the
 *  explorer's `?pk=` box): identify WHAT a pubkey is across every
 *  account type in both programs, then route to the dossier command
 *  that answers questions about it. Falls back to the wallet dossier
 *  when the key isn't an account but signs activity (an actor). */
export async function chainSearch(pkStr: string, json = false, snapPath?: string) {
  let pk: PublicKey;
  try { pk = new PublicKey(pkStr); }
  catch {
    // not a pubkey — try the names the explorer's resolver accepts:
    // a model id resolves through its deterministic record PDA.
    const [rec] = PublicKey.findProgramAddressSync(
      [Buffer.from("modelrec"), createHash("sha256").update(Buffer.from(pkStr, "utf8")).digest()], sealedProgramId());
    const snap = snapPath ? loadSnapshotJson(snapPath) : null;
    const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
    const hits: { type: string; desc: string; cmd: string }[] = [];
    const recHit = ss
      ? snapOf(ss, "ModelRecord").some((x) => x.publicKey.equals(rec))
      : await (sealedProgram().program.account as any).modelRecord.fetchNullable(rec).then((a: any) => !!a).catch(() => false);
    if (recHit) hits.push({ type: "model-id", desc: `model id "${pkStr}" → its capability record ${rec.toBase58()}`, cmd: `sealed chain model ${pkStr}` });
    const bnHits = ss
      ? snapOf(ss, "Benchmark").filter((b) => b.account.name === pkStr)
      : await (sealedProgram().program.account as any).benchmark.all().then((a: any[]) => a.filter((x) => x.account.name === pkStr)).catch(() => []);
    for (const b of bnHits) hits.push({ type: "bank-name", desc: `bank "${pkStr}" → ${b.publicKey.toBase58()}`, cmd: `sealed chain bank ${b.publicKey.toBase58()}` });
    if (hits.length) {
      if (json) console.log(JSON.stringify(hits)); else for (const o of hits) console.log(`${o.type} — ${o.desc}\n  → ${o.cmd}`);
      return hits;
    }
    console.log(`not a pubkey, model id, or bank name: ${pkStr}`); process.exitCode = 2; return null;
  }
  let sealed: Map<string, SnapAccount[]> | null;
  let mkt: Map<string, SnapAccount[]> | null;
  if (snapPath) {
    const snap = loadSnapshotJson(snapPath);
    sealed = decodeSnapshotSection(snap, "sealed");
    mkt = decodeSnapshotSection(snap, "market");
  } else {
    sealed = new Map(); mkt = new Map();
    const sAcct = () => (sealedProgram().program as any);
    const mAcct = () => marketProgram().market;
    for (const [camel, name] of [["benchmark", "Benchmark"], ["run", "Run"], ["scoreLog", "ScoreLog"], ["modelRecord", "ModelRecord"], ["reveal", "Reveal"], ["shareGrant", "ShareGrant"], ["itemChunk", "ItemChunk"], ["privItemChunk", "PrivItemChunk"]] as const)
      sealed.set(name, await tolerantAll(sAcct(), camel));
    for (const [camel, name] of [["market", "Market"], ["darkMarket", "DarkMarket"], ["ladder", "Ladder"], ["bounty", "Bounty"], ["position", "Position"], ["darkPosition", "DarkPosition"]] as const)
      mkt.set(name, await tolerantAll(mAcct(), camel));
  }
  const find = (name: string) =>
    (sealed?.get(name) ?? mkt?.get(name) ?? []).find((x: SnapAccount) => x.publicKey.equals(pk));
  const b58of = (v: any) => v?.toBase58 ? v.toBase58() : typeof v === "string" ? v : new PublicKey(Buffer.from(v ?? [])).toBase58();
  type Hit = { type: string; desc: string; cmd: string };
  const hits: Hit[] = [];
  const b = find("Benchmark");
  if (b) hits.push({ type: "benchmark", desc: `bank "${b.account.name}" — ${b.account.chunkCount} chunk(s), ${b.account.runCount} run(s), ${b.account.status === 0 ? "open" : "sealed"}`, cmd: `sealed chain bank ${pkStr}` });
  const r = find("Run");
  if (r) hits.push({ type: "run", desc: `run — model ${r.account.modelId ?? r.account.model_id ?? "?"}`, cmd: `sealed chain trail ${pkStr}` });
  const sl = find("ScoreLog");
  if (sl) hits.push({ type: "score-receipt", desc: `ScoreLog receipt — ${sl.account.correct}/${sl.account.items}`, cmd: `sealed chain trail ${b58of(sl.account.run)}` });
  const mr = find("ModelRecord");
  if (mr) hits.push({ type: "model-record", desc: `capability record — ${mr.account.totalCorrect}/${mr.account.totalItems} aggregate`, cmd: `sealed chain modelrec ${pkStr}` });
  const rv = find("Reveal");
  if (rv) hits.push({ type: "reveal", desc: `fingerprint reveal on bank ${b58of(rv.account.benchmark).slice(0, 8)}…`, cmd: `sealed chain reveals --benchmark ${b58of(rv.account.benchmark)}` });
  const sg = find("ShareGrant");
  if (sg) hits.push({ type: "share-grant", desc: `reshare grant → ${b58of(sg.account.viewer).slice(0, 8)}…`, cmd: `sealed chain grants --benchmark ${b58of(sg.account.benchmark)}` });
  const ic = find("ItemChunk") ?? find("PrivItemChunk");
  if (ic) hits.push({ type: "item-chunk", desc: `chunk ${ic.account.index ?? "?"} of bank ${b58of(ic.account.benchmark).slice(0, 8)}…`, cmd: `sealed chain bank ${b58of(ic.account.benchmark)}` });
  const m = find("Market") ?? find("Ladder") ?? find("DarkMarket") ?? find("Bounty");
  if (m) hits.push({ type: "venue", desc: `${find("Market") ? "band/duel market" : find("Ladder") ? "ladder race" : find("DarkMarket") ? "dark market" : "capability bounty"} — status ${m.account.status}`, cmd: `sealed chain market venue ${pkStr}` });
  const p = find("Position") ?? find("DarkPosition");
  if (p) hits.push({ type: "position", desc: `stake by ${b58of(p.account.bettor).slice(0, 8)}… on venue ${b58of(p.account.market).slice(0, 8)}…`, cmd: `sealed chain market position ${pkStr}` });
  // actor fallback — the key signs activity even if it isn't an account
  let actor = 0;
  if (hits.length === 0 && (sealed || mkt)) {
    const seen = (x: any) => x?.toBase58?.() === pkStr;
    const scan = (map: Map<string, SnapAccount[]> | null, name: string, fields: string[]) => {
      for (const x of map?.get(name) ?? [])
        for (const f of fields) if (seen((x.account as any)[f])) actor++;
    };
    scan(sealed, "Benchmark", ["authority"]);
    scan(sealed, "Run", ["runner", "authority"]);
    scan(mkt, "Position", ["bettor"]);
    scan(mkt, "DarkPosition", ["bettor"]);
    scan(mkt, "Bounty", ["sponsor", "winnerRunner"]);
    scan(mkt, "Market", ["authority"]);
    scan(mkt, "Ladder", ["authority"]);
    scan(mkt, "DarkMarket", ["authority"]);
    scan(sealed, "ShareGrant", ["viewer"]);
    if (actor) hits.push({ type: "actor", desc: `wallet — signs ${actor} account(s)`, cmd: `sealed chain wallet ${pkStr}` });
  }
  if (json) { console.log(JSON.stringify({ pk: pkStr, hits })); return hits; }
  if (!hits.length) { console.log(`search ${pkStr} — no account or actor match`); process.exitCode = 2; return hits; }
  console.log(`search ${pkStr}`);
  for (const h of hits) {
    console.log(`  ${h.type.padEnd(14)} ${h.desc}`);
    console.log(`  ${"".padEnd(14)} → ${h.cmd}`);
  }
  return hits;
}

/** `chain diff <snapshot-a> <snapshot-b> [--json]` — two bundles, one
 *  verdict: per-type account deltas, which pubkeys are new in B, which
 *  vanished, and both sides' integrity verdicts (registry replay +
 *  resolution checks) recomputed. The reproducibility claim made
 *  executable: `snapshot.mjs` a live cluster, diff against the
 *  committed bundle — every committed account must appear intact. */
export async function chainDiff(pathA: string, pathB: string, json = false) {
  const TYPES_S = ["Benchmark", "Run", "ScoreLog", "ModelRecord", "Reveal", "ShareGrant", "ItemChunk", "PrivItemChunk"];
  const TYPES_M = ["Market", "DarkMarket", "Ladder", "Bounty", "Position", "DarkPosition"];
  const dec = (p: string) => {
    const snap = loadSnapshotJson(p);
    return {
      snap, sha256: createHash("sha256").update(readFileSync(p)).digest("hex"),
      ss: decodeSnapshotSection(snap, "sealed"), sm: decodeSnapshotSection(snap, "market"),
    };
  };
  const A = dec(pathA), B = dec(pathB);
  const rows: any[] = [];
  let added = 0, removed = 0, mutatedCount = 0;
  for (const [sec, types] of [["sealed", TYPES_S], ["market", TYPES_M]] as const) {
    for (const t of types) {
      const aM = new Map(snapOf(sec === "sealed" ? A.ss : A.sm, t).map((x) => [x.publicKey.toBase58(), x]));
      const bM = new Map(snapOf(sec === "sealed" ? B.ss : B.sm, t).map((x) => [x.publicKey.toBase58(), x]));
      const addedPks = [...bM.keys()].filter((k) => !aM.has(k));
      const removedPks = [...aM.keys()].filter((k) => !bM.has(k));
      // same pubkey, different bytes = a mutated account — the worst kind of diff
      const mutated = [...aM.keys()].filter((k) => bM.has(k))
        .filter((k) => JSON.stringify(aM.get(k)!.account) !== JSON.stringify(bM.get(k)!.account));
      if (!aM.size && !bM.size) continue;
      added += addedPks.length; removed += removedPks.length;
      mutatedCount += mutated.length;
      rows.push({ type: `${sec}.${t}`, a: aM.size, b: bM.size, added: addedPks.length, removed: removedPks.length,
        mutated: mutated.length, addedPks: addedPks.slice(0, 25), removedPks: removedPks.slice(0, 25) });
      if (mutated.length) for (const k of mutated.slice(0, 10))
        console.error(`!! MUTATED account ${t} ${k} — same PDA, different bytes between bundles`);
    }
  }
  const integ = (d: typeof A) => {
    const logs = snapOf(d.ss, "ScoreLog"), records = snapOf(d.ss, "ModelRecord"), runs = snapOf(d.ss, "Run");
    const logsByRec = new Map<string, any[]>();
    for (const l of logs) {
      const k = (l.account.modelRecord as PublicKey).toBase58();
      (logsByRec.get(k) ?? logsByRec.set(k, []).get(k)!).push(l.account);
    }
    return ledgerIntegrity({ records, logsByRec, runs,
      markets: snapOf(d.sm, "Market"), darks: snapOf(d.sm, "DarkMarket"),
      ladders: snapOf(d.sm, "Ladder"), bounties: snapOf(d.sm, "Bounty") });
  };
  const iA = integ(A), iB = integ(B);
  const out = {
    a: { path: pathA, sha256: A.sha256, takenAt: A.snap.meta?.takenAt, integrity: { recordsOk: iA.recOk, recordsBad: iA.recBad, resolutionsOk: iA.resOk, resolutionsBad: iA.resBad } },
    b: { path: pathB, sha256: B.sha256, takenAt: B.snap.meta?.takenAt, integrity: { recordsOk: iB.recOk, recordsBad: iB.recBad, resolutionsOk: iB.resOk, resolutionsBad: iB.resBad } },
    totalAdded: added, totalRemoved: removed, totalMutated: mutatedCount, rows,
  };
  if (json) { console.log(JSON.stringify(out)); if (mutatedCount || iA.recBad || iA.resBad || iB.recBad || iB.resBad) process.exitCode = 1; return out; }
  console.log(`diff ${pathA} → ${pathB}`);
  console.log(`  A — sha256 ${A.sha256.slice(0, 16)}… · taken ${A.snap.meta?.takenAt ?? "?"} · integrity ${iA.recOk}/${iA.recOk + iA.recBad} records, ${iA.resOk}/${iA.resOk + iA.resBad} resolutions`);
  console.log(`  B — sha256 ${B.sha256.slice(0, 16)}… · taken ${B.snap.meta?.takenAt ?? "?"} · integrity ${iB.recOk}/${iB.recOk + iB.recBad} records, ${iB.resOk}/${iB.resOk + iB.resBad} resolutions`);
  console.log(`  delta — +${added} accounts · -${removed} removed`);
  for (const r of rows) {
    if (!r.added && !r.removed && !r.mutated) continue;
    console.log(`    ${r.type.padEnd(20)} ${r.a} → ${r.b}  (+${r.added} -${r.removed}${r.mutated ? ` !!${r.mutated} MUTATED` : ""})`);
  }
  if (mutatedCount || iA.recBad || iA.resBad || iB.recBad || iB.resBad) process.exitCode = 1;
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
      venuesPriced: (() => {
        const pkS = (v: any) => v?.toBase58 ? v.toBase58() : String(v);
        const venuePks = new Set([...markets, ...darks, ...ladders].map((v) => v.publicKey.toBase58()));
        const touched = new Set([...positions, ...darkPositions].map((p) => pkS(p.account.market)));
        return [...touched].filter((t) => venuePks.has(t)).length;
      })(),
      venues: markets.length + darks.length + ladders.length + bounties.length,
      markets: markets.length, darks: darks.length, ladders: ladders.length, bounties: bounties.length,
      positions: positions.length + darkPositions.length,
    },
    money: {
      escrowLamports: escrow, venueFeesAccruedLamports: fees,
      bankFeesChargedLamports: sum(banks, (b) => lam(b.feeLamports) * Number(b.runCount)),
      feeBearingBanks: banks.filter((b) => lam((b.account as any).feeLamports) > 0).length,
      feeBearingRuns: banks.filter((b) => lam((b.account as any).feeLamports) > 0)
        .reduce((s, b) => s + Number((b.account as any).runCount), 0),
      bountyOpenLamports: sum(bounties, (b) => (Number(b.status) === 1 ? 0 : lam(b.amount))),
      bountiesClaimed: bounties.filter((b) => Number((b.account as any).status) === 1).length,
    },
    integrity: {
      registryReplay: `${recOk}/${records.length} bit-exact${recBad ? ` (${recBad} VIOLATIONS)` : ""}`,
      resolutionsVerified: `${resOk}/${resOk + resBad} match Run.correct${resBad ? ` (${resBad} MISMATCHES)` : ""}`,
      vouchedReceipts: `${vouched}/${logs.length}`,
      postRevealReceipts: postRev,
    },
    mpcLatency: { samples: lats.length, p50s: pct(50), p95s: pct(95) },
    actors: (() => {
      const pkS = (v: any) => v?.toBase58 ? v.toBase58() : String(v);
      return {
        runners: new Set(runs.map((r) => pkS(r.account.runner))).size,
        bettors: new Set([...positions, ...darkPositions].map((p) => pkS(p.account.bettor))).size,
        darkBettors: new Set(darkPositions.map((p) => pkS(p.account.bettor))).size,
        sponsors: new Set(bounties.map((b) => pkS(b.account.sponsor))).size,
        viewers: new Set(grants.map((g) => pkS(g.account.viewer))).size,
      };
    })(),
    keeper: (await loadBoard(snapPath)).board,
    activity: (() => {
      // the ledger's heartbeat — every timestamped event bucketed per UTC
      // day. Same timestamps chainFeed orders by; the dashboard shows the
      // whole history's shape at a glance.
      const days = new Map<string, number>();
      const bump = (t: any) => { const n = Number(t ?? 0); if (n > 0) { const d = new Date(n * 1000).toISOString().slice(0, 10); days.set(d, (days.get(d) ?? 0) + 1); } };
      for (const b of banks) bump(b.account.createdAt);
      for (const r of runs) { bump(r.account.createdAt); bump(r.account.finalizedAt); }
      for (const l of logs) bump(l.account.recordedAt);
      for (const rv of reveals) bump(rv.account.revealedAt);
      for (const g of grants) bump(g.account.sharedAt);
      for (const m of markets) { bump(m.account.createdAt); bump(m.account.resolvedAt); }
      for (const d of darks) { bump(d.account.createdAt); bump(d.account.resolvedAt); }
      for (const l of ladders) { bump(l.account.createdAt); bump(l.account.resolvedAt); }
      for (const b of bounties) bump(b.account.createdAt);
      const keys = [...days.keys()].sort();
      const TICKS = "▁▂▃▄▅▆▇█";
      const max = Math.max(1, ...days.values());
      const spark = keys.map((k) => TICKS[Math.min(7, Math.floor((days.get(k)! / max) * 7.999))]);
      return { days: keys.length, first: keys[0] ?? null, last: keys.at(-1) ?? null,
        peak: max, total: [...days.values()].reduce((s, x) => s + x, 0), spark: spark.join(""), perDay: keys.map((k) => [k, days.get(k)]) };
    })(),
    discrimination: (() => {
      // which exams separate models — per-bank score spread (pct of
      // capacity), on banks with enough finalized runs to mean anything.
      const byBank = new Map<string, { name: string; pcts: number[] }>();
      const bName = new Map(banks.map((b) => [b.publicKey.toBase58(), String(b.account.name)]));
      for (const r of fin) {
        const k = (r.account.benchmark as PublicKey).toBase58();
        const e = byBank.get(k) ?? { name: bName.get(k) ?? k.slice(0, 8), pcts: [] };
        e.pcts.push((100 * Number(r.account.correct)) / Math.max(1, Number(r.account.chunkCount) * 32));
        byBank.set(k, e);
      }
      const rows = [...byBank.entries()].filter(([, v]) => v.pcts.length >= 4)
        .map(([pk, v]) => { const s = v.pcts.slice().sort((a, b) => a - b);
          return { pk, name: v.name, runs: s.length, spread: +(s[s.length - 1] - s[0]).toFixed(1), median: +s[Math.floor((s.length - 1) / 2)].toFixed(1) }; })
        .sort((a, b) => b.spread - a.spread);
      return { banksMeasured: rows.length, medianSpreadPp: rows.length ? rows[Math.floor(rows.length / 2)].spread : 0, top: rows.slice(0, 3), hardest: rows.length ? rows.reduce((a, b) => (b.median < a.median ? b : a)) : null,
        dead: banks.length - new Set(runs.map((r) => (r.account.benchmark as PublicKey).toBase58())).size };
    })(),
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
    ` · ${out.ledger.positions} positions (${Math.round(100 * out.ledger.venuesPriced / Math.max(1, out.ledger.markets + out.ledger.darks + out.ledger.ladders))}% venue fill)`);
  console.log(`registry — ${out.ledger.records} records · ${out.ledger.receipts} receipts (${out.integrity.vouchedReceipts} vouched, ${postRev} post-reveal)`);
  console.log(`disclosure — ${out.ledger.reveals} reveals · ${out.ledger.grants} reshare grants · ${out.ledger.itemChunks}+${out.ledger.privChunks} item chunks`);
  const MN = out.money;
  console.log(`money — ${(MN.escrowLamports / 1e9).toFixed(3)}◎ escrowed · ${(MN.venueFeesAccruedLamports / 1e9).toFixed(4)}◎ venue fees accrued` +
    ` · ${(MN.bankFeesChargedLamports / 1e9).toFixed(4)}◎ bank run-fees charged (${MN.feeBearingRuns} paid runs across ${MN.feeBearingBanks} fee-bearing bank${MN.feeBearingBanks === 1 ? "" : "s"})` +
    ` · ${MN.bountiesClaimed} bounties claimed + ${(MN.bountyOpenLamports / 1e9).toFixed(3)}◎ still escrowed`);
  console.log(`integrity — registry ${out.integrity.registryReplay} · resolutions ${out.integrity.resolutionsVerified}`);
  console.log(`mpc — scoring latency p50 ${out.mpcLatency.p50s}s / p95 ${out.mpcLatency.p95s}s (${lats.length} timed runs)`);
  const A0 = out.actors;
  console.log(`actors — ${A0.runners} runner wallets · ${A0.bettors} bettor wallets (${A0.darkBettors} sealed) · ${A0.sponsors} bounty sponsors · ${A0.viewers} grant viewers`);
  console.log(`keeper — ${actionable} actionable now · ${out.keeper.settled} settled · ${out.keeper.filling} in play`);
  const A = out.activity;
  console.log(`activity — ${A.spark} (${A.total} events over ${A.days} day(s), ${A.first} → ${A.last} · peak ${A.peak}/day)`);
  const D = out.discrimination;
  if (D.banksMeasured) {
    console.log(`exams — ${D.banksMeasured} bank(s) with ≥4 models run · median spread ${D.medianSpreadPp}pp` +
      (D.dead ? ` · ${D.dead} sealed bank(s) never raced` : "") +
      (D.hardest ? ` · hardest ${D.hardest.name} (median ${D.hardest.median}%)` : ""));
    for (const t of D.top.slice(0, 1)) console.log(`  most discriminating — ${t.name}: ${t.spread}pp spread over ${t.runs} runs (chain bank ${t.pk.slice(0, 8)}…)`);
  }
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
/** Shared digest builder — `chain export` emits it, `export --verify`
 *  and the universal artifact router recompute it for field-equality.
 *  Snapshot-mode is the only keyless path (and the only one that can
 *  carry `snapshotSha256`); live mode leaves the hash null. */
async function buildDigestData(snapPath: string | undefined) {
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
  const lam = (x: any) => Number(x ?? 0);
  const sumAcc = (xs: Acct[], f: (a: any) => number) => xs.reduce((s, x) => s + f(x.account), 0);
  const feeBanks = banks.filter((b) => lam(b.account.feeLamports) > 0);
  const money = {
    escrowLamports: sumAcc(markets, (m) => (m.totals as any[]).reduce((s: number, t: any) => s + lam(t), 0))
      + sumAcc(ladders, (l) => (l.totals as any[]).reduce((s: number, t: any) => s + lam(t), 0))
      + sumAcc(darks, (d) => lam(d.poolTotal)) + sumAcc(bounties, (b) => lam(b.amount)),
    venueFeesAccruedLamports: sumAcc(markets, (m) => lam(m.feesAccrued))
      + sumAcc(ladders, (l) => lam(l.feesAccrued)) + sumAcc(darks, (d) => lam(d.feesAccrued)),
    venueFeeBearing: markets.filter((m) => lam(m.account.feeBps) > 0).length
      + ladders.filter((l) => lam(l.account.feeBps) > 0).length
      + darks.filter((d) => lam(d.account.feeBps) > 0).length,
    bankFeesChargedLamports: sumAcc(banks, (b) => lam(b.feeLamports) * Number(b.runCount)),
    feeBearingBanks: feeBanks.length,
    feeBearingRuns: feeBanks.reduce((s, b) => s + Number(b.account.runCount), 0),
    bountyOpenLamports: sumAcc(bounties, (b) => (Number(b.status) === 1 ? 0 : lam(b.amount))),
    bountiesClaimed: bounties.filter((b) => Number(b.account.status) === 1).length,
  };
  const logsByRec = new Map<string, any[]>();
  for (const l of logs) {
    const k = (l.account.modelRecord as PublicKey).toBase58();
    (logsByRec.get(k) ?? logsByRec.set(k, []).get(k)!).push(l.account);
  }
  const integ = ledgerIntegrity({ records, logsByRec, markets, darks, ladders, bounties, runs });
  const { board } = await loadBoard(snapPath);
  const actionable = board.claimable.length + board.resolvable.length + board.resolvableLadders.length +
    board.tallyable.length + board.expirable.length + board.expiredBounties.length;
  return {
    kind: "sealed-evidence-digest/v1",
    snapshotSha256: sha256,
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
    money,
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
}

export async function chainExport(snapPath: string | undefined, out?: string) {
  const data = await buildDigestData(snapPath);
  const digest = {
    ...data,
    generatedAt: new Date().toISOString(),
    source: snapPath ?? "live",
  };
  const integ = data.integrity;
  const text = JSON.stringify(digest, null, 2) + "\n";
  if (out) { writeFileSync(out, text); console.log(`wrote ${out} — ${integ.recordsOk}/${data.records.length} records bit-exact, ${integ.resolutionsOk}/${integ.resolutionsOk + integ.resolutionsBad} resolutions verified, ${data.keeper.actionable} keeper actions`); }
  else console.log(text);
  if (integ.recordsBad || integ.resolutionsBad) process.exitCode = 1;
  return digest;
}

/** `chain export --verify <f>` / `chain artifact <f>` — replay a
 *  `sealed-evidence-digest/v1` against the bundle it claims to describe:
 *  (a) the snapshot file's sha256 must equal the declared
 *  `snapshotSha256` (the digest is bound to THESE bytes), and (b) every
 *  stable field — counts, integrity verdicts and rows, keeper stats,
 *  bank + record ledgers — is recomputed from that snapshot and compared
 *  field-for-field. `generatedAt`/`source` are volatile and excluded. */
export async function digestVerify(file: string, json: boolean, snapPath?: string) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw.kind !== "sealed-evidence-digest/v1") throw new Error("not a sealed-evidence-digest/v1 artifact");
  if (!snapPath) {
    if (raw.snapshotSha256) throw new Error("digest is bound to a snapshot — pass --snapshot <file> to replay it");
    throw new Error("live-source digests need --snapshot to verify against a bundle");
  }
  const lines: string[] = [];
  let bad = 0;
  const note = (ok: boolean, label: string) => { lines.push(`${ok ? "✓" : "✗"} ${label}`); if (!ok) bad++; };

  const sha = createHash("sha256").update(readFileSync(snapPath)).digest("hex");
  note(raw.snapshotSha256 === sha, `snapshot binding — sha256 ${sha.slice(0, 16)}… ${raw.snapshotSha256 === sha ? "matches the digest" : "MISMATCH — this digest describes different bytes"}`);

  const rebuilt = await buildDigestData(snapPath);
  const stable = (d: any) => {
    const { generatedAt: _g, source: _s, ...rest } = d;
    return rest;
  };
  // deep field-equality over every stable key — mismatches are named.
  const diffs: string[] = [];
  const cmp = (path: string, a: any, b: any) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(path);
  };
  for (const k of new Set([...Object.keys(stable(raw)), ...Object.keys(stable(rebuilt))])) {
    cmp(k, stable(raw)[k], (rebuilt as any)[k]);
  }
  note(diffs.length === 0, diffs.length === 0
    ? `fields replayed — counts, integrity (${rebuilt.integrity.recordsOk}+${rebuilt.integrity.recordsBad} records, ${rebuilt.integrity.resolutionsOk}+${rebuilt.integrity.resolutionsBad} resolutions), keeper, ${rebuilt.banks.length} banks, ${rebuilt.records.length} records all identical`
    : `field mismatch: ${diffs.slice(0, 5).join(", ")}${diffs.length > 5 ? ` +${diffs.length - 5} more` : ""}`);
  // integrity verdicts themselves must be clean — a faithfully-replayed
  // digest of a dirty bundle is still a fail.
  note(rebuilt.integrity.recordsBad === 0 && rebuilt.integrity.resolutionsBad === 0,
    `integrity verdicts — ${rebuilt.integrity.recordsOk}/${rebuilt.integrity.recordsOk + rebuilt.integrity.recordsBad} records bit-exact · ${rebuilt.integrity.resolutionsOk}/${rebuilt.integrity.resolutionsOk + rebuilt.integrity.resolutionsBad} resolutions match Run.correct`);

  const ok = bad === 0;
  if (json) console.log(JSON.stringify({ kind: raw.kind, ok, bad, lines }, null, 2));
  else {
    console.log(`sealed-evidence-digest/v1 — ${basename(file)}`);
    for (const l of lines) console.log(`  ${l}`);
    console.log(ok ? "DIGEST VERIFIED" : "DIGEST FAILED");
  }
  if (!ok) process.exitCode = 1;
  return { ok, pass: 3 - bad, fail: bad };
}

/** `chain badge --card <claim.json> [--out f.svg] [--verify]` — the
 *  distribution artifact: a shields-style SVG badge rendered FROM a
 *  `sealed-claim/v1` card, embedding the card's sha256 in its metadata.
 *  The badge is not the proof — it's a pointer to one: anyone who doubts
 *  the number runs `chain prove --verify` on the bound card. Rendering is
 *  deterministic, so `--verify` re-renders from the card and byte-compares:
 *  a badge whose number doesn't match its receipt fails. */
export async function chainBadge(cardPath: string, out?: string, verify = false) {
  const raw = readFileSync(cardPath);
  const card = JSON.parse(raw.toString());
  if (card.kind !== "sealed-claim/v1") throw new Error(`not a sealed-claim/v1 card (kind=${card.kind ?? "?"})`);
  const m = card.model ?? {};
  if (!m.id || m.totalCorrect === undefined || m.totalItems === undefined)
    throw new Error("claim card missing model.id/totalCorrect/totalItems");
  const claimSha = createHash("sha256").update(raw).digest("hex");
  const pct = m.totalItems > 0 ? (100 * m.totalCorrect) / m.totalItems : 0;
  const pctTxt = `${pct.toFixed(1)}%`;
  const color = pct >= 66 ? "#3fb950" : pct >= 33 ? "#9acd32" : pct > 0 ? "#d29922" : "#f85149";
  const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const label = "sealed · mpc-scored";
  const value = `${pctTxt} · ${m.totalCorrect}/${m.totalItems} over ${m.runsScored} run${m.runsScored === 1 ? "" : "s"}`;
  const lw = 8 * (label.length / 2 + 1) + 20, vw = 8 * (value.length / 2 + 1) + 20, tw = lw + vw;
  const meta = escXml(JSON.stringify({ kind: "sealed-badge/v1", model: m.id, recordPk: m.recordPk ?? null, claimSha256: claimSha }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="28" role="img" aria-label="${escXml(`sealed mpc-scored ${pctTxt} for ${m.id}`)}">
<title>${escXml(`${m.id} — ${m.totalCorrect}/${m.totalItems} MPC-scored items across ${m.runsScored} runs (claim sha256 ${claimSha.slice(0, 16)}…)`)}</title>
<metadata>${meta}</metadata>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<rect rx="4" width="${tw}" height="28" fill="#2a2f36"/>
<rect rx="4" x="${lw}" width="${vw}" height="28" fill="${color}"/>
<path fill="${color}" d="M${lw} 0h4v28h-4z"/>
<rect rx="4" width="${tw}" height="28" fill="url(#s)"/>
<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="19" fill="#dfe6ee">${escXml(label)}</text>
<text x="${lw + vw / 2}" y="19" fill="#0b0e11" font-weight="bold">${escXml(value)}</text>
</g></svg>\n`;
  if (verify) {
    const have = existsSync(String(out ?? "")) ? readFileSync(String(out), "utf8") : "";
    const ok = have === svg;
    console.log(`sealed-badge/v1 — ${m.id} · ${pctTxt}`);
    console.log(`  ${ok ? "✓" : "✗"} badge render — ${ok ? "byte-identical to a fresh render from the bound claim card" : "MISMATCH — badge does not match its bound receipt"}`);
    if (!ok) process.exitCode = 1;
    return { ok };
  }
  if (out) { writeFileSync(out, svg); console.log(`wrote ${out} — ${m.id} ${pctTxt} (bound to claim ${claimSha.slice(0, 16)}…; verify: chain prove --verify ${cardPath})`); }
  else process.stdout.write(svg);
  return { model: m.id, pct, claimSha };
}

/** `chain prove <model> [--out f]` — mint a portable claim card
 *  (`sealed-claim/v1`): one model's ModelRecord + every receipt + every
 *  run + every bank + every venue that settled on those runs, each with
 *  its PDA seeds so `prove --verify` can re-derive every address and
 *  replay every verdict keyless. This is the product's deliverable: a
 *  model provider hands the card to anyone and the claims check out
 *  with nothing but the program IDs. */
export async function chainProve(modelStr: string | undefined, out: string | undefined, snapPath?: string, all = false) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sAcct = () => sealedProgram().program;
  const mAcct = () => marketProgram().market;
  type Acct = { publicKey: PublicKey; account: any };
  const [banks, runs, logs, records]: Acct[][] =
    ss ? ["Benchmark", "Run", "ScoreLog", "ModelRecord"].map((n) => snapOf(ss, n))
       : await Promise.all(["benchmark", "run", "scoreLog", "modelRecord"].map((n) => tolerantAll(sAcct(), n)));
  const [markets, darks, ladders, bounties]: Acct[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty"].map((n) => tolerantAll(mAcct(), n)));

  const modelHash = (id: string) => createHash("sha256").update(Buffer.from(id, "utf8")).digest();
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const u64le = (n: any) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(num(n))); return b; };
  const isDuel = (m: any) => m.account.runB && m.account.runB.toBase58() !== PublicKey.default.toBase58();
  const buildCard = (rec: Acct) => {
  const modelId = String(rec.account.modelId);
  const recPk = rec.publicKey.toBase58();
  const myLogs = logs.filter((l) => l.account.modelRecord.toBase58() === recPk);
  const myRuns = runs.filter((r) => String(r.account.modelId) === modelId);
  const runSet = new Set(myRuns.map((r) => r.publicKey.toBase58()));
  const myMarkets = markets.filter((m) => runSet.has(m.account.run.toBase58()) || (isDuel(m) && runSet.has(m.account.runB.toBase58())));
  const myDarks = darks.filter((d) => runSet.has(d.account.run.toBase58()));
  const myLadders = ladders.filter((l) => (l.account.legs as PublicKey[]).slice(0, Number(l.account.legCount)).some((p) => runSet.has(p.toBase58())));
  // co-participant runs a venue's verdict needs (duel runB, ladder legs) —
  // the card is self-contained: every account its verdicts touch is inside
  const coSet = new Set<string>();
  for (const m of myMarkets) { coSet.add(m.account.run.toBase58()); if (isDuel(m)) coSet.add(m.account.runB.toBase58()); }
  for (const d of myDarks) coSet.add(d.account.run.toBase58());
  for (const l of myLadders) for (const p of (l.account.legs as PublicKey[]).slice(0, Number(l.account.legCount))) coSet.add(p.toBase58());
  const coRuns = runs.filter((r) => !runSet.has(r.publicKey.toBase58()) && coSet.has(r.publicKey.toBase58()));
  const allRuns = [...myRuns, ...coRuns];
  for (const r of coRuns) runSet.add(r.publicKey.toBase58());
  const bankSet = new Set(allRuns.map((r) => r.account.benchmark.toBase58()));
  const myBanks = banks.filter((b) => bankSet.has(b.publicKey.toBase58()));
  const myBounties = bounties.filter((b) => bankSet.has(b.account.bank.toBase58()) || (b.account.winnerRun && runSet.has(b.account.winnerRun.toBase58())));

  const claim = {
    kind: "sealed-claim/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath ?? "live",
    programs: { sealed: sealedProgramId().toBase58(), market: MARKET_PROGRAM_ID.toBase58() },
    model: { id: modelId, recordPk: recPk,
      runsScored: num(rec.account.runsScored), totalCorrect: num(rec.account.totalCorrect), totalItems: num(rec.account.totalItems) },
    record: { pk: recPk, seeds: { prefix: "modelrec", modelHash: modelHash(modelId).toString("hex") } },
    receipts: myLogs.map((l) => ({ pk: l.publicKey.toBase58(), run: l.account.run.toBase58(), benchmark: l.account.benchmark.toBase58(),
      correct: num(l.account.correct), items: num(l.account.items), recordedAt: num(l.account.recordedAt),
      vouched: !!l.account.vouchedAtRecord, postReveal: !!l.account.postReveal })),
    runs: allRuns.map((r) => ({ pk: r.publicKey.toBase58(), benchmark: r.account.benchmark.toBase58(), index: num(r.account.index),
      role: String(r.account.modelId) !== modelId ? "co-participant" : "subject",
      status: num(r.account.status), correct: num(r.account.correct), chunkCount: num(r.account.chunkCount),
      createdAt: num(r.account.createdAt), finalizedAt: num(r.account.finalizedAt), runner: r.account.runner.toBase58(),
      attested: !!r.account.attested, postReveal: !!r.account.postReveal })),
    banks: myBanks.map((b) => ({ pk: b.publicKey.toBase58(), name: String(b.account.name), authority: b.account.authority.toBase58(),
      id: num(b.account.id), kind: num(b.account.kind), chunkCount: num(b.account.chunkCount),
      itemsRoot: Buffer.from(b.account.itemsRoot as number[]).toString("hex") })),
    venues: [
      ...myMarkets.map((m) => ({ pk: m.publicKey.toBase58(), kind: isDuel(m) ? "duel" : "band", run: m.account.run.toBase58(),
        runB: isDuel(m) ? m.account.runB.toBase58() : null, salt: num(m.account.salt), status: num(m.account.status),
        outcome: num(m.account.outcome), resolvedScore: num(m.account.resolvedScore), pot: (m.account.totals as any[]).reduce((s: number, t: any) => s + num(t), 0) })),
      ...myDarks.map((d) => ({ pk: d.publicKey.toBase58(), kind: "dark", run: d.account.run.toBase58(), salt: num(d.account.salt),
        status: num(d.account.status), outcome: num(d.account.outcome), resolvedScore: num(d.account.resolvedScore),
        tallied: !!d.account.tallied, pool: num(d.account.poolTotal) })),
      ...myLadders.map((l) => ({ pk: l.publicKey.toBase58(), kind: "ladder", legs: (l.account.legs as PublicKey[]).slice(0, Number(l.account.legCount)).map((p) => p.toBase58()),
        salt: num(l.account.salt), status: num(l.account.status), resultMask: num(l.account.resultMask),
        resolvedScore: num(l.account.resolvedScore), pot: (l.account.totals as any[]).reduce((s: number, t: any) => s + num(t), 0) })),
      ...myBounties.map((b) => ({ pk: b.publicKey.toBase58(), kind: "bounty", bank: b.account.bank.toBase58(), sponsor: b.account.sponsor.toBase58(),
        salt: num(b.account.salt), status: num(b.account.status), threshold: num(b.account.threshold), amount: num(b.account.amount),
        winnerRun: b.account.winnerRun ? b.account.winnerRun.toBase58() : null, winningScore: num(b.account.winningScore) })),
    ],
  };
  // verdicts the verifier replays — emitted so a reader sees WHAT passed,
  // recomputed so a verifier sees THAT it passes
  const totC = claim.receipts.reduce((s, l) => s + l.correct, 0);
  const totI = claim.receipts.reduce((s, l) => s + l.items, 0);
  const verdicts = {
    recordBitExact: totC === claim.model.totalCorrect && totI === claim.model.totalItems && claim.receipts.length === claim.model.runsScored,
    postRevealRuns: myRuns.filter((r) => !!r.account.postReveal).length,
    coParticipantRuns: coRuns.length,
    postRevealReceipts: claim.receipts.filter((l) => l.postReveal).length,
    venuesPriced: claim.venues.length,
    venuesResolved: claim.venues.filter((v: any) => v.status === 1).length,
  };
  return { ...claim, verdicts };
  };

  if (all) {
    const dir = out ?? "claims";
    mkdirSync(dir, { recursive: true });
    let postReveal = 0;
    console.log(`minting claim cards for ${records.length} records → ${dir}/`);
    for (const rec of records) {
      const card = buildCard(rec);
      const fname = `${String(rec.account.modelId).replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
      writeFileSync(`${dir}/${fname}`, JSON.stringify(card, null, 2) + "\n");
      postReveal += card.verdicts.postRevealRuns > 0 ? 1 : 0;
      console.log(`  ${card.model.id.padEnd(36)} ${String(card.model.totalCorrect).padStart(3)}/${card.model.totalItems} · ${card.receipts.length} receipts · ${card.venues.length} venues → ${dir}/${fname}`);
    }
    console.log(`${records.length} claim cards minted — ${postReveal} carry post-reveal-run flags · verify all: chain prove --verify ${dir}`);
    return;
  }

  const rec = records.find((x) => x.publicKey.toBase58() === modelStr)
    ?? records.find((x) => String(x.account.modelId) === modelStr);
  if (!rec) throw new Error(`no ModelRecord for ${modelStr} (try chain records for the list)`);
  const card = buildCard(rec);
  const modelId = card.model.id;
  const text = JSON.stringify(card, null, 2) + "\n";
  if (out) { writeFileSync(out, text); console.log(`wrote ${out} — claim card for ${modelId}: ${card.receipts.length} receipts, ${card.runs.filter((r: any) => r.role === "subject").length} runs, ${card.banks.length} banks, ${card.venues.length} venues`); }
  else console.log(text);
  return card;
}

/** `chain prove --verify <file>` — verify a claim card offline: every PDA
 *  re-derives from its declared seeds (an account's address IS its
 *  identity), the record aggregate replays bit-exact from its receipts,
 *  run scores match their receipts, and venue resolutions re-derive from
 *  the runs they priced. Exit 1 on any violation. */
export async function chainProveVerify(file: string, policy?: GatePolicy, json = false, snapPath?: string) {
  const { statSync, readdirSync } = await import("node:fs");
  if (statSync(file).isDirectory()) {
    const files = readdirSync(file).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) throw new Error(`no claim cards (*.json) in ${file}`);
    let okAll = true;
    const results: any[] = [];
    if (!json) console.log(`verifying ${files.length} claim card(s) in ${file}/`);
    for (const f of files) {
      try {
        const card = JSON.parse(readFileSync(`${file}/${f}`, "utf8"));
        const r = await verifyClaimCard(card, undefined, snapPath);
        results.push({ file: f, model: card.model?.id ?? null, ok: r.ok, pass: r.pass, fail: r.fail, fails: r.fails });
        if (!json) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${f.padEnd(40)} ${card.model?.id ?? "?"} — ${r.pass} checks${r.ok ? "" : ` · ${r.fails.join("; ")}`}`);
        okAll &&= r.ok;
      } catch (e: any) { okAll = false; results.push({ file: f, ok: false, error: String(e?.message ?? e) }); if (!json) console.log(`  FAIL ${f} — ${e?.message ?? e}`); }
    }
    if (json) console.log(JSON.stringify({ dir: file, cards: results, ok: okAll }));
    else console.log(`${okAll ? "ALL CARDS VERIFIED" : "VERIFICATION FAILED"} — ${files.length} card(s), ${file}`);
    if (!okAll) process.exit(1);
    return { ok: okAll, cards: results };
  }
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (card.kind !== "sealed-claim/v1") throw new Error(`not a sealed-claim/v1 file (kind=${card.kind})`);
  const rows: { what: string; ok: boolean; detail: string }[] = [];
  const r = verifyClaimCard(card, (what, ok, detail) => { rows.push({ what, ok, detail }); if (!json) console.log(`  ${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); }, snapPath);
  const summary = `${card.model.id}: ${r.pass} checks pass, ${r.fail} fail · ` +
    `${card.model.totalCorrect}/${card.model.totalItems} across ${card.model.runsScored} run(s)` +
    (card.verdicts?.postRevealRuns ? ` · ${card.verdicts.postRevealRuns} post-reveal run(s) flagged` : "");
  if (!json) console.log(`${r.ok ? "CLAIM VERIFIED" : "CLAIM FAILED"} — ${summary}`);
  if (r.fail) process.exitCode = 1;
  if (policy) {
    const v = evalGate(card.receipts as ScoreReceipt[], policy, true);
    if (json) console.log(JSON.stringify({ file, model: card.model.id, verified: r.ok, checks: rows, pass: r.pass, fail: r.fail,
      policy: { pass: v.pass, reason: v.reason, pct: v.pct, runs: v.runs, correct: v.correct, items: v.items,
        checks: v.checks.map((c) => ({ name: c.name, pass: c.pass, actual: c.actual, needed: c.needed })) } }));
    else {
      const checks = v.checks.map((c) => `  ${c.pass ? "ok  " : "MISS"} ${c.name}: ${c.actual} (needed ${c.needed})`);
      console.log(`policy verdict — ${v.pass ? "PASS" : "FAIL"} (${v.reason}) · ${v.correct}/${v.items} = ${v.pct.toFixed(1)}% over ${v.runs} run(s)` +
        (v.postRevealRuns ? ` · ${v.postRevealRuns} post-reveal` : "") + (checks.length ? "\n" + checks.join("\n") : ""));
    }
    if (!v.pass) process.exitCode = v.reason === "no-evidence" ? 2 : 1;
    return { pass: r.pass, fail: r.fail, policy: v.pass };
  }
  if (json) console.log(JSON.stringify({ file, model: card.model.id, verified: r.ok, checks: rows, pass: r.pass, fail: r.fail }));
  return { pass: r.pass, fail: r.fail };
}

/** Run the sealed-claim/v1 checks against a parsed card. `emit` receives
 *  each (check, ok, detail) row; returns aggregate verdict. */
export function verifyClaimCard(card: any, emit?: (what: string, ok: boolean, detail: string) => void, snapPath?: string) {
  const sealedId = new PublicKey(card.programs.sealed);
  const marketId = new PublicKey(card.programs.market);
  const u64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const pk = (s: string) => new PublicKey(s);
  const derive = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
  let pass = 0, fail = 0;
  const fails: string[] = [];
  const check = (what: string, ok: boolean, detail = "") => {
    emit?.(what, ok, detail);
    if (ok) pass++; else { fail++; fails.push(what); }
  };

  // 1. every PDA re-derives — identity is cryptographic, not claimed
  check("record PDA", derive([Buffer.from("modelrec"), Buffer.from(card.record.seeds.modelHash, "hex")], sealedId) === card.record.pk,
    `${card.record.pk.slice(0, 12)}… = [modelrec, sha256(${card.model.id})]`);
  const runByPk = new Map(card.runs.map((r: any) => [r.pk, r]));
  let runOk = 0;
  for (const r of card.runs)
    if (derive([Buffer.from("run"), pk(r.benchmark).toBuffer(), u64le(r.index)], sealedId) === r.pk) runOk++;
  check("run PDAs", runOk === card.runs.length, `${runOk}/${card.runs.length} re-derived`);
  const bankByPk = new Map(card.banks.map((b: any) => [b.pk, b]));
  let bankOk = 0;
  for (const b of card.banks)
    if (derive([Buffer.from("benchmark"), pk(b.authority).toBuffer(), u32le(b.id)], sealedId) === b.pk) bankOk++;
  check("bank PDAs", bankOk === card.banks.length, `${bankOk}/${card.banks.length} re-derived`);
  let logOk = 0;
  for (const l of card.receipts)
    if (runByPk.has(l.run) && derive([Buffer.from("scorelog"), pk(l.run).toBuffer()], sealedId) === l.pk) logOk++;
  check("receipt PDAs", logOk === card.receipts.length, `${logOk}/${card.receipts.length} re-derived`);
  let venueOk = 0;
  for (const v of card.venues) {
    let seeds: Buffer[] | null = null;
    if (v.kind === "band") seeds = [Buffer.from("market"), pk(v.run).toBuffer(), u64le(v.salt)];
    else if (v.kind === "duel") seeds = [Buffer.from("duel"), pk(v.run).toBuffer(), pk(v.runB).toBuffer(), u64le(v.salt)];
    else if (v.kind === "dark") seeds = [Buffer.from("dark"), pk(v.run).toBuffer(), u64le(v.salt)];
    else if (v.kind === "ladder") seeds = [Buffer.from("ladder"), pk(v.legs[0]).toBuffer(), u64le(v.salt)];
    else if (v.kind === "bounty") seeds = [Buffer.from("bounty"), pk(v.bank).toBuffer(), pk(v.sponsor).toBuffer(), u64le(v.salt)];
    if (seeds && derive(seeds, marketId) === v.pk) venueOk++;
  }
  check("venue PDAs", venueOk === card.venues.length, `${venueOk}/${card.venues.length} re-derived`);

  // 2. the record aggregate replays bit-exact from its receipts
  const totC = card.receipts.reduce((s: number, l: any) => s + l.correct, 0);
  const totI = card.receipts.reduce((s: number, l: any) => s + l.items, 0);
  check("record aggregate", totC === card.model.totalCorrect && totI === card.model.totalItems,
    `${totC}/${totI} = stored ${card.model.totalCorrect}/${card.model.totalItems}`);
  // runsScored counts receipted runs (record_score mints one ScoreLog per
  // run — [scorelog, run] is singleton) — NOT every finalized run
  check("runsScored=receipts", card.receipts.length === card.model.runsScored,
    `${card.receipts.length} receipt(s) = stored ${card.model.runsScored}`);

  // 3. receipts' scores match their runs' Run.correct
  let scoreOk = 0, scoreChecked = 0;
  for (const l of card.receipts) {
    const r = runByPk.get(l.run) as any;
    if (!r || r.status !== 1) continue;
    scoreChecked++;
    if (r.correct === l.correct) scoreOk++;
  }
  check("receipt=run score", scoreOk === scoreChecked, `${scoreOk}/${scoreChecked} receipts agree with Run.correct`);

  // 4. venues re-verify against the runs they priced
  let resOk = 0, resChecked = 0;
  for (const v of card.venues) {
    if (v.status !== 1) continue;
    if (v.kind === "duel") {
      const a = runByPk.get(v.run) as any, b = runByPk.get(v.runB) as any;
      if (!a || !b || a.status !== 1 || b.status !== 1) continue;
      resChecked++;
      const packed = (a.correct << 16) | b.correct;
      const expected = a.correct > b.correct ? 0 : a.correct < b.correct ? 1 : 2;
      if (v.resolvedScore === packed && v.outcome === expected) resOk++;
    } else if (v.kind === "ladder") {
      const legs = (v.legs as string[]).map((p) => runByPk.get(p) as any);
      if (legs.some((r) => !r || r.status !== 1)) continue;
      resChecked++;
      const best = Math.max(...legs.map((r) => r.correct));
      const mask = legs.reduce((s, r, i) => s + (r.correct === best ? (1 << i) : 0), 0);
      if (v.resolvedScore === best && v.resultMask === mask) resOk++;
    } else if (v.kind === "bounty") {
      if (!v.winnerRun) continue;
      const w = runByPk.get(v.winnerRun) as any;
      if (!w || w.status !== 1) continue;
      resChecked++;
      if (w.correct === v.winningScore && w.correct >= v.threshold) resOk++;
    } else {
      const r = runByPk.get(v.run) as any;
      if (!r || r.status !== 1) continue;
      resChecked++;
      if (v.resolvedScore === r.correct) resOk++;
    }
  }
  check("venue resolutions", resOk === resChecked, `${resOk}/${resChecked} re-derived from Run.correct`);

  // 4. snapshot binding — every receipt must equal its decoded ScoreLog
  // account field-for-field AND point at THIS card's model record (a card
  // naming model A while embedding model B's receipts dies here).
  if (snapPath) {
    const ss = decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed");
    const logs = new Map(snapOf(ss, "ScoreLog").map((l) => [l.publicKey.toBase58(), l]));
    const recs = new Map(snapOf(ss, "ModelRecord").map((r) => [r.publicKey.toBase58(), r]));
    let bBad = 0;
    for (const l of card.receipts) {
      const real = logs.get(l.pk);
      if (!real || (real.account.run as PublicKey).toBase58() !== l.run ||
          (real.account.benchmark as PublicKey).toBase58() !== l.benchmark ||
          (real.account.modelRecord as PublicKey).toBase58() !== card.record.pk ||
          Number(real.account.correct) !== l.correct || Number(real.account.items) !== l.items ||
          Number(real.account.vouchedAtRecord ?? 0) !== (l.vouched ? 1 : 0) ||
          Number(real.account.postReveal ?? 0) !== (l.postReveal ? 1 : 0)) bBad++;
    }
    const rec = recs.get(card.record.pk);
    const idOk = !!rec && String(rec.account.modelId) === card.model.id;
    check("snapshot binding", bBad === 0 && idOk,
      `${card.receipts.length - bBad}/${card.receipts.length} receipts == ScoreLog bytes, each bound to the named record` +
      (idOk ? " · on-chain modelId matches" : ` · MODEL ID MISMATCH (${card.model.id} not on ${card.record.pk.slice(0, 12)}…)`));
  }

  return { ok: fail === 0, pass, fail, fails };
}

/** `chain feed [--limit N] [--type a,b] [--since ts] [--json]` — the
 *  network's activity stream: every timestamped event across both
 *  programs (bank created → run queued → MPC finalized → receipt
 *  minted → venue opened → resolved → reveal → grant) in one
 *  chronological list, newest first. The per-type indexes answer "what
 *  exists"; this answers "is it alive". `--type` filters by event class
 *  (bank,run,score,receipt,venue,resolution,reveal,grant). */
export async function chainFeed(limit = 40, typeFilter?: string, since = 0, json = false, snapPath?: string, pkFilter?: string, quiet = false, modelFilter?: string, bankFilter?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const sAcct = () => sealedProgram().program;
  const mAcct = () => marketProgram().market;
  type Acct = { publicKey: PublicKey; account: any };
  const [banks, runs, logs, reveals, grants, records]: Acct[][] =
    ss ? ["Benchmark", "Run", "ScoreLog", "Reveal", "ShareGrant", "ModelRecord"].map((n) => snapOf(ss, n))
       : await Promise.all(["benchmark", "run", "scoreLog", "reveal", "shareGrant", "modelRecord"]
        .map((n) => tolerantAll(sAcct(), n)));
  const [markets, darks, ladders, bounties]: Acct[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty"]
        .map((n) => tolerantAll(mAcct(), n)));

  const bankName = new Map(banks.map((b) => [b.publicKey.toBase58(), `${b.account.name} (${BANK_KIND[b.account.kind as number] ?? "?"})`]));
  const runModel = new Map(runs.map((r) => [r.publicKey.toBase58(), r.account.modelId as string]));
  const items = (r: any) => Number(r.chunkCount) * 32;

  type Ev = { t: number; type: string; pk: string; msg: string; refs: string[] };
  const evs: Ev[] = [];
  const push = (t: any, type: string, pk: PublicKey, msg: string, refs: any[] = []) => {
    const n = Number(t ?? 0);
    if (n > 0) evs.push({ t: n, type, pk: pk.toBase58(), msg, refs: refs.map((r) => (r?.toBase58 ? r.toBase58() : String(r ?? ""))).filter(Boolean) });
  };
  for (const b of banks) push(b.account.createdAt, "bank", b.publicKey, `bank created — ${b.account.name} [${BANK_KIND[b.account.kind as number] ?? "?"}]`);
  for (const r of runs) {
    const bank = bankName.get((r.account.benchmark as PublicKey).toBase58()) ?? r.account.benchmark.toBase58().slice(0, 10);
    push(r.account.createdAt, "run", r.publicKey, `run queued — ${r.account.modelId} on ${bank}`, [r.account.benchmark, r.account.runner]);
    push(r.account.finalizedAt, "score", r.publicKey, `MPC finalized — ${r.account.modelId} scored ${r.account.correct}/${items(r.account)} on ${bank}${r.account.postReveal ? " (post-reveal)" : ""}`, [r.account.benchmark, r.account.runner]);
  }
  for (const l of logs) {
    const runPk = (l.account.run as PublicKey).toBase58();
    push(l.account.recordedAt, "receipt", l.publicKey, `receipt minted — ${runModel.get(runPk) ?? "?"} ${l.account.correct}/${l.account.items}${l.account.vouchedAtRecord ? " [vouched]" : ""}${l.account.postReveal ? " [post-reveal]" : ""}`,
      [l.account.run, l.account.benchmark, l.account.modelRecord, l.account.recordedBy]);
  }
  for (const rv of reveals) push(rv.account.revealedAt, "reveal", rv.publicKey, `fingerprint reveal — ${bankName.get((rv.account.benchmark as PublicKey).toBase58()) ?? "?"} part ${rv.account.part}`, [rv.account.benchmark]);
  for (const g of grants) push(g.account.sharedAt, "grant", g.publicKey, `access grant — ${bankName.get((g.account.benchmark as PublicKey).toBase58()) ?? "?"} part ${g.account.part} shared to ${String(g.account.viewer?.toBase58 ? g.account.viewer.toBase58() : g.account.viewer).slice(0, 12)}…`, [g.account.benchmark, g.account.viewer]);
  for (const m of markets) {
    const duel = m.account.runB && !(m.account.runB as PublicKey).equals(PublicKey.default);
    push(m.account.createdAt, "venue", m.publicKey, `venue opened — ${duel ? "duel" : "band"} on ${runModel.get((m.account.run as PublicKey).toBase58()) ?? "?"}`, [m.account.run, m.account.runB, m.account.authority]);
    const rs = Number(m.account.resolvedScore);
    push(m.account.resolvedAt, "resolution", m.publicKey, `venue resolved — ${duel ? `duel ${rs >> 16}-${rs & 0xffff}` : `band outcome ${m.account.outcome} (score ${rs})`}`, [m.account.run, m.account.runB, m.account.authority]);
  }
  for (const d of darks) {
    push(d.account.createdAt, "venue", d.publicKey, `dark venue opened — ${runModel.get((d.account.run as PublicKey).toBase58()) ?? "?"}`, [d.account.run, d.account.authority]);
    push(d.account.resolvedAt, "resolution", d.publicKey, `dark venue resolved${d.account.tallied ? " + tallied" : ""}`, [d.account.run, d.account.authority]);
  }
  for (const l of ladders) {
    push(l.account.createdAt, "venue", l.publicKey, `ladder opened — ${l.account.legCount} legs`, (l.account.legs as PublicKey[]).slice(0, Number(l.account.legCount)).concat([l.account.authority]));
    push(l.account.resolvedAt, "resolution", l.publicKey, `ladder resolved — mask ${l.account.resultMask}`, (l.account.legs as PublicKey[]).slice(0, Number(l.account.legCount)).concat([l.account.authority]));
  }
  for (const b of bounties) {
    const claimed = !(b.account.winnerRun as PublicKey).equals(PublicKey.default);
    push(b.account.createdAt, "venue", b.publicKey, `bounty posted — ≥${b.account.threshold} pays ${(Number(b.account.amount) / 1e9).toFixed(3)}◎${claimed ? ` (claimed @${b.account.winningScore})` : ""}`, [b.account.bank, b.account.sponsor, b.account.winnerRun]);
  }
  const keep = typeFilter ? new Set(typeFilter.split(",").map((s) => s.trim())) : null;
  // --bank: a bank's timeline covers every event touching it — its runs,
  // receipts, reveals, grants, and (through the run refs venues carry) the
  // markets that priced those runs. Names match every bank carrying them.
  let bankSet: Set<string> | null = null, bankRunSet: Set<string> | null = null;
  if (bankFilter) {
    const hit = banks.filter((b) => b.publicKey.toBase58() === bankFilter || b.account.name === bankFilter);
    if (!hit.length) throw new Error(`no benchmark named/addressed ${bankFilter}`);
    bankSet = new Set(hit.map((b) => b.publicKey.toBase58()));
    bankRunSet = new Set(runs.filter((r) => bankSet!.has((r.account.benchmark as PublicKey).toBase58())).map((r) => r.publicKey.toBase58()));
  }
  const filtered = evs.filter((e) => e.t >= since && (!keep || keep.has(e.type))
    && (!pkFilter || e.pk === pkFilter || e.refs.includes(pkFilter))
    && (!modelFilter || runModel.get(e.pk) === modelFilter || e.refs.some((r) => runModel.get(r) === modelFilter))
    && (!bankSet || e.refs.some((r) => bankSet!.has(r) || bankRunSet!.has(r))))
    .sort((a, b) => b.t - a.t).slice(0, limit);
  if (json) { console.log(JSON.stringify(filtered)); return filtered; }
  if (quiet) return filtered;
  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  // ref → account-class index, so --pk can say WHY an event matched:
  // "receipt … via its run" reads as custody, not just a key filter.
  const refType = new Map<string, string>();
  const tagAll = (arr: Acct[], t: string) => { for (const x of arr) refType.set(x.publicKey.toBase58(), t); };
  tagAll(banks, "bank"); tagAll(runs, "run"); tagAll(logs, "receipt");
  tagAll(records, "record"); tagAll(reveals, "reveal"); tagAll(grants, "grant");
  tagAll(markets, "venue"); tagAll(darks, "venue"); tagAll(ladders, "venue"); tagAll(bounties, "venue");
  console.log(`feed — ${filtered.length} event(s)${typeFilter ? ` [${typeFilter}]` : ""}${pkFilter ? ` touching ${pkFilter.slice(0, 12)}…` : ""}${modelFilter ? ` [model ${modelFilter}]` : ""}${bankFilter ? ` [bank ${bankFilter}]` : ""} newest first`);
  for (const e of filtered) {
    let via = "";
    if (pkFilter && e.pk !== pkFilter) {
      const hit = e.refs.find((r) => r === pkFilter);
      if (hit) via = `  · via ${refType.get(hit) ?? "key"} ${hit.slice(0, 8)}…`;
    }
    console.log(`  ${fmt(e.t)}  ${e.type.padEnd(10)} ${e.pk.slice(0, 12)}…  ${e.msg}${via}`);
  }
  return filtered;
}

/** `chain watch [--interval s] [--type a,b]` — the ledger's pulse: a live
 *  tail of `chain feed`. Prints new events oldest-first as they land —
 *  "run queued → MPC finalized → receipt minted → venue resolved" in
 *  real time. RPC mode only (a snapshot can't tick); Ctrl-C exits. */
export async function chainWatch(intervalSecs = 15, typeFilter?: string, since = 0, snapPath?: string, modelFilter?: string, bankFilter?: string) {
  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  const key = (e: any) => `${e.t}|${e.type}|${e.pk}|${e.msg}`;
  let lastT = since > 0 ? since : snapPath ? 0 : Math.floor(Date.now() / 1000) - 60;
  const tail = new Set<string>();
  console.log(`watch — ${snapPath ? "snapshot" : "live"} feed every ${intervalSecs}s (Ctrl-C to stop)${typeFilter ? ` [${typeFilter}]` : ""}${modelFilter ? ` [model ${modelFilter}]` : ""}${bankFilter ? ` [bank ${bankFilter}]` : ""}`);
  const first = (await chainFeed(500, typeFilter, lastT - 1, false, snapPath, undefined, true, modelFilter, bankFilter)) as any[];
  if (first.length) {
    for (const e of first.slice(-15)) {
      console.log(`  ${fmt(e.t)}  ${e.type.padEnd(10)} ${e.pk.slice(0, 12)}…  ${e.msg}`);
      tail.add(key(e));
    }
    lastT = Math.max(...first.map((e) => e.t));
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalSecs * 1000));
    let fresh: any[] = [];
    try { fresh = (await chainFeed(500, typeFilter, lastT - 1, false, snapPath, undefined, true, modelFilter, bankFilter)) as any[]; }
    catch (e: any) { console.log(`  ${fmt(Math.floor(Date.now() / 1000))}  …poll error: ${String(e?.message ?? e).slice(0, 80)}`); continue; }
    if (!fresh.length) continue;
    for (const e of fresh.slice().sort((a, b) => a.t - b.t)) {
      if (tail.has(key(e))) continue;      // timestamp collisions can't double-print
      tail.add(key(e));
      console.log(`  ${fmt(e.t)}  ${e.type.padEnd(10)} ${e.pk.slice(0, 12)}…  ${e.msg}`);
    }
    lastT = Math.max(lastT, ...fresh.map((e) => e.t));
    if (tail.size > 5000) tail.clear();    // bounded memory on a long watch
  }
}

/** `chain gate --all <policy>` — the gate as a leaderboard filter: run the
 *  same admission policy over EVERY ModelRecord's receipts and report who
 *  clears it. "Which models provably clear ≥80% with ≥10 vouched runs?"
 *  is a one-line answer, not a leaderboard's word. */
export async function gateAll(policy: GatePolicy, json = false, snapPath?: string, bank?: string, proveDir?: string) {
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
    return { record: r.publicKey.toBase58(), modelId: r.account.modelId as string, verdict: evalGate(receipts, policy, true) };
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
  // --prove <dir>: for every model the policy admits, mint its portable
  // claim card. The gate answers "who clears"; the cards are the proof
  // you can hand to whoever asked.
  if (proveDir) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(proveDir, { recursive: true });
    const passers = rows.filter((r) => r.verdict.pass);
    const origLog = console.log; console.log = () => {};
    try {
      for (const r of passers) {
        const slug = r.modelId.replace(/[^A-Za-z0-9._-]+/g, "_");
        await chainProve(r.modelId, `${proveDir}/${slug}.json`, snapPath);
      }
    } finally { console.log = origLog; }
    if (passers.length) console.log(`  prove — ${passers.length} claim card(s) minted to ${proveDir}/ (verify each: chain prove --verify <file>)`);
  }
  return rows;
}

/** `chain gate --sweep [flags]` — the policy-sensitivity grid. `gate --all`
 *  answers "who clears THIS line"; the sweep answers "who is robustly
 *  good" — every record re-evaluated across a min-pct grid, so no
 *  leaderboard depends on where someone chose to draw one threshold.
 *  Cell: ● pass · fail — no-evidence. `frontier` = strictest threshold
 *  cleared; models whose pass-set is contiguous-from-below are stable,
 *  a model that only clears low bars with gaps is threshold-fragile. */
/** `chain gate <model> --why [--policy flags]` — the policy autopsy: not
 *  just pass/fail but the envelope. Under each evidence scope (all /
 *  vouched-only / no-post-reveal / both) report the maximum threshold the
 *  record survives on every dimension, and — when a policy is given —
 *  name the binding constraint that kills it. */
export async function gateWhy(modelStr: string, policy: GatePolicy | undefined, json = false, snapPath?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [records, logs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all()]);
  const rec = records.find((r) => r.publicKey.toBase58() === modelStr)
    ?? records.find((r) => String(r.account.modelId) === modelStr)
    ?? records.find((r) => r.publicKey.equals(PublicKey.findProgramAddressSync(
        [Buffer.from("modelrec"), createHash("sha256").update(Buffer.from(modelStr, "utf8")).digest()], sealedProgramId())[0]));
  if (!rec) throw new Error(`no ModelRecord for ${modelStr}`);
  const receipts: ScoreReceipt[] = logs
    .filter((l) => (l.account.modelRecord as PublicKey).equals(rec.publicKey))
    .map((l: any) => ({ correct: l.account.correct, items: l.account.items,
      vouchedAtRecord: l.account.vouchedAtRecord, postReveal: l.account.postReveal }));
  const envelope = (scope: GatePolicy) => {
    const sel = scope.vouchedOnly ? receipts.filter((r) => !!r.vouchedAtRecord) : receipts;
    const sel2 = scope.noPostReveal ? sel.filter((r) => !r.postReveal) : sel;
    const runs = sel2.length, correct = sel2.reduce((s, r) => s + Number(r.correct), 0),
      items = sel2.reduce((s, r) => s + Number(r.items), 0),
      pct = items > 0 ? (100 * correct) / items : 0,
      lcb = wilsonLowerBoundPct(correct, items);
    return { runs, items, correct, pct, lcb,
      maxMinPct: Math.floor(pct * 100) / 100, maxMinRuns: runs, maxMinItems: items,
      maxWilson: Math.floor(lcb * 100) / 100 };
  };
  const scopes = [
    { name: "all evidence", p: {} },
    { name: "vouched-only", p: { vouchedOnly: true } },
    { name: "no-post-reveal", p: { noPostReveal: true } },
    { name: "vouched + no-post-reveal", p: { vouchedOnly: true, noPostReveal: true } },
  ] as { name: string; p: GatePolicy }[];
  const envs = scopes.map((s) => ({ name: s.name, e: envelope(s.p) }));
  let verdict: any = null, binding: string | null = null;
  if (policy) {
    verdict = evalGate(receipts, policy, true);
    if (!verdict.pass && verdict.reason === "policy")
      binding = verdict.checks.find((c: GateCheck) => !c.pass)?.name ?? null;
  }
  const out = { model: rec.account.modelId, envelope: envs, verdict, binding };
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`gate --why ${rec.account.modelId} — the policy envelope, scope by scope:`);
  console.log(`  ${"scope".padEnd(26)} ${"runs".padStart(4)} ${"items".padStart(6)} ${"pct".padStart(7)}  ${"lcb95".padStart(6)}  survivable policy ceiling`);
  for (const { name, e } of envs) {
    const ceil = e.runs === 0 ? "no evidence survives — any criterion fails"
      : `minPct≤${e.maxMinPct}% · minRuns≤${e.maxMinRuns} · minItems≤${e.maxMinItems} · wilson≤${e.maxWilson}%`;
    console.log(`  ${name.padEnd(26)} ${String(e.runs).padStart(4)} ${String(e.items).padStart(6)} ${e.pct.toFixed(2).padStart(6)}% ${e.lcb.toFixed(1).padStart(6)}  ${ceil}`);
  }
  if (verdict) {
    const parts = [policy!.minPct !== undefined && `pct≥${policy!.minPct}`, policy!.minRuns !== undefined && `runs≥${policy!.minRuns}`,
      policy!.minItems !== undefined && `items≥${policy!.minItems}`, policy!.minWilsonPct !== undefined && `wilson≥${policy!.minWilsonPct}`,
      policy!.vouchedOnly && "vouched", policy!.noPostReveal && "no-post-reveal"].filter(Boolean).join(" ");
    console.log(`  verdict [${parts}] — ${verdict.pass ? "PASS" : `FAIL (${verdict.reason})`}` +
      (binding ? ` · binding constraint: ${binding}` : ""));
    for (const c of verdict.checks) console.log(`    ${c.pass ? "ok  " : "MISS"} ${c.name}: ${c.actual} (needed ${c.needed})`);
  }
  return out;
}

export async function gateSweep(base: GatePolicy, json = false, snapPath?: string, bank?: string, grid = [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [records, allLogs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all()]);
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
    const cells = grid.map((minPct) => evalGate(receipts, { ...base, minPct }, true));
    const frontier = cells.reduce((f, v, i) => (v.pass ? grid[i] : f), null as number | null);
    return {
      record: r.publicKey.toBase58(), modelId: r.account.modelId as string,
      pct: cells[0].pct, runs: cells[0].runs, items: cells[0].items,
      cells: cells.map((v) => (v.pass ? "pass" : v.reason === "no-evidence" ? "noev" : "fail")),
      frontier,
    };
  }).sort((a, b) => (b.frontier ?? -1) - (a.frontier ?? -1) || b.pct - a.pct);
  if (json) { console.log(JSON.stringify({ grid, rows })); return rows; }
  const parts = [
    base.minRuns !== undefined && `runs≥${base.minRuns}`,
    base.minItems !== undefined && `items≥${base.minItems}`,
    base.minWilsonPct !== undefined && `wilson≥${base.minWilsonPct}`,
    base.vouchedOnly && "vouched",
    base.noPostReveal && "no-post-reveal",
  ].filter(Boolean).join(" ");
  console.log(`gate --sweep${parts ? ` [${parts}]` : ""}${bank ? ` bank=${bank}` : ""} — who is robustly good, not just above one line:`);
  console.log(`  ${"model".padEnd(36)} ${"pct".padStart(6)}  ${grid.map((g) => String(g).padStart(3)).join("")}  frontier`);
  const glyph = (c: string) => (c === "pass" ? " ● " : c === "noev" ? " — " : " · ");
  for (const r of rows) {
    console.log(`  ${r.modelId.padEnd(36).slice(0, 36)} ${r.pct.toFixed(1).padStart(5)}% ${r.cells.map(glyph).join("")}  ${r.frontier === null ? "never passes" : `≥${r.frontier}%`}`);
  }
  const robust = rows.filter((r) => r.frontier !== null).length;
  const never = rows.length - robust;
  console.log(`  ${robust}/${rows.length} models clear at least the lowest bar${never ? ` · ${never} never pass (no evidence or below ${grid[0]}%)` : ""}` +
    ` — the strictest line a model survives is its frontier; receipts, not rhetoric.`);
  return rows;
}

/** `chain gate --all <policy> --cert <file>` — mint a `sealed-policy/v1`
 *  certificate: the policy itself plus every record's verdict AND the
 *  receipt evidence each verdict was computed from. A DAO vote, an
 *  insurer's underwriting memo, an admission decision — the artifact a
 *  resolver hands to whoever must be convinced, replayable keyless. */
export async function gateCert(policy: GatePolicy, out: string, snapPath?: string, bank?: string) {
  const ss = snapPath ? decodeSnapshotSection(loadSnapshotJson(snapPath), "sealed") : null;
  const acct = () => (sealedProgram().program.account as any);
  const [records, allLogs]: [SnapAccount[], SnapAccount[]] = ss
    ? [snapOf(ss, "ModelRecord"), snapOf(ss, "ScoreLog")]
    : await Promise.all([acct().modelRecord.all(), acct().scoreLog.all()]);
  const bankPks = bank
    ? new Set((ss ? snapOf(ss, "Benchmark") : await acct().benchmark.all())
        .filter((b: any) => b.publicKey.toBase58() === bank || b.account.name === bank)
        .map((b: any) => b.publicKey.toBase58()))
    : null;
  if (bank && !bankPks!.size) throw new Error(`no benchmark named/addressed ${bank}`);
  const logs = bankPks ? allLogs.filter((l) => bankPks.has((l.account.benchmark as PublicKey).toBase58())) : allLogs;
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const byRec = new Map<string, any[]>();
  for (const l of logs) {
    const k = (l.account.modelRecord as PublicKey).toBase58();
    const list = byRec.get(k) ?? [];
    list.push(l.account);
    byRec.set(k, list);
  }
  const modelHash = (id: string) => createHash("sha256").update(Buffer.from(id, "utf8")).digest("hex");
  const models = records.map((r) => {
    const raw = byRec.get(r.publicKey.toBase58()) ?? [];
    const receipts: ScoreReceipt[] = raw.map((a: any) => ({
      correct: num(a.correct), items: num(a.items),
      vouchedAtRecord: !!a.vouchedAtRecord, postReveal: !!a.postReveal,
    }));
    const v = evalGate(receipts, policy, true);
    return {
      modelId: String(r.account.modelId), recordPk: r.publicKey.toBase58(),
      seeds: { prefix: "modelrec", modelHash: modelHash(String(r.account.modelId)) },
      verdict: { pass: v.pass, reason: v.reason, pct: Math.round(v.pct * 100) / 100, runs: v.runs, items: v.items, correct: v.correct, postRevealRuns: v.postRevealRuns },
      receipts,
    };
  });
  const cert = {
    kind: "sealed-policy/v1",
    generatedAt: new Date().toISOString(),
    source: snapPath ?? "live",
    programs: { sealed: sealedProgramId().toBase58() },
    policy: { ...policy, bank: bank ?? null },
    models,
    summary: {
      records: models.length,
      pass: models.filter((m) => m.verdict.pass).length,
      noEvidence: models.filter((m) => m.verdict.reason === "no-evidence").length,
      fail: models.filter((m) => m.verdict.reason === "policy").length,
    },
  };
  writeFileSync(out, JSON.stringify(cert, null, 2) + "\n");
  console.log(`wrote ${out} — sealed-policy/v1 certificate: ${cert.summary.pass} pass / ${cert.summary.fail} fail / ${cert.summary.noEvidence} no-evidence of ${models.length} records (verify: chain gate --certify-verify ${out})`);
  return cert;
}

/** `chain gate --certify-verify <file>` — replay a sealed-policy/v1
 *  certificate keyless: every ModelRecord PDA re-derives from its
 *  declared modelHash seed, and evalGate re-run on the embedded receipts
 *  must reproduce every stored verdict bit-for-bit. */
export async function gateCertVerify(file: string, json = false) {
  const cert = JSON.parse(readFileSync(file, "utf8"));
  if (cert.kind !== "sealed-policy/v1") throw new Error(`not a sealed-policy/v1 file (kind=${cert.kind})`);
  const sealedId = new PublicKey(cert.programs.sealed);
  const policy: GatePolicy = {};
  const src = cert.policy ?? {};
  if (src.minPct !== undefined && src.minPct !== null) policy.minPct = src.minPct;
  if (src.minRuns !== undefined && src.minRuns !== null) policy.minRuns = src.minRuns;
  if (src.minItems !== undefined && src.minItems !== null) policy.minItems = src.minItems;
  if (src.minWilsonPct !== undefined && src.minWilsonPct !== null) policy.minWilsonPct = src.minWilsonPct;
  if (src.vouchedOnly) policy.vouchedOnly = true;
  if (src.noPostReveal) policy.noPostReveal = true;
  let pass = 0, fail = 0;
  const rows: { what: string; ok: boolean; detail: string }[] = [];
  const check = (what: string, ok: boolean, detail = "") => {
    rows.push({ what, ok, detail });
    if (!json) console.log(`  ${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
    ok ? pass++ : fail++;
  };
  let pdaOk = 0, verdictOk = 0;
  for (const m of cert.models as any[]) {
    const want = m.recordPk;
    const got = PublicKey.findProgramAddressSync(
      [Buffer.from("modelrec"), Buffer.from(m.seeds.modelHash, "hex")], sealedId)[0].toBase58();
    if (got === want) pdaOk++;
    const receipts: ScoreReceipt[] = (m.receipts as any[]).map((x) => ({
      correct: x.correct, items: x.items, vouchedAtRecord: x.vouchedAtRecord, postReveal: x.postReveal,
    }));
    const v = evalGate(receipts, policy, true);
    const w = m.verdict;
    if (v.pass === w.pass && v.reason === w.reason && Math.abs(v.pct - w.pct) <= 0.01 &&
        v.runs === w.runs && v.items === w.items && v.correct === w.correct && v.postRevealRuns === w.postRevealRuns)
      verdictOk++;
    else if (!json) console.log(`    ↳ ${m.modelId}: recomputed ${v.reason} ${v.pct.toFixed(2)}% (${v.correct}/${v.items}, ${v.runs} runs) vs stored ${w.reason} ${w.pct}% (${w.correct}/${w.items}, ${w.runs} runs)`);
  }
  check("record PDAs", pdaOk === cert.models.length, `${pdaOk}/${cert.models.length} re-derived from [modelrec, sha256(model_id)]`);
  check("verdict replay", verdictOk === cert.models.length, `${verdictOk}/${cert.models.length} verdicts recomputed from embedded receipts (pass/reason exact, pct within 0.01pp)`);
  const s = cert.summary;
  const recomp = { pass: (cert.models as any[]).filter((m) => m.verdict.pass).length,
    fail: (cert.models as any[]).filter((m) => m.verdict.reason === "policy").length,
    noEvidence: (cert.models as any[]).filter((m) => m.verdict.reason === "no-evidence").length };
  check("summary consistent", s.pass === recomp.pass && s.fail === recomp.fail && s.noEvidence === recomp.noEvidence,
    `${s.pass}/${s.fail}/${s.noEvidence} stored = ${recomp.pass}/${recomp.fail}/${recomp.noEvidence} recomputed`);
  if (json) console.log(JSON.stringify({ file, kind: cert.kind, models: cert.models.length, verified: fail === 0,
    checks: rows, pass, fail, summary: cert.summary }));
  else console.log(`${fail === 0 ? "CERT VERIFIED" : "CERT FAILED"} — ${cert.models.length} records, ${pass} checks pass, ${fail} fail`);
  if (fail) process.exitCode = 1;
  return { pass, fail };
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

/** `chain market live` — the BETTOR's board: every venue still accepting
 *  positions, soonest-close first, with the live book and a `chain market
 *  quote` hint per row. The keeper board asks "what needs a transaction";
 *  this asks "where can I still get one down". */
export async function marketLive(json = false, snapPath?: string) {
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const mAcct = () => (marketProgram().market.account as any);
  const sAcct = () => (sealedProgram().program.account as any);
  const [markets, darks, ladders, runs]: [SnapAccount[], SnapAccount[], SnapAccount[], SnapAccount[]] = sm
    ? [snapOf(sm, "Market"), snapOf(sm, "DarkMarket"), snapOf(sm, "Ladder"), snapOf(ss!, "Run")]
    : await Promise.all([tolerantAll(marketProgram().market as any, "market"), tolerantAll(marketProgram().market as any, "darkMarket"),
        tolerantAll(marketProgram().market as any, "ladder"), sAcct().run.all()]);
  const runBy = new Map(runs.map((r) => [r.publicKey.toBase58(), r.account]));
  const modelOf = (pk: any) => String(runBy.get(pk?.toBase58?.() ?? String(pk))?.modelId ?? "?");
  const num = (x: any) => Number(x ?? 0);
  const now = Math.floor(Date.now() / 1000);
  const in_ = (s: number, past: string) => s <= now ? past : s - now < 3600 ? `in ${Math.ceil((s - now) / 60)}m` : s - now < 86400 ? `in ${((s - now) / 3600).toFixed(1)}h` : `in ${((s - now) / 86400).toFixed(1)}d`;
  type Row = { pk: string; kind: string; q: string; pot: number; closesAt: number; resolveBy: number };
  const rows: Row[] = [];
  // "open" means open AND accepting — a closes_at that already passed can't
  // take a bet (the program rejects it); those are the keeper board's, not
  // the bettor's.
  const bettable = (a: any) => Number(a.status) === 0
    && (!num(a.closesAt) || num(a.closesAt) > now)
    && (!num(a.resolveBy) || num(a.resolveBy) > now);
  for (const m of markets) {
    const a = m.account;
    if (!bettable(a)) continue;
    const pot = (a.totals as any[]).reduce((s: number, t: any) => s + num(t), 0) / LAMPORTS_PER_SOL;
    const q = isDuel(a)
      ? `${modelOf(a.run)} vs ${modelOf(a.runB)} — who scores higher?`
      : `${modelOf(a.run)} — which of ${a.nOutcomes} band(s)?`;
    rows.push({ pk: m.publicKey.toBase58(), kind: isDuel(a) ? "duel" : "band", q, pot, closesAt: num(a.closesAt), resolveBy: num(a.resolveBy) });
  }
  for (const d of darks) {
    const a = d.account;
    if (!bettable(a)) continue;
    rows.push({ pk: d.publicKey.toBase58(), kind: "dark",
      q: `${modelOf(a.run)} — sealed positions, ${a.nOutcomes} bucket(s)`,
      pot: num(a.poolTotal) / LAMPORTS_PER_SOL, closesAt: num(a.closesAt), resolveBy: num(a.revealUntil) });
  }
  for (const l of ladders) {
    const a = l.account;
    if (!bettable(a)) continue;
    const legs = (a.legs as PublicKey[]).slice(0, Number(a.legCount));
    rows.push({ pk: l.publicKey.toBase58(), kind: "ladder",
      q: `ladder — ${legs.map((p) => modelOf(p)).join(" vs ")}`,
      pot: (a.totals as any[]).reduce((s: number, t: any) => s + num(t), 0) / LAMPORTS_PER_SOL,
      closesAt: num(a.closesAt), resolveBy: num(a.resolveBy) });
  }
  rows.sort((a, b) => (a.closesAt || 9e18) - (b.closesAt || 9e18));
  const out = { open: rows.length, venues: rows };
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`open venues — ${rows.length} accepting positions, soonest-close first`);
  for (const r of rows)
    console.log(`  ${r.kind.padEnd(7)} ${r.pk.slice(0, 12)}… ${r.q}` +
      `\n    book ${r.pot.toFixed(3)}◎ · bets close ${r.closesAt ? in_(r.closesAt, "now") : "—"} · expires ${r.resolveBy ? in_(r.resolveBy, "past expiry") : "—"}` +
      `\n    sealed chain market quote ${r.pk} <outcome> <lamports>`);
  return out;
}

/** `chain market sharps` — the bettor track record nobody else can show:
 *  aggregate every position across every venue kind, per wallet. Resolved
 *  positions only — a win is `payable`, a loss is `lost`/`forfeit`; refunds,
 *  live, and sealed positions are reported but never counted as results.
 *  Ranked two ways: Wilson 95% LCB on win-rate (a 1-0 can't outrank a 12-3)
 *  and realized P&L (est payout − staked, on resolved positions only —
 *  claimable ≠ realized but est is the settlement the account itself
 *  encodes, so it's the honest measure of what the bet would pay). */
export async function marketSharps(minResolved = 1, json = false, snapPath?: string) {
  let markets: SnapAccount[], ladders: SnapAccount[], darks: SnapAccount[],
      positions: SnapAccount[], darkPositions: SnapAccount[];
  if (snapPath) {
    const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
    [markets, ladders, darks, positions, darkPositions] =
      [snapOf(sm, "Market"), snapOf(sm, "Ladder"), snapOf(sm, "DarkMarket"), snapOf(sm, "Position"), snapOf(sm, "DarkPosition")];
  } else {
    const { market } = marketProgram();
    const mAcct = market.account as any;
    [markets, ladders, darks, positions, darkPositions] = await Promise.all([
      mAcct.market.all(), mAcct.ladder.all(), mAcct.darkMarket.all(),
      mAcct.position.all(), mAcct.darkPosition.all(),
    ]);
  }
  const { rows } = classifyPositions(positions, darkPositions, venueMapsOf(markets, ladders, darks), null);
  const agg = new Map<string, {
    w: number; l: number; refund: number; live: number; sealed: number; forfeit: number;
    staked: bigint; payable: bigint; liveStaked: bigint;
  }>();
  const acc = (b: string) => {
    let a = agg.get(b);
    if (!a) { a = { w: 0, l: 0, refund: 0, live: 0, sealed: 0, forfeit: 0, staked: 0n, payable: 0n, liveStaked: 0n }; agg.set(b, a); }
    return a;
  };
  for (const r of rows) {
    const a = acc(r.bettor);
    if (r.state === "payable") { a.w++; a.staked += r.risked ?? r.staked; a.payable += r.est; }
    else if (r.state === "lost") { a.l++; a.staked += r.risked ?? r.staked; }
    else if (r.state === "forfeit") { a.l++; a.forfeit++; a.staked += r.risked ?? r.staked; }
    else if (r.state === "refund") a.refund++;
    else if (r.state === "sealed") { a.sealed++; a.liveStaked += r.staked; }
    else { a.live++; a.liveStaked += r.staked; }
  }
  const all = [...agg.entries()].map(([bettor, a]) => {
    const resolved = a.w + a.l;
    const pnl = a.payable - a.staked;
    return { bettor, resolved, wins: a.w, losses: a.l, forfeits: a.forfeit,
      refunds: a.refund, live: a.live + a.sealed,
      staked: a.staked, payable: a.payable, pnl,
      liveStaked: a.liveStaked,
      lcb: resolved ? wilsonLowerBoundPct(a.w, resolved) : 0 };
  });
  const sharps = all.filter((s) => s.resolved >= minResolved);
  const bySkill = [...sharps].sort((a, b) => b.lcb - a.lcb || Number(b.pnl - a.pnl));
  const byMoney = [...sharps].sort((a, b) => Number(b.pnl - a.pnl));
  const book = {
    bettors: all.length,
    positions: rows.length,
    resolved: all.reduce((s, a) => s + a.resolved, 0),
    staked: all.reduce((s, a) => s + a.staked, 0n),
    payable: all.reduce((s, a) => s + a.payable, 0n),
    oneShot: all.filter((a) => a.resolved === 1 && !a.live).length,
    maxResolved: Math.max(0, ...all.map((a) => a.resolved)),
  };
  const out = { ...book, staked: book.staked.toString(), payable: book.payable.toString(), minResolved,
    byWinRate: bySkill.map((s) => ({ ...s, staked: s.staked.toString(), payable: s.payable.toString(), pnl: s.pnl.toString(), liveStaked: s.liveStaked.toString() })),
    byPnl: byMoney.map((s) => s.bettor) };
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`sharps — ${book.bettors} bettor(s) · ${book.positions} surviving position account(s) (${book.resolved} resolved) · ` +
    `${(Number(book.staked) / LAMPORTS_PER_SOL).toFixed(3)}◎ staked → ${(Number(book.payable) / LAMPORTS_PER_SOL).toFixed(3)}◎ payable`);
  console.log(`  scope — only unclaimed positions exist as accounts; exercised claims close their PDAs (see \`market escrow\` for the outflow)`);
  if (book.maxResolved <= 1 && book.resolved > 0) {
    console.log(`  every resolved position sits in a DISTINCT wallet — a ${book.oneShot}-bettor anonymity set`);
    console.log(`  zero observable track records: per-position keys are the book's real privacy posture`);
  }
  const fmt = (s: typeof sharps[number], i: number) =>
    `  ${String(i + 1).padStart(2)}. ${s.bettor.slice(0, 10)}… ${String(s.wins).padStart(2)}W-${String(s.losses).padEnd(2)}L` +
    `  LCB ${s.lcb.toFixed(0).padStart(3)}%  pnl ${(Number(s.pnl) / LAMPORTS_PER_SOL).toFixed(3).padStart(8)}◎` +
    `  (staked ${(Number(s.staked) / LAMPORTS_PER_SOL).toFixed(3)} → ${(Number(s.payable) / LAMPORTS_PER_SOL).toFixed(3)})` +
    `${s.forfeits ? ` · ${s.forfeits} forfeited` : ""}${s.live ? ` · ${s.live} live` : ""}${s.refunds ? ` · ${s.refunds} refunded` : ""}`;
  if (book.maxResolved > 1) {
    console.log(`  repeat bettors (≥${Math.max(2, minResolved)} resolved) — ranked by Wilson 95% LCB:`);
    const top = bySkill.slice(0, 15);
    top.forEach((s, i) => console.log(fmt(s, i)));
    if (bySkill.length > top.length) console.log(`  … ${bySkill.length - top.length} more (use --json for the full table)`);
  }
  const winners = [...sharps].filter((s) => s.payable > 0n).sort((a, b) => Number(b.payable - a.payable)).slice(0, 3);
  const losers = byMoney.filter((s) => s.pnl < 0n).slice(-3).reverse();
  const netPos = sharps.filter((s) => s.pnl > 0n).length;
  if (winners.length) {
    console.log(`  biggest payouts:`);
    winners.forEach((s) => console.log(`    ${(Number(s.payable) / LAMPORTS_PER_SOL).toFixed(3)}◎ paid — ${s.bettor.slice(0, 10)}… (${(Number(s.staked) / LAMPORTS_PER_SOL).toFixed(3)}◎ at risk → pnl ${(Number(s.pnl) / LAMPORTS_PER_SOL).toFixed(3)})`));
  }
  console.log(`  net verdict — ${netPos} of ${sharps.filter((s) => s.resolved > 0).length} surviving resolved bettor(s) stand positive ` +
    `(winners claim and close; losers' rent-return claims linger — the survivor bias is the finding)`);
  if (losers.length) {
    console.log(`  deepest red:`);
    losers.forEach((s) => console.log(`    ${(Number(s.pnl) / LAMPORTS_PER_SOL).toFixed(3)}◎ — ${s.bettor.slice(0, 10)}… (${s.wins}W-${s.losses}L)`));
  }
  return out;
}

/** `chain market escrow` — the lamport ledger: every stake tracked by its
 *  obligation bucket. Positions are unclosed claims (the program closes a
 *  Position PDA on payout), so each surviving Position account IS an
 *  outstanding obligation; closed ones are settled outflow. Resolved
 *  venues whose winning bucket went unbacked hold a pot NO instruction can
 *  move — dead money by design, reported honestly instead of hidden. */
/** `chain market unclaimed` — the owed-money ledger: every position the
 *  chain owes a payout or refund to, grouped by bettor, with per-position
 *  estimates. The actionable mirror of `market escrow` — escrow counts
 *  obligations by venue; this names who can collect how much. */
export async function marketUnclaimed(json = false, snapPath?: string) {
  let markets: SnapAccount[], ladders: SnapAccount[], darks: SnapAccount[],
      positions: SnapAccount[], darkPositions: SnapAccount[];
  if (snapPath) {
    const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
    [markets, ladders, darks, positions, darkPositions] =
      [snapOf(sm, "Market"), snapOf(sm, "Ladder"), snapOf(sm, "DarkMarket"), snapOf(sm, "Position"), snapOf(sm, "DarkPosition")];
  } else {
    const { market } = marketProgram();
    const mAcct = market.account as any;
    [markets, ladders, darks, positions, darkPositions] = await Promise.all([
      mAcct.market.all(), mAcct.ladder.all(), mAcct.darkMarket.all(),
      mAcct.position.all(), mAcct.darkPosition.all(),
    ]);
  }
  const { rows } = classifyPositions(positions, darkPositions, venueMapsOf(markets, ladders, darks), null);
  // winners + refundable; losing positions still return rent but aren't "owed".
  const owed = rows.filter((r) => r.state === "payable" || r.state === "refund");
  const byBettor = new Map<string, { payouts: bigint; refunds: bigint; rows: PosRow[] }>();
  for (const r of owed) {
    const a = byBettor.get(r.bettor) ?? { payouts: 0n, refunds: 0n, rows: [] };
    if (r.state === "payable") a.payouts += r.est; else a.refunds += r.est;
    a.rows.push(r);
    byBettor.set(r.bettor, a);
  }
  const totPay = owed.filter((r) => r.state === "payable").reduce((s, r) => s + r.est, 0n);
  const totRef = owed.filter((r) => r.state === "refund").reduce((s, r) => s + r.est, 0n);
  const out = {
    positions: owed.length,
    payableLamports: totPay.toString(), refundLamports: totRef.toString(),
    payableSol: Number(totPay) / 1e9, refundSol: Number(totRef) / 1e9,
    bettors: [...byBettor.entries()].map(([b, a]) => ({ bettor: b, positions: a.rows.length,
      payableSol: Number(a.payouts) / 1e9, refundSol: Number(a.refunds) / 1e9 }))
      .sort((x, y) => y.payableSol - x.payableSol || y.refundSol - x.refundSol),
  };
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`unclaimed money — ${owed.length} positions the chain still owes (${out.payableSol.toFixed(3)}◎ payouts + ${out.refundSol.toFixed(3)}◎ refunds):`);
  for (const b of out.bettors.slice(0, 15))
    console.log(`  ${b.bettor.slice(0, 12)}… ${b.positions} position(s) · ${b.payableSol.toFixed(3)}◎ winnings${b.refundSol ? ` + ${b.refundSol.toFixed(3)}◎ refunds` : ""}`);
  const top = owed.filter((r) => r.state === "payable").sort((a, b) => (a.est < b.est ? 1 : -1)).slice(0, 8);
  if (top.length) {
    console.log(`  largest single claims:`);
    for (const r of top)
      console.log(`    ${solAmt(r.est)} SOL ← ${r.bettor.slice(0, 12)}… on ${r.kind} ${r.pk.slice(0, 12)}… — ${r.note}`);
  }
  return out;
}

export async function marketEscrow(json = false, snapPath?: string) {
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  let markets: SnapAccount[], ladders: SnapAccount[], darks: SnapAccount[],
      positions: SnapAccount[], darkPositions: SnapAccount[], bounties: SnapAccount[];
  if (snapPath) {
    const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
    [markets, ladders, darks, positions, darkPositions, bounties] =
      [snapOf(sm, "Market"), snapOf(sm, "Ladder"), snapOf(sm, "DarkMarket"), snapOf(sm, "Position"), snapOf(sm, "DarkPosition"), snapOf(sm, "Bounty")];
  } else {
    const { market } = marketProgram();
    const mAcct = market.account as any;
    [markets, ladders, darks, positions, darkPositions, bounties] = await Promise.all([
      mAcct.market.all(), mAcct.ladder.all(), mAcct.darkMarket.all(),
      mAcct.position.all(), mAcct.darkPosition.all(), mAcct.bounty.all(),
    ]);
  }
  const { rows } = classifyPositions(positions, darkPositions, venueMapsOf(markets, ladders, darks), null);
  const owedWinners = rows.filter((r) => r.state === "payable").reduce((s, r) => s + r.est, 0n);
  const owedRefunds = rows.filter((r) => r.state === "refund").reduce((s, r) => s + r.staked, 0n);
  const inPlayPos = rows.filter((r) => r.state === "live" || r.state === "sealed").reduce((s, r) => s + r.staked, 0n);
  const potOf = (totals: any[]) => totals.reduce((s: bigint, t: any) => s + BigInt(t.toString()), 0n);
  const netOf = (pot: bigint, feeBps: number) => pot - (pot * BigInt(feeBps)) / 10000n;
  let inPlay = 0n, dead = 0n, dust = 0n, contingent = 0n, fees = 0n, claimedOut = 0n;
  const deadVenues: { pk: string; kind: string; pot: bigint }[] = [];
  const perVenue = new Map<string, bigint>();
  for (const r of rows) if (r.state === "payable") perVenue.set(r.pk, (perVenue.get(r.pk) ?? 0n) + r.est);
  const bandLike = [...markets.map((m) => ({ ...m, kind: "band/duel" as const })), ...ladders.map((l) => ({ ...l, kind: "ladder" as const }))];
  for (const v of bandLike) {
    const a = v.account;
    const pot = potOf(a.totals as any[]);
    fees += BigInt(a.feesAccrued.toString());
    if (Number(a.status) === 0) { inPlay += pot; continue; }
    if (Number(a.status) === 2) continue; // cancelled — pot is refund obligations, counted via positions
    // resolved: winners split the net pot. winTotal==0 → provably stranded
    // (no instruction can move it); winTotal>0 leftover = winners whose
    // position PDAs already closed on claim — settled outflow, not dead.
    const winTotal = v.kind === "ladder"
      ? (a.totals as any[]).reduce((s: bigint, t: any, i: number) => s + ((num(a.resultMask) & (1 << i)) ? BigInt(t.toString()) : 0n), 0n)
      : BigInt(((a.totals as any[])[num(a.outcome)] ?? 0).toString());
    const net = netOf(pot, num(a.feeBps));
    if (winTotal === 0n) { dead += net; deadVenues.push({ pk: v.publicKey.toBase58(), kind: v.kind, pot: net }); continue; }
    const owed = perVenue.get(v.publicKey.toBase58()) ?? 0n;
    const leftover = net - owed;
    if (leftover > 1000n) claimedOut += leftover;
    else if (leftover > 0n) dust += leftover;
  }
  for (const d of darks) {
    const a = d.account;
    const pool = BigInt(a.poolTotal.toString());
    fees += BigInt(a.feesAccrued.toString());
    if (Number(a.status) === 0) { inPlay += pool; continue; }
    if (Number(a.status) === 2) continue;
    if (!a.tallied) { contingent += pool; continue; }
    const net = netOf(pool, num(a.feeBps));
    const winTotal = BigInt(a.winTotal.toString());
    if (winTotal === 0n) { dead += net; deadVenues.push({ pk: d.publicKey.toBase58(), kind: "dark", pot: net }); continue; }
    const owed = perVenue.get(d.publicKey.toBase58()) ?? 0n;
    const leftover = net - owed;
    if (leftover > 1000n) claimedOut += leftover;
    else if (leftover > 0n) dust += leftover;
  }
  const now = Math.floor(Date.now() / 1000);
  let bountyOpen = 0n, bountyExpired = 0n, bountyCount = 0, expiredCount = 0;
  for (const b of bounties) {
    const a = b.account;
    if (Number(a.status) !== 0) continue;
    const amt = BigInt(a.amount.toString());
    if (num(a.deadline) > 0 && num(a.deadline) <= now) { bountyExpired += amt; expiredCount++; }
    else { bountyOpen += amt; bountyCount++; }
  }
  const cumulative = bandLike.reduce((s, v) => s + potOf(v.account.totals as any[]), 0n)
    + darks.reduce((s, d) => s + BigInt(d.account.poolTotal.toString()), 0n)
    + bounties.reduce((s, b) => s + BigInt(b.account.amount.toString()), 0n);
  // The balancing line: cumulative stakes are recorded on surviving venue
  // accounts even after their pots pay out (totals double as audit record),
  // so the residual plus claimedOut is lamports that already left escrow —
  // exercised winner claims, claimed refunds, collected fees.
  const settledOut = cumulative - inPlay - owedWinners - owedRefunds - fees - contingent - dead - dust - bountyOpen - bountyExpired;
  const out = {
    cumulativeStaked: cumulative.toString(), settledOut: settledOut.toString(),
    inPlay: inPlay.toString(), positionsInPlay: inPlayPos.toString(),
    owedWinners: owedWinners.toString(), owedRefunds: owedRefunds.toString(),
    feesAccrued: fees.toString(), contingent: contingent.toString(),
    dead: dead.toString(), dust: dust.toString(),
    deadVenues: deadVenues.map((v) => ({ ...v, pot: v.pot.toString() })),
    bountyOpen: bountyOpen.toString(), bountyExpired: bountyExpired.toString(),
    openBounties: bountyCount, expiredBounties: expiredCount,
    claimedWinnerPots: claimedOut.toString(),
  };
  if (json) { console.log(JSON.stringify(out)); return out; }
  const S = (v: bigint) => (Number(v) / LAMPORTS_PER_SOL).toFixed(4);
  console.log(`market escrow — ${S(cumulative)}◎ cumulative stakes tracked across ${bandLike.length + darks.length} venues + ${bounties.length} bounties`);
  console.log(`  in play        ${S(inPlay)}◎ — open venues, positions live or sealed`);
  console.log(`  owed winners   ${S(owedWinners)}◎ — resolved, claims unexercised (position PDAs still open)`);
  console.log(`  refunds owed   ${S(owedRefunds)}◎ — cancelled venues, gross refunds unclaimed`);
  console.log(`  fees accrued   ${S(fees)}◎ — resolved venues, authority fee unclaimed`);
  if (contingent > 0n) console.log(`  contingent     ${S(contingent)}◎ — dark pools mid reveal-window, tally pending`);
  console.log(`  bounty escrow  ${S(bountyOpen + bountyExpired)}◎ — ${bountyCount} live pots${expiredCount ? ` · ${expiredCount} past deadline (sponsor-refundable)` : ""}`);
  console.log(`  dead money     ${S(dead + dust)}◎ — resolved pots whose winning bucket went unbacked; no instruction can move them`);
  deadVenues.sort((a, b) => Number(b.pot - a.pot));
  deadVenues.slice(0, 5).forEach((v) => console.log(`    ${(Number(v.pot) / LAMPORTS_PER_SOL).toFixed(4)}◎ — ${v.kind} ${v.pk.slice(0, 12)}…`));
  if (deadVenues.length > 5) console.log(`    … ${deadVenues.length - 5} more dead venues`);
  console.log(`  settled out    ${S(settledOut)}◎ — exercised claims + collected fees + refunds paid (of which ${S(claimedOut)}◎ winner pots)`);
  const recomposed = inPlay + owedWinners + owedRefunds + fees + contingent + dead + dust + bountyOpen + bountyExpired + settledOut;
  console.log(`  check          ${S(recomposed)}◎ = cumulative — ledger ${recomposed === cumulative ? "balances exactly" : `MISMATCH by ${S(recomposed - cumulative)}`}`);
  return out;
}

/** `chain anomalies` — the skeptic's checklist: every weakness a hostile
 *  auditor could raise against THIS evidence bundle, enumerated with the
 *  drill-in command. Findings get a severity and, where the answer is
 *  "clean", the check still prints — absence of anomalies is itself
 *  evidence. An anti-fragile surface: the project's strongest claim is
 *  that it can list its own soft spots. */
export async function chainAnomalies(json = false, snapPath?: string) {
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const snap = snapPath ? loadSnapshotJson(snapPath) : null;
  const ss = snap ? decodeSnapshotSection(snap, "sealed") : null;
  const sm = snap ? decodeSnapshotSection(snap, "market") : null;
  const [banks, runs, logs, records, reveals]: SnapAccount[][] =
    ss ? ["Benchmark", "Run", "ScoreLog", "ModelRecord", "Reveal"].map((n) => snapOf(ss, n))
       : await Promise.all(["benchmark", "run", "scoreLog", "modelRecord", "reveal"]
          .map((n) => (sealedProgram().program.account as any)[n].all()));
  const [markets, darks, ladders, bounties, positions, darkPositions]: SnapAccount[][] =
    sm ? ["Market", "DarkMarket", "Ladder", "Bounty", "Position", "DarkPosition"].map((n) => snapOf(sm, n))
       : await Promise.all(["market", "darkMarket", "ladder", "bounty", "position", "darkPosition"]
          .map((n) => (marketProgram().market.account as any)[n].all()));
  const now = Math.floor(Date.now() / 1000);
  type Finding = { sev: "warn" | "info" | "ok"; what: string; count: number; detail: string; drill: string };
  const f: Finding[] = [];

  // 1. post-reveal evidence — runs scored after their bank's answers went public
  const postRuns = runs.filter((r) => r.account.postReveal);
  const postLogs = logs.filter((l) => l.account.postReveal);
  f.push({ sev: postRuns.length ? "warn" : "ok", what: "post-reveal evidence",
    count: postRuns.length,
    detail: postRuns.length
      ? `${postRuns.length} run(s) scored after fingerprint reveals — flagged on-chain, refused by markets, excludable via gate --no-post-reveal`
      : "no run was scored after its answers were public",
    drill: "chain runs --post-reveal · flags show on every row" });

  // 1b. collapsible records — every receipt post-reveal: under a strict
  // --no-post-reveal policy these models have NO surviving evidence at all
  const preLogs = logs.filter((l) => !l.account.postReveal);
  const withPre = new Set(preLogs.map((l) => (l.account.modelRecord as PublicKey).toBase58()));
  const withAny = new Set(logs.map((l) => (l.account.modelRecord as PublicKey).toBase58()));
  const collapsible = records.filter((r) =>
    withAny.has(r.publicKey.toBase58()) && !withPre.has(r.publicKey.toBase58()));
  f.push({ sev: collapsible.length ? "warn" : "ok", what: "records that collapse under --no-post-reveal",
    count: collapsible.length,
    detail: collapsible.length
      ? `${collapsible.length} record(s) lose EVERY receipt under a strict pre-reveal policy (${collapsible.map((r) => r.account.modelId).slice(0, 4).join(", ")}${collapsible.length > 4 ? "…" : ""}) — their entire evidence postdates answer exposure`
      : "every record keeps at least one pre-reveal receipt — no evidence is entirely post-reveal",
    drill: "chain gate --all --no-post-reveal --min-runs 1 · chain runs --post-reveal" });

  // 2. stuck-pending runs — queued, never finalized (callback-outage casualties)
  const stuck = runs.filter((r) => Number(r.account.status) === 0 && num(r.account.createdAt) > 0 && now - num(r.account.createdAt) > 7 * 86400);
  f.push({ sev: stuck.length ? "info" : "ok", what: "stuck-pending runs",
    count: stuck.length,
    detail: stuck.length
      ? `${stuck.length} run(s) queued >7d without finalizing — honest scar tissue of the Arcium callback outage; pending forever, never claimed as evidence`
      : "no run has sat pending over a week",
    drill: "chain runs --status pending" });

  // 3. thin records — high pct on few runs (the registry's own honesty)
  const thin = records.filter((r) => {
    const a = r.account;
    const n = num(a.totalItems), c = num(a.totalCorrect);
    return n > 0 && n < 64 && c / n > 0.85;
  });
  f.push({ sev: "info", what: "thin records (>85% on <64 items)",
    count: thin.length,
    detail: thin.length
      ? `${thin.length} record(s) look strong on little evidence — Wilson LCB ranking exists precisely for this (records --wilson)`
      : "every high-accuracy record carries ≥64 scored items",
    drill: "chain records --wilson" });

  // 4. dead money — resolved venues whose winning bucket went unbacked
  const { rows: posRows } = classifyPositions(positions, darkPositions, venueMapsOf(markets, ladders, darks), null);
  let dead = 0n;
  for (const v of [...markets, ...ladders]) {
    const a = v.account;
    if (Number(a.status) !== 1) continue;
    const totals = (a.totals as any[]).map((t) => BigInt(t.toString()));
    const wt = a.resultMask !== undefined
      ? totals.reduce((s, t, i) => s + ((num(a.resultMask) & (1 << i)) ? t : 0n), 0n)
      : totals[num(a.outcome)] ?? 0n;
    if (wt === 0n) dead += totals.reduce((s, t) => s + t, 0n);
  }
  for (const d of darks) if (Number(d.account.status) === 1 && d.account.tallied && BigInt(d.account.winTotal.toString()) === 0n) dead += BigInt(d.account.poolTotal.toString());
  f.push({ sev: dead > 0n ? "warn" : "ok", what: "dead money (unbacked winning buckets)",
    count: Number(dead),
    detail: dead > 0n
      ? `${(Number(dead) / LAMPORTS_PER_SOL).toFixed(4)}◎ stranded in venues no instruction can drain`
      : "every resolved venue's winning bucket was backed — zero stranded pots",
    drill: "chain market escrow" });

  // 5b. unclaimed payouts — winners who haven't collected (money asleep)
  const unclaimed = posRows.filter((r) => r.state === "payable");
  const unclaimedLam = unclaimed.reduce((s, r) => s + r.est, 0n);
  f.push({ sev: "info", what: "unclaimed payouts",
    count: unclaimed.length,
    detail: unclaimed.length
      ? `${unclaimed.length} winning position(s) hold ${solAmt(unclaimedLam)} SOL in unexercised claims — open PDAs are the claim`
      : "every owed position has been collected",
    drill: "chain market unclaimed" });

  // 5. forfeited dark stakes — never revealed, burned into the pool
  const forfeits = posRows.filter((r) => r.state === "forfeit");
  f.push({ sev: forfeits.length ? "info" : "ok", what: "forfeited dark positions",
    count: forfeits.length,
    detail: forfeits.length
      ? `${forfeits.length} sealed position(s) never revealed — stakes burned into the pot (the commit-reveal tax, by design)`
      : "every sealed position revealed in its window",
    drill: "chain market positions --viewer <pk>" });

  // 6. expired-but-open bounties — sponsor money asleep past deadline
  const expB = bounties.filter((b) => Number(b.account.status) === 0 && num(b.account.deadline) > 0 && num(b.account.deadline) <= now);
  f.push({ sev: expB.length ? "info" : "ok", what: "past-deadline bounties awaiting expire",
    count: expB.length,
    detail: expB.length
      ? `${expB.length} bounty pot(s) past deadline — sponsor-refundable via permissionless expire_bounty`
      : "no bounty sits past its deadline",
    drill: "chain market board" });

  // 7. duplicate bank names — identity ambiguity a skeptic could exploit
  const names = new Map<string, number>();
  for (const b of banks) names.set(String(b.account.name), (names.get(String(b.account.name)) ?? 0) + 1);
  const dupes = [...names.values()].filter((n) => n > 1).reduce((s, n) => s + n, 0);
  f.push({ sev: "info", what: "duplicate bank names",
    count: dupes,
    detail: dupes
      ? `${dupes} banks share names — resolvers fan out to ALL matches and matrix columns disambiguate by on-chain id`
      : "every bank name is unique",
    drill: "chain banks --name <name>" });

  // 8. markets on post-reveal runs — must be ZERO (program enforces)
  const postSet = new Set(postRuns.map((r) => r.publicKey.toBase58()));
  const badVenues = [...markets, ...darks].filter((m) => postSet.has(m.account.run.toBase58())).length
    + ladders.filter((l) => (l.account.legs as PublicKey[]).slice(0, Number(l.account.legCount)).some((p) => postSet.has(p.toBase58()))).length;
  f.push({ sev: badVenues ? "warn" : "ok", what: "venues on post-reveal runs",
    count: badVenues,
    detail: badVenues ? `${badVenues} venue(s) priced post-reveal evidence — PostRevealRun gate violated!` : "program-level refusal holds — zero venues touch post-reveal runs",
    drill: "chain feed --bank <bank>" });

  // 9. single-runner banks — one key wrote every score (self-attestation)
  const byBank = new Map<string, Set<string>>();
  for (const r of runs) {
    const k = r.account.benchmark.toBase58();
    (byBank.get(k) ?? byBank.set(k, new Set()).get(k)!).add(r.account.runner.toBase58());
  }
  const bankByPk = new Map(banks.map((b) => [b.publicKey.toBase58(), b.account]));
  const solo = [...byBank.entries()].filter(([pk, s]) => s.size === 1 && num((bankByPk.get(pk) as any)?.runs) >= 3);
  f.push({ sev: "info", what: "single-runner banks (≥3 runs, one key)",
    count: solo.length,
    detail: solo.length
      ? `${solo.length} bank(s) were scored entirely by one runner key — receipt-level honesty holds, runner diversity does not`
      : "every multi-run bank has runner diversity",
    drill: "chain bank <pk>" });

  // 10. empty resolved books — venues that settled with zero stake (meaningless)
  const empty = [...markets, ...ladders].filter((v) => Number(v.account.status) === 1
    && (v.account.totals as any[]).every((t) => BigInt(t.toString()) === 0n));
  f.push({ sev: "info", what: "resolved venues with empty books",
    count: empty.length,
    detail: empty.length
      ? `${empty.length} venue(s) resolved holding zero stake — settlement still re-verifies, but they priced nothing`
      : "every resolved venue carried real stake",
    drill: "chain market calibration" });

  const order = { warn: 0, info: 1, ok: 2 } as const;
  f.sort((a, b) => order[a.sev] - order[b.sev]);
  const out = { findings: f, warn: f.filter((x) => x.sev === "warn").length, info: f.filter((x) => x.sev === "info").length, clean: f.filter((x) => x.sev === "ok").length };
  if (json) { console.log(JSON.stringify(out)); return out; }
  console.log(`anomalies — the skeptic's checklist · ${out.warn} warn · ${out.info} info · ${out.clean} clean`);
  for (const x of f) {
    const tag = x.sev === "warn" ? "WARN" : x.sev === "info" ? "note" : " ok ";
    console.log(`  [${tag}] ${x.what} — ${x.count ? x.count : "none"}`);
    console.log(`         ${x.detail}`);
    console.log(`         drill → ${x.drill}`);
  }
  return out;
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

const numField = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
const solAmt = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);
type VenueMaps = { mk: Map<string, any>; lk: Map<string, any>; dk: Map<string, any> };
export type PosRow = { pk: string; kind: string; state: "payable" | "refund" | "lost" | "live" | "sealed" | "forfeit"; staked: bigint; est: bigint; note: string; posPk?: string; bettor: string; risked?: bigint };

function venueMapsOf(markets: SnapAccount[], ladders: SnapAccount[], darks: SnapAccount[]): VenueMaps {
  const num = numField;
  return {
    mk: new Map(markets.map((x: any) => [x.publicKey.toBase58(), { pk: x.publicKey.toBase58(), kind: isDuel(x.account) ? "duel" : "band", status: x.account.status as number, outcome: x.account.outcome as number, totals: (x.account.totals as any[]).map((t) => BigInt(t.toString())), feeBps: num(x.account.feeBps) }])),
    lk: new Map(ladders.map((x: any) => [x.publicKey.toBase58(), { pk: x.publicKey.toBase58(), kind: "ladder", status: x.account.status as number, mask: x.account.resultMask as number, totals: (x.account.totals as any[]).map((t) => BigInt(t.toString())), feeBps: num(x.account.feeBps) }])),
    dk: new Map(darks.map((x: any) => [x.publicKey.toBase58(), { pk: x.publicKey.toBase58(), kind: "dark", status: x.account.status as number, outcome: x.account.outcome as number, poolTotal: BigInt(x.account.poolTotal.toString()), winTotal: BigInt(x.account.winTotal.toString()), feeBps: num(x.account.feeBps), tallied: !!x.account.tallied }])),
  };
}

/** Payout classification for a set of positions against venue maps. `me`
 *  is the bettor base58 filter — pass null for "all bettors" (the venue
 *  book view). Position-scoped filtering happens upstream by passing a
 *  single-element positions array. */
function classifyPositions(positions: SnapAccount[], darkPositions: SnapAccount[], maps: VenueMaps, me: string | null): { rows: PosRow[] } {
  const { mk, lk, dk } = maps;
  const rows: PosRow[] = [];
  const netOf = (totals: bigint[], feeBps: number) => {
    const pot = totals.reduce((s, t) => s + t, 0n);
    return pot - (pot * BigInt(feeBps)) / 10000n;
  };
  for (const p of positions) {
    if (me !== null && p.account.bettor.toBase58() !== me) continue;
    const amounts = (p.account.amounts as any[]).map((a) => BigInt(a.toString()));
    const staked = amounts.reduce((s, a) => s + a, 0n);
    const venuePk = p.account.market.toBase58();
    const v = mk.get(venuePk) ?? lk.get(venuePk);
    if (!v) continue;
    if (v.status === 2) { rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: v.kind, state: "refund", staked, est: staked, note: "cancelled — gross refund" }); continue; }
    if (v.status !== 1) { rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: v.kind, state: "live", staked, est: 0n, note: "open — in play" }); continue; }
    if (v.kind === "ladder") {
      const mask = (v as any).mask as number;
      const won = amounts.reduce((s, a, i) => s + ((mask & (1 << i)) ? a : 0n), 0n);
      const winTotal = (v as any).totals.reduce((s: bigint, t: bigint, i: number) => s + ((mask & (1 << i)) ? t : 0n), 0n);
      const est = won > 0n && winTotal > 0n ? (won * netOf((v as any).totals, v.feeBps)) / winTotal : 0n;
      rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: "ladder", state: won > 0n ? "payable" : "lost", staked: won > 0n ? won : staked, risked: staked, est, note: won > 0n ? `mask 0b${mask.toString(2)} — pro-rata` : "resolved against you — claim returns rent" });
    } else {
      const won = amounts[(v as any).outcome] ?? 0n;
      const winTotal = (v as any).totals[(v as any).outcome] ?? 0n;
      const est = won > 0n && winTotal > 0n ? (won * netOf((v as any).totals, v.feeBps)) / winTotal : 0n;
      rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: v.kind, state: won > 0n ? "payable" : "lost", staked: won > 0n ? won : staked, risked: staked, est, note: won > 0n ? `outcome ${(v as any).outcome} — pro-rata` : "resolved against you — claim returns rent" });
    }
  }
  for (const p of darkPositions) {
    if (me !== null && p.account.bettor.toBase58() !== me) continue;
    const amount = BigInt(p.account.amount.toString());
    const revealed = p.account.revealed as number;
    const venuePk = p.account.market.toBase58();
    const v = dk.get(venuePk);
    if (!v) continue;
    if (v.status === 2) { rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: "dark", state: "refund", staked: amount, est: amount, note: "cancelled — gross refund" }); continue; }
    if (v.status === 0) { rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: "dark", state: "sealed", staked: amount, est: 0n, note: "position still sealed" }); continue; }
    if (!v.tallied) { rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: "dark", state: "live", staked: amount, est: 0n, note: revealed === 255 ? "resolved — reveal or forfeit" : "resolved — awaiting tally" }); continue; }
    if (revealed === 255) { rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: "dark", state: "forfeit", staked: amount, risked: amount, est: 0n, note: "never revealed — forfeited into the pot" }); continue; }
    if (revealed !== v.outcome || v.winTotal === 0n) { rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: "dark", state: "lost", staked: amount, risked: amount, est: 0n, note: `revealed ${revealed}, outcome ${v.outcome} — claim returns rent` }); continue; }
    const est = (amount * (v.poolTotal - (v.poolTotal * BigInt(v.feeBps)) / 10000n)) / v.winTotal;
    rows.push({ pk: venuePk, posPk: p.publicKey.toBase58(), bettor: p.account.bettor.toBase58(), kind: "dark", state: "payable", staked: amount, risked: amount, est, note: `revealed winner — pro-rata of ${solAmt(v.poolTotal)} SOL pool` });
  }
  return { rows };
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
  const maps = venueMapsOf(markets, ladders, darks);
  const { rows } = classifyPositions(positions, darkPositions, maps, me);
  if (json) { console.log(JSON.stringify(rows, (k, x) => typeof x === "bigint" ? x.toString() : x)); return rows; }
  const order = { payable: 0, refund: 1, live: 2, sealed: 3, lost: 4, forfeit: 5 } as const;
  rows.sort((a, b) => order[a.state] - order[b.state]);
  console.log(`positions — ${rows.length} held by ${me.slice(0, 8)}… across ${maps.mk.size + maps.lk.size + maps.dk.size} venues`);
  for (const r of rows) {
    const tag = { payable: "PAYS", refund: "REFUND", live: "LIVE", sealed: "SEALED", lost: "RENT", forfeit: "FORFEIT" }[r.state];
    console.log(`  ${tag.padEnd(7)} ${r.kind.padEnd(6)} ${r.pk}  staked ${solAmt(r.staked)}${r.est > 0n ? ` → ~${solAmt(r.est)}` : ""} SOL  ${r.note}`);
  }
  const due = rows.filter((r) => r.state === "payable" || r.state === "refund");
  if (due.length) {
    console.log(`\nclaim now (${due.length}):`);
    for (const r of due) console.log(`  sealed chain market ${r.kind === "ladder" ? "ladder claim" : r.kind === "dark" ? "dark claim --pos-salt <your-salt>" : "claim"} --market ${r.pk}${r.kind === "dark" ? "  # pos_salt is a seed — use the value from your bet" : ""}`);
  }
  return rows;
}

/** `chain market position <pk>` — the bettor's dossier for ONE position:
 *  the commitment itself (amounts per bucket / sealed dark commitment),
 *  the venue it rides on, and the same payable/lost/forfeit classification
 *  `positions` computes — plus the exact claim command when money is due. */
export async function marketPosition(pkStr: string, json = false, snapPath?: string) {
  const pk = new PublicKey(pkStr);
  let markets: SnapAccount[], ladders: SnapAccount[], darks: SnapAccount[],
      positions: SnapAccount[], darkPositions: SnapAccount[];
  if (snapPath) {
    const sm = decodeSnapshotSection(loadSnapshotJson(snapPath), "market");
    [markets, ladders, darks, positions, darkPositions] =
      [snapOf(sm, "Market"), snapOf(sm, "Ladder"), snapOf(sm, "DarkMarket"), snapOf(sm, "Position"), snapOf(sm, "DarkPosition")];
  } else {
    const { market } = marketProgram();
    const mAcct = market.account as any;
    [markets, ladders, darks, positions, darkPositions] = await Promise.all([
      mAcct.market.all(), mAcct.ladder.all(), mAcct.darkMarket.all(),
      mAcct.position.all(), mAcct.darkPosition.all(),
    ]);
  }
  const pos = positions.find((x) => x.publicKey.equals(pk));
  const dpos = darkPositions.find((x) => x.publicKey.equals(pk));
  if (!pos && !dpos) {
    console.log(`position ${pkStr} not found (checked Position + DarkPosition)`);
    process.exitCode = 2;
    return null;
  }
  const bettor = (pos ?? dpos)!.account.bettor.toBase58();
  const maps = venueMapsOf(markets, ladders, darks);
  const { rows } = classifyPositions(pos ? [pos] : [], dpos ? [dpos] : [], maps, bettor);
  const row = rows[0];
  const venuePk = (pos ?? dpos)!.account.market.toBase58();
  const venue = maps.mk.get(venuePk) ?? maps.lk.get(venuePk) ?? maps.dk.get(venuePk);
  const doc = {
    position: pkStr, kind: row?.kind ?? (pos ? "band/duel" : "dark"), bettor, venue: venuePk,
    state: row?.state ?? "unknown", staked: row ? row.staked.toString() : "0",
    estPayout: row ? row.est.toString() : "0", note: row?.note ?? "venue account missing",
    amounts: pos ? (pos.account.amounts as any[]).map((a) => a.toString()) : undefined,
    commitment: dpos ? Buffer.from(dpos.account.commitment as number[]).toString("hex") : undefined,
    revealed: dpos ? (dpos.account.revealed as number) : undefined,
    venueStatus: venue ? { status: venue.status, outcome: (venue as any).outcome, mask: (venue as any).mask, feeBps: venue.feeBps } : undefined,
  };
  if (json) { console.log(JSON.stringify(doc)); return doc; }
  const tag = { payable: "PAYS", refund: "REFUND", live: "LIVE", sealed: "SEALED", lost: "RENT", forfeit: "FORFEIT", unknown: "?" }[row?.state ?? "unknown" as const];
  console.log(`position ${pkStr}`);
  console.log(`  kind    ${doc.kind}`);
  console.log(`  bettor  ${bettor}`);
  console.log(`  venue   ${venuePk}${venue ? ` (${(venue as any).kind ?? doc.kind}, status ${venue.status}${(venue as any).outcome !== undefined && venue.status === 1 ? `, outcome ${(venue as any).outcome}` : ""}${(venue as any).mask !== undefined && venue.status === 1 ? `, mask 0b${((venue as any).mask as number).toString(2)}` : ""})` : " — MISSING"}`);
  if (pos) {
    const amounts = (pos.account.amounts as any[]).map((a) => BigInt(a.toString()));
    console.log(`  amounts ${amounts.map((a, i) => `[${i}] ${solAmt(a)}`).join("  ")}`);
  } else if (dpos) {
    console.log(`  stake   ${solAmt(BigInt(dpos.account.amount.toString()))} SOL   commitment ${Buffer.from(dpos.account.commitment as number[]).toString("hex").slice(0, 16)}…`);
    console.log(`  reveal  ${dpos.account.revealed === 255 ? "still sealed" : `outcome ${dpos.account.revealed}`}`);
  }
  console.log(`  state   ${tag} — ${doc.note}`);
  if (row && row.est > 0n) console.log(`  payout  ~${solAmt(row.est)} SOL (staked ${solAmt(row.staked)})`);
  else if (row) console.log(`  staked  ${solAmt(row.staked)} SOL`);
  if (row && (row.state === "payable" || row.state === "refund")) {
    console.log(`\nclaim: sealed chain market ${row.kind === "ladder" ? "ladder claim" : row.kind === "dark" ? "dark claim --pos-salt <your-salt>" : "claim"} --market ${row.pk}`);
  }
  console.log(`  permalink — https://josepha-mayo.github.io/sealed/?pk=${pkStr}`);
  return doc;
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
  // cwd-forgiveness: `yarn --cwd packages/harness cli ...` (and the
  // packaged binary) make relative snapshot paths resolve against the
  // package dir — if the arg misses cwd but hits repo-root, use that.
  if (typeof args.snapshot === "string" && !existsSync(args.snapshot)) {
    const rooted = join(ROOT, args.snapshot);
    if (existsSync(rooted)) args.snapshot = rooted;
  }
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
    if (args.verify) { await grantVerify(String(args.verify), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined); return; }
    if (args.prove) {
      if (!args.snapshot) throw new Error("grant cards claim a pinned ledger — pass --snapshot <f>");
      await grantProve(String(cmd[1] ?? args.grant ?? ""), String(args.prove), String(args.snapshot));
      return;
    }
    // Fetch + decrypt a ShareGrant addressed to the local wallet.
    if (typeof args.chunk !== "string" || typeof args.part !== "string" || !args.chunk || !args.part
      || !Number.isInteger(Number(args.chunk)) || !Number.isInteger(Number(args.part))
      || Number(args.part) < 0 || Number(args.part) > 3)
      throw new Error("grant needs <pk> --prove <f> | --verify <f> | --benchmark <pk> --chunk <i> --part <0..3> (live decrypt)");
    const g = await fetchGrant(new PublicKey(String(args.benchmark)), Number(args.chunk), Number(args.part));
    console.log(`grant ${g.grant.toBase58()} shared_at=${g.sharedAt}`);
    for (const [i, s] of g.specs.entries()) console.log(`  item ${i}: ${renderPrompt(s)}`);
    return;
  }
  if (sub === "grants") {
    const viewerStr = args.viewer ? String(args.viewer) : undefined;
    if (!args.benchmark && !viewerStr) { console.log("usage: chain grants --benchmark <pk> | --viewer <pk> [--viewer x]"); process.exitCode = 2; return; }
    const bankPk = args.benchmark ? new PublicKey(String(args.benchmark)) : null;
    const b58 = (v: any) => v?.toBase58 ? v.toBase58() : typeof v === "string" ? v : new PublicKey(Buffer.from(v ?? [])).toBase58();
    if (args.snapshot) {
      const ss = decodeSnapshotSection(loadSnapshotJson(String(args.snapshot)), "sealed");
      let gs = snapOf(ss, "ShareGrant");
      if (bankPk) gs = gs.filter((g) => (g.account.benchmark as PublicKey).equals(bankPk));
      if (viewerStr) gs = gs.filter((g) => b58(g.account.viewer) === viewerStr);
      const bname = new Map(snapOf(ss, "Benchmark").map((b) => [b.publicKey.toBase58(), b.account.name as string]));
      if (!gs.length) console.log("no grants");
      for (const g of gs) {
        const a = g.account as any;
        console.log(`${bname.get(b58(a.benchmark)) ?? b58(a.benchmark).slice(0, 10)} chunk ${a.chunkIndex} part ${a.part} → viewer ${b58(a.viewer).slice(0, 16)}… at ${a.sharedAt} (${g.publicKey.toBase58()})`);
      }
      return;
    }
    if (!bankPk) { console.log("live mode needs --benchmark (use --snapshot for the cross-bank --viewer index)"); process.exitCode = 2; return; }
    const list = await listGrants(bankPk);
    const filtered = viewerStr ? list.filter((g) => new PublicKey(Buffer.from(g.viewer, "hex")).toBase58() === viewerStr) : list;
    if (!filtered.length) console.log("no grants");
    for (const g of filtered) console.log(`chunk ${g.chunkIndex} part ${g.part} → viewer ${g.viewer.slice(0, 16)}… at ${g.sharedAt} (${g.address.toBase58()})`);
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
  if (sub === "artifact") {
    const target = cmd[1] ?? args.file;
    if (!target) throw new Error("usage: chain artifact <file|dir> [--recursive] [--tamper] [--snapshot <f>] [--json] — auto-detects any sealed-*/v1 artifact and replays it keyless; --tamper forges it and proves the verifier catches the lie");
    if (args.tamper) {
      await artifactTamper(String(target), args.snapshot ? String(args.snapshot) : undefined,
        Boolean(args.recursive), args.exhibit ? String(args.exhibit) : undefined);
    } else {
      await artifactVerify(String(target), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined,
        Boolean(args.recursive));
    }
    return;
  }
  if (sub === "fingerprint") {
    const evDir = String(args.evidence ?? "docs/evidence"), webDir = String(args.web ?? "web");
    if (args.anchor) {
      const out = args.anchor === true ? "docs/evidence-anchor.json" : String(args.anchor);
      await fingerprintAnchor(out, evDir, webDir, args.wallet ? String(args.wallet) : undefined,
        args.rpc ? String(args.rpc) : undefined);
      return;
    }
    if (args["check-anchor"]) {
      await anchorVerify(String(args["check-anchor"]), evDir, webDir,
        args.rpc ? String(args.rpc) : undefined);
      return;
    }
    await chainFingerprint(evDir, webDir, Boolean(args.json));
    return;
  }
  if (sub === "catalog") {
    const dir = String(args.dir ?? "docs/evidence");
    if (args.verify) { await catalogVerify(String(args.verify), Boolean(args.json)); return; }
    await chainCatalog(dir, Boolean(args.emit), Boolean(args.check), Boolean(args.json));
    return;
  }
  if (sub === "board") {
    if (args.verify) {
      await boardVerify(String(args.verify), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
    if (args.prove) {
      if (!args.snapshot) throw new Error("board cards claim a pinned ledger — pass --snapshot <f>");
      await boardProve(String(args.prove), String(args.snapshot));
      return;
    }
    throw new Error("usage: chain board --prove <file> --snapshot <f> | --verify <file|dir> [--snapshot <f>]");
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
  if (sub === "model") {
    await chainModel(String(cmd[1] ?? ""), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "modelrec") {
    await modelRecordShow(String(cmd[1] ?? args.run ?? ""), args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json));
    return;
  }
  if (sub === "records") {
    await modelRecordList(args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json), Boolean(args.wilson), Boolean(args.vouched));
    return;
  }
  if (sub === "bank") {
    if (args.verify) {
      await bankVerify(String(args.verify), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
    if (args.prove) {
      if (!args.snapshot) throw new Error("bank cards claim a pinned ledger — pass --snapshot <f>");
      await bankProve(String(cmd[1] ?? ""), String(args.prove), String(args.snapshot));
      return;
    }
    await bankShow(String(cmd[1] ?? ""), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "wallet") {
    await walletShow(String(cmd[1] ?? ""), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "banks") {
    await bankList(args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json),
      args.kind ? String(args.kind) : undefined, Boolean(args.depth));
    return;
  }
  if (sub === "matrix") {
    await chainMatrix(Number(args.banks ?? 10), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "stats") {
    await chainStats(args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json));
    return;
  }
  if (sub === "anomalies") {
    await chainAnomalies(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "feed") {
    await chainFeed(Number(args.limit ?? 40), args.type ? String(args.type) : undefined,
      Number(args.since ?? 0), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined,
      args.pk ? String(args.pk) : undefined, false, args.model ? String(args.model) : undefined,
      args.bank ? String(args.bank) : undefined);
    return;
  }
  if (sub === "export") {
    if (args.verify) {
      // Replay a committed digest against the bundle it claims to describe.
      await digestVerify(String(args.verify), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
    // No --snapshot → digest the live cluster (source: "live").
    await chainExport(args.snapshot ? String(args.snapshot) : undefined, args.out ? String(args.out) : undefined);
    return;
  }
  if (sub === "prove") {
    if (args.verify) {
      // Verifier-composable: policy flags turn "is this card authentic?"
      // into "is this card authentic AND does it pass MY policy?".
      const numF = (k: string) => args[k] === undefined ? undefined : Number(args[k]);
      const policy: GatePolicy = {
        minPct: numF("min-pct"), minRuns: numF("min-runs"), minItems: numF("min-items"),
        minWilsonPct: numF("wilson"), vouchedOnly: Boolean(args.vouched),
        noPostReveal: Boolean(args["no-post-reveal"]),
      };
      const hasPolicy = Object.values(policy).some((v) => v !== undefined && v !== false);
      await chainProveVerify(String(args.verify), hasPolicy ? policy : undefined, Boolean(args.json),
        args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
    if (args.all) { await chainProve(undefined, args.out ? String(args.out) : "claims", args.snapshot ? String(args.snapshot) : undefined, true); return; }
    await chainProve(String(cmd[1] ?? ""), args.out ? String(args.out) : undefined, args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "badge") {
    // the distribution artifact — a shields-style SVG rendered FROM a
    // claim card; --verify re-renders and byte-compares (the badge must
    // match its bound receipt, not just look official).
    await chainBadge(String(args.card ?? cmd[1] ?? ""),
      args.verify ? String(args.verify) : (args.out ? String(args.out) : undefined), Boolean(args.verify));
    return;
  }
  if (sub === "report") {
    if (args.verify || cmd[1] === "--verify") {
      await reportVerify(String(args.verify ?? cmd[2]), args.snapshot ? String(args.snapshot) : undefined, Boolean(args.json));
      return;
    }
    await chainReport(String(cmd[1] ?? ""), args.out ? String(args.out) : undefined,
      args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "search") {
    await chainSearch(String(cmd[1] ?? ""), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "tour") {
    await chainTour(args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "watch") {
    await chainWatch(Number(args.interval ?? 15) || 15, args.type ? String(args.type) : undefined,
      Number(args.since ?? 0), args.snapshot ? String(args.snapshot) : undefined,
      args.model ? String(args.model) : undefined, args.bank ? String(args.bank) : undefined);
    return;
  }
  if (sub === "diff") {
    await chainDiff(String(cmd[1] ?? ""), String(cmd[2] ?? ""), Boolean(args.json));
    return;
  }
  if (sub === "runs") {
    await runList({
      snapPath: args.snapshot ? String(args.snapshot) : undefined, json: Boolean(args.json),
      bank: args.bank ? String(args.bank) : undefined, model: args.model ? String(args.model) : undefined,
      minPct: args["min-pct"] !== undefined ? Number(args["min-pct"]) : undefined,
      status: args.status ? String(args.status) : undefined,
      attested: args.attested === undefined ? undefined : Boolean(args.attested),
      postReveal: args["post-reveal"] === undefined ? undefined : Boolean(args["post-reveal"]),
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
    if (args.sweep) {
      const base: GatePolicy = {
        minRuns: numF("min-runs"), minItems: numF("min-items"),
        minWilsonPct: numF("wilson"), vouchedOnly: Boolean(args.vouched),
        noPostReveal: Boolean(args["no-post-reveal"]),
      };
      const grid = args.grid ? String(args.grid).split(",").map((s) => { const n = Number(s); if (!Number.isFinite(n)) throw new Error("--grid must be comma-separated numbers"); return n; }) : undefined;
      await gateSweep(base, Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined,
        args.bank ? String(args.bank) : undefined, grid);
      return;
    }
    if (args["certify-verify"]) {
      await gateCertVerify(String(args["certify-verify"]), Boolean(args.json));
      return;
    }
    if (cmd[1] === "--all" || args.all) {
      const policy: GatePolicy = {
        minPct: numF("min-pct"), minRuns: numF("min-runs"), minItems: numF("min-items"),
        minWilsonPct: numF("wilson"), vouchedOnly: Boolean(args.vouched),
        noPostReveal: Boolean(args["no-post-reveal"]),
      };
      if (policy.minPct === undefined && policy.minRuns === undefined &&
          policy.minItems === undefined && policy.minWilsonPct === undefined)
        throw new Error("a gate needs a criterion: --min-pct/--min-runs/--min-items/--wilson");
      if (args.cert) {
        const cert = await gateCert(policy, String(args.cert), args.snapshot ? String(args.snapshot) : undefined,
          args.bank ? String(args.bank) : undefined);
        // --prove composes: the governance kit in one command — certificate
        // for the policy, a claim card for every model it admits.
        if (args.prove) {
          const dir = String(args.prove);
          mkdirSync(dir, { recursive: true });
          for (const m of cert.models.filter((m: any) => m.verdict.pass)) {
            const fname = `${m.modelId.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
            await chainProve(m.modelId, `${dir}/${fname}`, args.snapshot ? String(args.snapshot) : undefined);
          }
        }
        return;
      }
      await gateAll(policy, Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined,
        args.bank ? String(args.bank) : undefined, args.prove ? String(args.prove) : undefined);
      return;
    }
    const target = String(cmd[1] ?? args.model ?? args.run ?? "");
    if (!target) throw new Error("usage: chain gate <model_id|record-pk> [--min-pct N] [--min-runs N] [--min-items N] [--wilson N] [--vouched] [--no-post-reveal] [--why] [--json]");
    if (args.why) {
      const p: GatePolicy = {
        minPct: numF("min-pct"), minRuns: numF("min-runs"), minItems: numF("min-items"),
        minWilsonPct: numF("wilson"), vouchedOnly: Boolean(args.vouched),
        noPostReveal: Boolean(args["no-post-reveal"]),
      };
      const hasPolicy = p.minPct !== undefined || p.minRuns !== undefined ||
        p.minItems !== undefined || p.minWilsonPct !== undefined;
      await gateWhy(target, hasPolicy ? p : undefined, Boolean(args.json),
        args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
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
    if (args.verify || cmd[1] === "--verify") {
      await trailVerify(String(args.verify ?? cmd[2]), Boolean(args.json),
        args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
    const run = cmd[1] ?? args.run;
    if (!run) throw new Error("usage: chain trail <run-pk> [--prove <file>] [--json] [--snapshot f] · chain trail --verify <file>");
    if (args.prove) {
      await trailProve(String(run), String(args.prove), args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
    await chainTrail(String(run), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    return;
  }
  if (sub === "compare") {
    if (cmd[1] === "--matrix" || args.matrix) {
      await compareMatrix(Number(args.top ?? 12) || 12, Number(args["min-shared"] ?? 1) || 1, Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
    if (cmd[1] === "--all" || args.all) {
      if (args.prove) {
        await compareMatchAll(String(args.prove), args.snapshot ? String(args.snapshot) : undefined, Number(args["min-shared"] ?? 1) || 1);
        return;
      }
      await compareAll(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined, Number(args["min-shared"] ?? 1) || 1, Boolean(args.wilson));
      return;
    }
    if (args["match-verify"]) {
      await matchVerify(String(args["match-verify"]), Boolean(args.json),
        args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
    const a = cmd[1], b = cmd[2];
    if (!a || !b) throw new Error("usage: chain compare <model_id|record-pk> <model_id|record-pk> [--all] [--json] [--snapshot f]");
    if (args.prove) {
      await compareMatch(String(a), String(b), String(args.prove), args.snapshot ? String(args.snapshot) : undefined);
      return;
    }
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
    } else if (m0 === "position") {
      if (args.verify) { await positionVerify(String(args.verify), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined); return; }
      if (args.prove) {
        if (!args.snapshot) throw new Error("position cards claim a pinned ledger — pass --snapshot <f>");
        await positionProve(String(cmd[2] ?? ""), String(args.prove), String(args.snapshot));
        return;
      }
      await marketPosition(String(cmd[2] ?? ""), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "quote") {
      await marketQuote(String(cmd[2] ?? ""), Number(args.outcome ?? -1), BigInt(String(args.lamports ?? "0")),
        Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "odds") {
      await marketOdds(cmd[2] ? String(cmd[2]) : undefined,
        Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "sentiment") {
      await marketSentiment(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "champions") {
      await marketChampions(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "divergence") {
      await marketDivergence(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "calibration") {
      await marketCalibration(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "live") {
      await marketLive(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "sharps") {
      await marketSharps(Number(args.min ?? 1), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "escrow") {
      await marketEscrow(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
    } else if (m0 === "unclaimed") {
      await marketUnclaimed(Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined);
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
      } else if (m1 === "card") {
        if (args.verify) { await bountyVerify(String(args.verify), Boolean(args.json), args.snapshot ? String(args.snapshot) : undefined); return; }
        if (args.prove) {
          if (!args.snapshot) throw new Error("bounty cards claim a pinned ledger — pass --snapshot <f>");
          await bountyProve(String(args.bounty ?? cmd[3] ?? ""), String(args.prove), String(args.snapshot));
          return;
        }
        throw new Error("bounty card needs --prove <f> --snapshot <f2> or --verify <f>");
      } else throw new Error(`unknown bounty command: ${m1}`);
    } else if (m0 === "show") {
      await marketShow(new PublicKey(String(args.market)));
    } else throw new Error(`unknown market command: ${m0}`);
    return;
  }
  throw new Error(`unknown chain command: ${sub}`);
}
