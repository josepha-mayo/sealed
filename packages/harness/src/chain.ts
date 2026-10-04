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
import { classifyBoard } from "./board.js";
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
export async function verifyRun(benchmarkPk: PublicKey, run: RunArtifact, runIndex?: bigint, ctx = setup()) {
  const { program } = ctx;
  const acct = program.account as any;
  const b: any = await acct.benchmark.fetch(benchmarkPk);
  const reveals: any[] = await acct.reveal.all([{ memcmp: { offset: 8, bytes: benchmarkPk.toBase58() } }]);
  if (reveals.length === 0) {
    console.log(`no revealed parts for ${benchmarkPk.toBase58()} — ask the authority to 'chain reveal' first`);
    return;
  }
  // If the run is on-chain, prove the artifact's outputs are the committed ones.
  if (runIndex !== undefined) {
    const { run: runPda } = pdas(ctx, b.authority, b.id);
    const r: any = await fetchOrNull(acct.run.fetch(runPda(runIndex)));
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
    console.log(`${String(i + 1).padStart(4)}  ${pct}%  ${String(Number(r.correct)).padStart(4)}/${items}  ${(r.modelId + (r.attested ? " ✓" : "")).padEnd(38)} #${r.index}`);
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

/** `chain records` — the whole capability registry, accuracy-first. */
export async function modelRecordList() {
  const { program } = sealedProgram();
  const acct = program.account as any;
  const [all, logs] = await Promise.all([acct.modelRecord.all(), acct.scoreLog.all()]);
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
  console.log(`${rows.length} model record(s) — cumulative MPC-scored performance:`);
  for (const r of rows)
    console.log(`  ${r.modelId.padEnd(36)} runs=${r.runs}  agg=${r.pct.toFixed(1)}%  best=${r.best} (${r.bestPct.toFixed(1)}%)` +
      `${r.vouched ? `  vouched=${r.vouched.c}/${r.vouched.i}` : ""}  rec=${r.pk.toBase58()}`);
}

/** `chain modelrec <pubkey|model_id>` — print a registry entry. */
export async function modelRecordShow(keyOrName: string) {
  const { program } = sealedProgram();
  let pda: PublicKey;
  try {
    pda = new PublicKey(keyOrName);
  } catch {
    const h = createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest();
    [pda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), h], program.programId);
  }
  const rec: any = await (program.account as any).modelRecord.fetchNullable(pda);
  if (!rec) { console.log(`no model record at ${pda.toBase58()}`); return; }
  const pct = rec.totalItems.toNumber() ? (100 * rec.totalCorrect.toNumber() / rec.totalItems.toNumber()).toFixed(1) : "0.0";
  console.log(`model record ${pda.toBase58()}`);
  console.log(`  model_id=${rec.modelId}  hash=${Buffer.from(rec.modelHash).toString("hex").slice(0, 16)}…`);
  console.log(`  runs=${rec.runsScored}  aggregate=${rec.totalCorrect}/${rec.totalItems} (${pct}%)`);
  const logs: any[] = (await (program.account as any).scoreLog.all()).filter((l: any) => (l.account.modelRecord as PublicKey).equals(pda));
  const vc = logs.filter((l: any) => l.account.vouchedAtRecord).reduce((s: number, l: any) => s + l.account.correct, 0);
  const vi = logs.filter((l: any) => l.account.vouchedAtRecord).reduce((s: number, l: any) => s + l.account.items, 0);
  if (vi) console.log(`  vouched-only=${vc}/${vi} (${(100 * vc / vi).toFixed(1)}%) across ${logs.filter((l: any) => l.account.vouchedAtRecord).length} attested receipt(s)`);
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
): Promise<GateVerdict> {
  const { program } = sealedProgram();
  let pda: PublicKey;
  try {
    pda = new PublicKey(keyOrName);
  } catch {
    const h = createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest();
    [pda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), h], program.programId);
  }
  const rec: any = await (program.account as any).modelRecord.fetchNullable(pda);
  const logs: any[] = rec
    ? (await (program.account as any).scoreLog.all())
        .filter((l: any) => (l.account.modelRecord as PublicKey).equals(pda))
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
      `  [registry: ${verdict.totalRuns} total, ${verdict.postRevealRuns} post-reveal]`);
    for (const c of verdict.checks)
      console.log(`  ${c.pass ? "ok" : "MISS"} ${c.name}: ${c.actual} (needed ${c.needed})`);
  }
  process.exitCode = verdict.pass ? 0 : verdict.reason === "policy" ? 1 : 2;
  return verdict;
}

/** `chain market board [--json]` — the keeper + discovery surface: scan the
 *  ledger's venues and report what a permissionless actor can do RIGHT NOW:
 *  claimable bounties (a qualifying run already finalized), resolvable
 *  markets/ladders, and expired venues awaiting the sweeps. Read-only. */
async function loadBoard() {
  const { market } = marketProgram();
  const { program } = sealedProgram();
  const mAcct = market.account as any;
  const [bounties, markets, darks, ladders, runs] = await Promise.all([
    mAcct.bounty.all(), mAcct.market.all(), mAcct.darkMarket.all(),
    mAcct.ladder.all(), (program.account as any).run.all(),
  ]);
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

export async function marketBoard(json = false) {
  const { board, counts } = await loadBoard();
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
export async function marketSweep(kpPath?: string) {
  const { board } = await loadBoard();
  const total = board.claimable.length + board.resolvable.length +
    board.resolvableLadders.length + board.tallyable.length +
    board.expirable.length + board.expiredBounties.length;
  if (!total) { console.log("market sweep — nothing actionable"); return; }
  console.log(`market sweep — ${total} permissionless actions queued`);
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
export async function marketPositions(kpPath?: string, json = false) {
  const { market, kp } = marketProgram(kpPath);
  const me = kp.publicKey.toBase58();
  const mAcct = market.account as any;
  const [markets, ladders, darks, positions, darkPositions] = await Promise.all([
    mAcct.market.all(), mAcct.ladder.all(), mAcct.darkMarket.all(),
    mAcct.position.all(), mAcct.darkPosition.all(),
  ]);
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
export async function chainHistory(keyOrName: string, json = false) {
  const { program } = sealedProgram();
  let pda: PublicKey;
  try {
    pda = new PublicKey(keyOrName);
  } catch {
    const h = createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest();
    [pda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), h], program.programId);
  }
  const rec: any = await (program.account as any).modelRecord.fetchNullable(pda);
  if (!rec) {
    console.log(`no model record for ${keyOrName} (${pda.toBase58()})`);
    process.exitCode = 2;
    return [];
  }
  const num = (x: any) => x?.toNumber ? x.toNumber() : Number(x ?? 0);
  const logs = (await (program.account as any).scoreLog.all())
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
    const ctx = setup();
    const acct = ctx.program.account as any;
    const b: any = await acct.benchmark.fetch(new PublicKey(String(args.benchmark)));
    const bank = await fetchGenBank(new PublicKey(String(args.benchmark)), b.chunkCount, ctx);
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
    const list = await listGrants(new PublicKey(String(args.benchmark)));
    if (!list.length) console.log("no grants");
    for (const g of list) console.log(`chunk ${g.chunkIndex} part ${g.part} → viewer ${g.viewer.slice(0, 16)}… at ${g.sharedAt} (${g.address.toBase58()})`);
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
    await verifyRun(new PublicKey(String(args.benchmark)), run, idx);
    return;
  }
  if (sub === "status") {
    await status(new PublicKey(String(args.benchmark)));
    return;
  }
  if (sub === "attest") {
    await attestRun(new PublicKey(String(args.run)));
    return;
  }
  if (sub === "record") {
    if (args.all) { await recordAllScores(); return; }
    if (!args.run) throw new Error("usage: chain record --run <pubkey> | --all");
    await recordScore(new PublicKey(String(args.run)));
    return;
  }
  if (sub === "modelrec") {
    await modelRecordShow(String(cmd[1] ?? args.run ?? ""));
    return;
  }
  if (sub === "records") {
    await modelRecordList();
    return;
  }
  if (sub === "gate") {
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
    await gateModelRecord(target, policy, Boolean(args.json));
    return;
  }
  if (sub === "history") {
    const target = String(cmd[1] ?? args.model ?? "");
    if (!target) throw new Error("usage: chain history <model_id|record-pk> [--json]");
    await chainHistory(target, Boolean(args.json));
    return;
  }
  if (sub === "market") {
    const [m0] = cmd.slice(1);
    const bettor = args.bettor as string | undefined;
    if (m0 === "board") {
      await marketBoard(Boolean(args.json));
    } else if (m0 === "sweep") {
      await marketSweep(bettor);
    } else if (m0 === "positions") {
      await marketPositions(bettor, Boolean(args.json));
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
