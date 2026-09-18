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
import { randomBytes } from "node:crypto";
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
import { chunkOutLeaves, merkleProof } from "./hash.js";
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
      .createBenchmark(bank.benchmarkId, `sealed-v${bank.benchmarkId}`, bank.chunkCount, Array.from(Buffer.from(bank.itemsRoot, "hex")), new anchor.BN(feeLamports.toString()), 0)
      .accounts({ authority: wallet.publicKey })
      .rpc({ commitment: "confirmed" });
    b = await acct.benchmark.fetch(benchmark);
  } else if (b.kind !== 0) {
    throw new Error(`benchmark ${benchmark.toBase58()} is a generated bank; use 'chain gen'`);
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
      .rpc({ commitment: "confirmed" });
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
      await program.methods.initChunk(i).accounts({ authority: wallet.publicKey, benchmark }).rpc({ commitment: "confirmed" });
      state = await acct.answerChunk.fetch(c);
    }
    if (!(await fetchOrNull(acct.itemChunk.fetch(it)))) {
      await program.methods.initItems(i).accounts({ authority: wallet.publicKey, benchmark, items: it }).rpc({ commitment: "confirmed" });
    }
    for (let p = 0; p < PARTS; p++) {
      if (state.partsSealed & (1 << p)) continue;
      if (state.sealingPart !== p) {
        const offset = new anchor.BN(randomBytes(8), "hex");
        await program.methods
          .genPart(offset, i, p)
          .accountsPartial({ payer: wallet.publicKey, benchmark, chunk: c, items: it, ...arciumAccounts(ctx, offset, "gen_part") })
          .rpc({ commitment: "confirmed" });
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
      .rpc({ commitment: "confirmed" });
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
      await program.methods.initChunk(i).accounts({ authority: wallet.publicKey, benchmark }).rpc({ commitment: "confirmed" });
      state = await acct.answerChunk.fetch(c);
    }
    if (!(await fetchOrNull(acct.privItemChunk.fetch(it)))) {
      await program.methods.initItemsPrivate(i).accounts({ authority: wallet.publicKey, benchmark, items: it }).rpc({ commitment: "confirmed" });
    }
    for (let p = 0; p < PARTS; p++) {
      if (state.partsSealed & (1 << p)) continue;
      if (state.sealingPart !== p) {
        const offset = new anchor.BN(randomBytes(8), "hex");
        await program.methods
          .genPartPrivate(offset, i, p, Array.from(viewer.pub))
          .accountsPartial({ payer: wallet.publicKey, benchmark, chunk: c, items: it, ...arciumAccounts(ctx, offset, "gen_part_private") })
          .rpc({ commitment: "confirmed" });
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
    .rpc({ commitment: "confirmed" });

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
  const outLeaves = chunkOutLeaves(run.items.map((r) => BigInt(r.outputHash)));
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
      const proof = merkleProof(outLeaves, i).map((p) => Array.from(p));
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(runIndex.toString()), i, outputs, proof)
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
    .rpc({ commitment: "confirmed" });
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

/** N-way parimutuel bucket markets that resolve on a finalized Run's `correct`. */
const MARKET_PROGRAM_ID = new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");
const MAX_OUTCOMES = 8;

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

interface MarketTiming { feeBps: number; closesAt: bigint; resolveBy: bigint }

/** `--flag 0` disables; `+3600` = that many seconds from now; else absolute unix ts. */
function deadline(v: string | boolean | undefined): bigint {
  if (v === undefined || v === true || v === "0") return 0n;
  const s = String(v);
  if (s.startsWith("+")) return BigInt(Math.floor(Date.now() / 1000) + Number(s.slice(1)));
  return BigInt(s);
}

function timing(args: Args): MarketTiming {
  return {
    feeBps: args["fee-bps"] !== undefined ? Number(args["fee-bps"]) : 0,
    closesAt: deadline(args["closes-at"]),
    resolveBy: deadline(args["resolve-by"]),
  };
}

async function marketOpen(run: PublicKey, edges: number[], salt: bigint, t: MarketTiming, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const m = marketPda(run, salt, market.programId);
  await (market.methods as any)
    .createMarket(new anchor.BN(salt.toString()), edges, t.feeBps, new anchor.BN(t.closesAt.toString()), new anchor.BN(t.resolveBy.toString()))
    .accounts({ authority: kp.publicKey, run, market: m })
    .rpc({ commitment: "confirmed" });
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
    .rpc({ commitment: "confirmed" });
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
        .rpc({ commitment: "confirmed" })
    : await (market.methods as any)
        .bet(outcome, new anchor.BN(lamports.toString()))
        .accounts({ bettor: kp.publicKey, run: m.run, market: marketPk, position })
        .rpc({ commitment: "confirmed" });
  console.log(`bet [${label}] ${Number(lamports) / LAMPORTS_PER_SOL} SOL by ${kp.publicKey.toBase58()} (${sig})`);
}

async function marketResolve(marketPk: PublicKey, kpPath?: string) {
  const { market } = marketProgram(kpPath);
  const m: any = await (market.account as any).market.fetch(marketPk);
  const sig = isDuel(m)
    ? await (market.methods as any)
        .resolveDuel()
        .accounts({ runA: m.run, runB: m.runB, market: marketPk })
        .rpc({ commitment: "confirmed" })
    : await (market.methods as any)
        .resolve()
        .accounts({ run: m.run, market: marketPk })
        .rpc({ commitment: "confirmed" });
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
  const before = await provider0(kp).getBalance(kp.publicKey);
  const sig = await (market.methods as any)
    .claim()
    .accounts({ bettor: kp.publicKey, market: marketPk, position })
    .rpc({ commitment: "confirmed" });
  const after = await provider0(kp).getBalance(kp.publicKey);
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
        .rpc({ commitment: "confirmed" })
    : await (market.methods as any)
        .voidMarket()
        .accounts({ authority: kp.publicKey, run: m.run, market: marketPk })
        .rpc({ commitment: "confirmed" });
  console.log(`market voided (${sig}): ${marketPk.toBase58()} — all positions refundable via claim`);
}

/** Permissionless expiry once resolve_by has passed. */
async function marketExpire(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const sig = await (market.methods as any)
    .expireMarket()
    .accounts({ market: marketPk })
    .rpc({ commitment: "confirmed" });
  console.log(`market expired (${sig}): ${marketPk.toBase58()} — all positions refundable via claim`);
}

/** Authority collects the fee accrued at resolution. */
async function marketClaimFee(marketPk: PublicKey, kpPath?: string) {
  const { market, kp } = marketProgram(kpPath);
  const before = await provider0(kp).getBalance(kp.publicKey);
  const sig = await (market.methods as any)
    .claimFee()
    .accounts({ authority: kp.publicKey, market: marketPk })
    .rpc({ commitment: "confirmed" });
  const after = await provider0(kp).getBalance(kp.publicKey);
  console.log(`claim-fee (${sig}): ${kp.publicKey.toBase58()} balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
}

function provider0(kp: Keypair) {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  return new Connection(url, "confirmed");
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
    .rpc({ commitment: "confirmed" });
  console.log(`run ${runPk.toBase58()} attested by authority ${ctx.wallet.publicKey.toBase58()}`);
}

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
    await resharePart(new PublicKey(String(args.benchmark)), Number(args.chunk), Number(args.part), to);
    return;
  }
  if (sub === "grant") {
    // Fetch + decrypt a ShareGrant addressed to the local wallet.
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
  if (sub === "market") {
    const [m0] = cmd.slice(1);
    const bettor = args.bettor as string | undefined;
    if (m0 === "open") {
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
    } else if (m0 === "show") {
      await marketShow(new PublicKey(String(args.market)));
    } else throw new Error(`unknown market command: ${m0}`);
    return;
  }
  throw new Error(`unknown chain command: ${sub}`);
}
