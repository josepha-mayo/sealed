/**
 * End-to-end on Arcium localnet:
 *   init comp defs -> create benchmark -> stage + seal 2 chunks (MPC re-encryption)
 *   -> benchmark goes Live -> create run (fee paid) -> score both chunks in MPC
 *   -> Run.correct equals the planted number of matches -> run finalized
 *   -> re-scoring a chunk and staging a sealed chunk are rejected.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { Sealed } from "../target/types/sealed";
import { Market } from "../target/types/market";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  uploadCircuit,
  RescueCipher,
  deserializeLE,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  x25519,
  getComputationAccAddress,
  getMXEPublicKey,
  getClusterAccAddress,
  getLookupTableAddress,
  getArciumProgram,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha256.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ed25519 } from "@noble/curves/ed25519";

// Mirrors of packages/harness/src/genbank.ts, kept independent so the test
// detects client/circuit drift rather than sharing a bug with the client.
const DOMAIN_GEN_ANSWER = utf8ToBytes("sealed/v1/genanswer\0");
function genAnswerHash(benchmarkId: number, itemIndex: number, answer: bigint): bigint {
  const id = Buffer.alloc(4); id.writeUInt32LE(benchmarkId);
  const ix = Buffer.alloc(4); ix.writeUInt32LE(itemIndex);
  const a = Buffer.alloc(8); a.writeBigInt64LE(answer);
  const d = sha3_256(concatBytes(DOMAIN_GEN_ANSWER, id, ix, a));
  return new DataView(d.buffer, 0, 8).getBigUint64(0, true);
}
interface ItemSpec { a: number; b: number; c: number; op0: number; op1: number; }
function evalSpec(s: ItemSpec): bigint {
  const ap = (x: bigint, op: number, y: bigint) => (op === 0 ? x + y : op === 1 ? x - y : x * y);
  return ap(ap(BigInt(s.a), s.op0, BigInt(s.b)), s.op1, BigInt(s.c));
}
function renderPrompt(s: ItemSpec): string {
  const OPS = ["+", "-", "*"];
  return `Evaluate (((${s.a} ${OPS[s.op0]} ${s.b}) ${OPS[s.op1]} ${s.c})). Reply with only the integer.\nANSWER:`;
}
function decodeItemChunk(data: Buffer): { index: number; partsWritten: number; specs: ItemSpec[] } {
  const specs: ItemSpec[] = [];
  for (let i = 0; i < CHUNK; i++) {
    const o = 44 + i * 5;
    specs.push({ a: data[o], b: data[o + 1], c: data[o + 2], op0: data[o + 3], op1: data[o + 4] });
  }
  return { index: data.readUInt16LE(40), partsWritten: data[43], specs };
}

// Private-bank mirrors (PrivItemChunk: ciphertexts only — the test must be able
// to verify the ciphertext commitment and decrypt with the authority's key).
const DOMAIN_PRIV_ITEMS = utf8ToBytes("sealed/v1/privitems\0");
function privItemsFold(root: Uint8Array, chunkIndex: number, part: number, encBytes: Uint8Array): Uint8Array {
  const ix = Buffer.alloc(4); ix.writeUInt32LE(chunkIndex);
  return sha256(concatBytes(DOMAIN_PRIV_ITEMS, root, ix.subarray(0, 2), Uint8Array.of(part), encBytes));
}
function u128le(n: bigint): Uint8Array {
  const b = new Uint8Array(16);
  let v = n;
  for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
function decodePrivItemChunk(data: Buffer) {
  const nonces: bigint[] = [];
  for (let p = 0; p < PARTS; p++) {
    let v = 0n;
    for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[76 + p * 16 + i]);
    nonces.push(v);
  }
  const ciphertexts: Uint8Array[] = [];
  for (let i = 0; i < 8; i++) ciphertexts.push(new Uint8Array(data.subarray(140 + i * 32, 172 + i * 32)));
  const mintOrder: number[] = [];
  for (let p = 0; p < PARTS; p++) mintOrder.push(data.readUInt16LE(396 + p * 2));
  return {
    index: data.readUInt16LE(40),
    partsWritten: data[43],
    encryptionKey: new Uint8Array(data.subarray(44, 76)),
    ciphertexts,
    nonces,
    mintOrder,
  };
}
// Chunk-level output-commitment mirrors — score_chunk verifies this fold
// onchain (kept independent of packages/harness so client/program drift shows).
const DOMAIN_CHUNK_OUT = utf8ToBytes("sealed/v1/chunkout\0");
const DOMAIN_NODE = new Uint8Array([0x01]);
function chunkOutLeaf(chunkIndex: number, outputs: bigint[]): Uint8Array {
  return sha256(concatBytes(DOMAIN_CHUNK_OUT, u32le(chunkIndex).subarray(0, 2), ...outputs.map(u64le)));
}
function chunkOutLeaves(chunks: bigint[][]): Uint8Array[] {
  return chunks.map((outputs, i) => {
    const padded = outputs.slice();
    while (padded.length < CHUNK) padded.push(0n);
    return chunkOutLeaf(i, padded);
  });
}
function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  let level = leaves.slice();
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(concatBytes(DOMAIN_NODE, level[i], i + 1 < level.length ? level[i + 1] : level[i])));
    }
    level = next;
  }
  return level.length ? level[0] : new Uint8Array(32);
}
function merkleProof(leaves: Uint8Array[], index: number): number[][] {
  const proof: number[][] = [];
  let level = leaves.slice();
  let i = index;
  while (level.length > 1) {
    const sib = i ^ 1;
    proof.push(Array.from(sib < level.length ? level[sib] : level[i]));
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      next.push(sha256(concatBytes(DOMAIN_NODE, level[j], j + 1 < level.length ? level[j + 1] : level[j])));
    }
    level = next;
    i >>= 1;
  }
  return proof;
}

function unpackSpecs(fields: bigint[]): ItemSpec[] {
  expect(fields.length).to.equal(2);
  const bytes = new Array<number>(40);
  for (let i = 0; i < 40; i++) {
    const f = i < 26 ? 0 : 1;
    bytes[i] = Number((fields[f] >> BigInt(8 * (i - f * 26))) & 0xffn);
  }
  return Array.from({ length: 8 }, (_, k) => {
    const o = k * 5;
    return { a: bytes[o], b: bytes[o + 1], c: bytes[o + 2], op0: bytes[o + 3], op1: bytes[o + 4] };
  });
}

const CHUNK = 32;
const PART = 8;
const PARTS = CHUNK / PART;

const FAR_FUTURE = new anchor.BN(Math.floor(Date.now() / 1000) + 30 * 86400);

describe("Sealed", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Sealed as Program<Sealed>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
  // Per-run bank ids: every suite run mints fresh banks, so the suite is
  // re-runnable on any ledger state. Pin a run with SEALED_TEST_SALT=<n>.
  const ID_SALT = Number(process.env.SEALED_TEST_SALT ?? Date.now() % 100000);
  const AUTH_ID = 1000 + ID_SALT;   // authored bank (tests 1-3 share it)
  const GEN_ID = 2000 + ID_SALT;    // public generated bank
  const PRIV_ID = 3000 + ID_SALT;   // private generated bank (tests 5-7 share it)
  // The staged answer bank: chunk i holds CHUNK random u64 "answer hashes".
  const answers: bigint[][] = Array.from({ length: 2 }, () => Array.from({ length: CHUNK }, randomU64));

  const arciumAccounts = (offset: anchor.BN, ix: string) => ({
    computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount,
    mxeAccount: getMXEAccAddress(program.programId),
    mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset(ix)).readUInt32LE()),
  });

  async function initCompDef(name: string, build: () => ReturnType<typeof program.methods.initSealPartCompDef>) {
    const compDefPDA = PublicKey.findProgramAddressSync(
      [getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), getCompDefAccOffset(name)],
      getArciumProgramId(),
    )[0];
    if (await provider.connection.getAccountInfo(compDefPDA)) {
      console.log(`${name}: comp def already initialized`);
      return "existing";
    }
    const arciumProgram = getArciumProgram(provider);
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
    const sig = await build()
      .accounts({ compDefAccount: compDefPDA, payer: owner.publicKey, mxeAccount, addressLookupTable: lutAddress })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await uploadCircuit(provider, name, program.programId, fs.readFileSync(`build/${name}.arcis`), true);
    return sig;
  }

  it("seals a bank, scores a run in MPC, and finalizes", async () => {
    console.log(`init comp defs (cluster offset ${arciumEnv.arciumClusterOffset}, program ${program.programId.toBase58()})`);
    await initCompDef("seal_part", () => program.methods.initSealPartCompDef());
    await initCompDef("score_chunk", () => program.methods.initScoreChunkCompDef());
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);

    // ---------------------------------------------------------------- benchmark
    const BENCH_ID = AUTH_ID;
    const CHUNKS = 2;
    const FEE = 0.01 * LAMPORTS_PER_SOL;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(BENCH_ID)],
      program.programId,
    );
    const itemsRoot = randomBytes(32);
    await program.methods
      .createBenchmark(BENCH_ID, "sealed-test", CHUNKS, Array.from(itemsRoot), new anchor.BN(FEE), 0)
      .accounts({ authority: owner.publicKey })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    let b = await program.account.benchmark.fetch(benchmark);
    expect(b.status).to.equal(0);
    expect(Buffer.from(b.itemsRoot)).to.deep.equal(itemsRoot);

    // ---------------------------------------------------------------- stage + seal
    const authorPriv = x25519.utils.randomSecretKey();
    const authorPub = x25519.getPublicKey(authorPriv);
    const cipher = new RescueCipher(x25519.getSharedSecret(authorPriv, mxePublicKey));
    const chunkPdas: PublicKey[] = [];

    for (let i = 0; i < CHUNKS; i++) {
      const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(i)], program.programId);
      chunkPdas.push(chunk);
      await program.methods.initChunk(i).accounts({ authority: owner.publicKey, benchmark }).signers([owner]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });

      // Stage all parts (one nonce per part), then seal each part in MPC.
      const staged: Uint8Array[][] = [];
      for (let p = 0; p < PARTS; p++) {
        const nonce = randomBytes(16);
        const cts = cipher.encrypt(answers[i].slice(p * PART, (p + 1) * PART), nonce);
        expect(cts.length).to.equal(PART);
        staged.push(cts);
        await program.methods
          .stagePart(i, p, Array.from(authorPub), new anchor.BN(deserializeLE(nonce).toString()), cts.map((c) => Array.from(c)))
          .accounts({ authority: owner.publicKey, benchmark, chunk })
          .signers([owner])
          .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      }
      let state = await program.account.answerChunk.fetch(chunk);
      expect(state.partsStaged).to.equal((1 << PARTS) - 1);
      expect(state.partsSealed).to.equal(0);

      for (let p = 0; p < PARTS; p++) {
        console.log(`seal chunk ${i} part ${p}`);
        const offset = new anchor.BN(randomBytes(8), "hex");
        await program.methods
          .sealPart(offset, i, p)
          .accountsPartial({ payer: owner.publicKey, benchmark, chunk, ...arciumAccounts(offset, "seal_part") })
          .signers([owner])
          .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
        const finalizeSig = await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
        state = await program.account.answerChunk.fetch(chunk);
        if (!(state.partsSealed & (1 << p))) await dumpTx(provider, finalizeSig);
        expect(state.partsSealed & (1 << p)).to.not.equal(0, `part ${p} sealed`);
        expect(state.sealingPart).to.equal(0xff);
        // Ciphertext must have changed: it is now encrypted to the MXE, not the author.
        const same = state.ciphertexts
          .slice(p * PART, (p + 1) * PART)
          .every((c: number[], j: number) => Buffer.from(c).equals(Buffer.from(staged[p][j])));
        expect(same).to.equal(false, "re-encrypted");
      }
      expect(state.partsSealed).to.equal((1 << PARTS) - 1);
      expect(state.authorPubkey.every((x: number) => x === 0)).to.equal(true, "author key wiped");
    }
    b = await program.account.benchmark.fetch(benchmark);
    expect(b.chunksSealed).to.equal(CHUNKS);
    expect(b.status).to.equal(1, "live");

    // staging a sealed part is rejected
    await expectAnchorError(
      program.methods
        .stagePart(0, 0, Array.from(authorPub), new anchor.BN(1), Array.from({ length: PART }, () => Array.from(randomBytes(32))))
        .accounts({ authority: owner.publicKey, benchmark, chunk: chunkPdas[0] })
        .signers([owner])
        .rpc(),
      "PartAlreadySealed",
    );

    // ---------------------------------------------------------------- run
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.5 * LAMPORTS_PER_SOL);
    const authorityBefore = await provider.connection.getBalance(owner.publicKey);
    const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(0n)], program.programId);
    // Outputs are committed in outputs_root BEFORE scoring: score_chunk verifies
    // a chunk-level Merkle proof, so the runner can't adapt outputs per chunk.
    const planted = [13, CHUNK];
    const runOutputs: bigint[][] = answers.map((chunk, i) =>
      chunk.map((a, j) => (j < planted[i] ? a : randomU64())),
    );
    const outLeaves = runOutputs.map((chunk, i) => chunkOutLeaf(i, chunk));
    await program.methods
      .createRun("test/oracle", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const authorityAfter = await provider.connection.getBalance(owner.publicKey);
    // The provider wallet (owner) is the tx fee payer, so it nets FEE minus a few thousand lamports.
    expect(FEE - (authorityAfter - authorityBefore)).to.be.within(0, 20_000, "fee paid to authority");
    let r = await program.account.run.fetch(run);
    expect(r.status).to.equal(0);
    expect(r.modelId).to.equal("test/oracle");

    // ---------------------------------------------------------------- score
    let total = 0;
    for (let i = 0; i < CHUNKS; i++) {
      console.log(`score chunk ${i} (expect ${planted[i]})`);
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(0), i, runOutputs[i].map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, i))
        .accountsPartial({
          payer: runner.publicKey,
          run,
          runner: runner.publicKey,
          chunk: chunkPdas[i],
          ...arciumAccounts(offset, "score_chunk"),
        })
        .signers([runner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
      total += planted[i];
      r = await program.account.run.fetch(run);
      expect(r.correct).to.equal(total);
    }
    expect(r.status).to.equal(1, "finalized");
    expect(r.scoredMask.toNumber()).to.equal((1 << CHUNKS) - 1);
    expect(r.pendingMask.toNumber()).to.equal(0);
    console.log(`run finalized: ${r.correct}/${CHUNKS * CHUNK}`);

    // re-scoring is rejected (run finalized)
    const again = new anchor.BN(randomBytes(8), "hex");
    await expectAnchorError(
      program.methods
        .scoreChunk(again, new anchor.BN(0), 0, runOutputs[0].map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
        .accountsPartial({ payer: runner.publicKey, run, runner: runner.publicKey, chunk: chunkPdas[0], ...arciumAccounts(again, "score_chunk") })
        .signers([runner])
        .rpc(),
      "RunAlreadyFinalized",
    );
  });

  it("settles a parimutuel market on an MPC-scored run", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(AUTH_ID)],
      program.programId,
    );
    const chunkPdas = [0, 1].map(
      (i) => PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(i)], program.programId)[0],
    );
    const mktPda = (run: PublicKey, salt = 0n) =>
      PublicKey.findProgramAddressSync([Buffer.from("market"), run.toBuffer(), u64le(salt)], marketProgram.programId)[0];
    const posPda = (mkt: PublicKey, bettor: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("position"), mkt.toBuffer(), bettor.toBuffer()], marketProgram.programId)[0];

    // A market cannot be opened on the already-finalized run #0.
    const [run0] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(0n)], program.programId);
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(0), [30], 0, new anchor.BN(0), FAR_FUTURE)
        .accounts({ authority: owner.publicKey, run: run0, market: mktPda(run0) })
        .signers([owner])
        .rpc(),
      "RunNotPending",
    );

    // Run #1 is created pending with a real outputs commitment (10+0 planted
    // correct over 2 chunks -> score 10).
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.5 * LAMPORTS_PER_SOL);
    const [run1] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(1n)], program.programId);
    const planted = [10, 0];
    const runOutputs: bigint[][] = answers.map((chunk, i) =>
      chunk.map((a, j) => (j < planted[i] ? a : randomU64())),
    );
    const outLeaves = runOutputs.map((chunk, i) => chunkOutLeaf(i, chunk));
    await program.methods
      .createRun("test/market-run", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run: run1 })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    const THRESHOLD = 30;
    const BN0 = new anchor.BN(0);
    const mkt = mktPda(run1);
    await marketProgram.methods
      .createMarket(new anchor.BN(0), [THRESHOLD], 0, BN0, FAR_FUTURE)
      .accounts({ authority: owner.publicKey, run: run1, market: mkt })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    let m = await marketProgram.account.market.fetch(mkt);
    expect(m.status).to.equal(0);
    expect(m.nOutcomes).to.equal(2);
    expect(m.edges[0]).to.equal(THRESHOLD);

    // Duplicate edges create unreachable buckets — rejected now.
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(9), [10, 10], 0, BN0, FAR_FUTURE)
        .accounts({ authority: owner.publicKey, run: run1, market: mktPda(run1, 9n) })
        .signers([owner])
        .rpc(),
      "InvalidEdges",
    );

    // Deadline guards: resolve_by is required, at least 60s out, and within
    // the 90-day horizon; a nonzero closes_at gets the same floor and must
    // precede resolve_by.
    const nowSec = Math.floor(Date.now() / 1000);
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(10), [THRESHOLD], 0, BN0, BN0)
        .accounts({ authority: owner.publicKey, run: run1, market: mktPda(run1, 10n) })
        .signers([owner])
        .rpc(),
      "DeadlineTooSoon",
    );
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(11), [THRESHOLD], 0, BN0, new anchor.BN(nowSec + 30))
        .accounts({ authority: owner.publicKey, run: run1, market: mktPda(run1, 11n) })
        .signers([owner])
        .rpc(),
      "DeadlineTooSoon",
    );
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(12), [THRESHOLD], 0, BN0, new anchor.BN(nowSec + 91 * 86400))
        .accounts({ authority: owner.publicKey, run: run1, market: mktPda(run1, 12n) })
        .signers([owner])
        .rpc(),
      "DeadlineTooFar",
    );
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(13), [THRESHOLD], 0, new anchor.BN(nowSec + 30), FAR_FUTURE)
        .accounts({ authority: owner.publicKey, run: run1, market: mktPda(run1, 13n) })
        .signers([owner])
        .rpc(),
      "DeadlineTooSoon",
    );
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(14), [THRESHOLD], 0, FAR_FUTURE.add(new anchor.BN(100)), FAR_FUTURE)
        .accounts({ authority: owner.publicKey, run: run1, market: mktPda(run1, 14n) })
        .signers([owner])
        .rpc(),
      "DeadlineOrder",
    );

    // Second market on the same run, different salt + 3-way score bands.
    const mkt3 = mktPda(run1, 1n);
    await marketProgram.methods
      .createMarket(new anchor.BN(1), [10, 20], 0, BN0, FAR_FUTURE)
      .accounts({ authority: owner.publicKey, run: run1, market: mkt3 })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // A 5%-fee market (salt 2) and a voidable market (salt 3).
    const mktF = mktPda(run1, 2n);
    await marketProgram.methods
      .createMarket(new anchor.BN(2), [THRESHOLD], 500, BN0, FAR_FUTURE)
      .accounts({ authority: owner.publicKey, run: run1, market: mktF })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const mktV = mktPda(run1, 3n);
    await marketProgram.methods
      .createMarket(new anchor.BN(3), [THRESHOLD], 0, BN0, FAR_FUTURE)
      .accounts({ authority: owner.publicKey, run: run1, market: mktV })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    // Deadline market (salt 4): anyone can expire it once resolve_by passes
    // while the run is still pending.
    const mktX = mktPda(run1, 4n);
    const resolveBy = Math.floor(Date.now() / 1000) + 70;
    await marketProgram.methods
      .createMarket(new anchor.BN(4), [THRESHOLD], 0, BN0, new anchor.BN(resolveBy))
      .accounts({ authority: owner.publicKey, run: run1, market: mktX })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    // Second deadline market (salt 5): after the run finalizes, expiry MUST
    // fail — a losing bettor cannot veto a pending resolution for a refund.
    const mktX2 = mktPda(run1, 5n);
    await marketProgram.methods
      .createMarket(new anchor.BN(5), [THRESHOLD], 0, BN0, new anchor.BN(resolveBy))
      .accounts({ authority: owner.publicKey, run: run1, market: mktX2 })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // No deadline -> cannot expire.
    await expectAnchorError(
      marketProgram.methods.expireMarket().accounts({ market: mkt, runA: run1, runB: run1 }).rpc(),
      "MarketNotExpired",
    );

    // Binary market: YES(outcome1) 0.3 SOL vs NO(outcome0) 0.5 SOL.
    const yes = Keypair.generate();
    const no = Keypair.generate();
    await fund(provider, owner, yes.publicKey, 0.6 * LAMPORTS_PER_SOL);
    await fund(provider, owner, no.publicKey, 0.8 * LAMPORTS_PER_SOL);
    const noBefore = await provider.connection.getBalance(no.publicKey);

    // Prefund grief on the market side: dust on yes's position PDA is
    // reclaimable by `unbrick_pda` before the bet initializes it — the
    // instruction is the same generic drain sealed exposes (Anchor's own
    // init would absorb the prefund anyway; unbrick claws the dust back).
    const yesPos = posPda(mkt, yes.publicKey);
    const griefLamports = await provider.connection.getMinimumBalanceForRentExemption(0);
    await sendWithRetry(() => provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: yesPos, lamports: griefLamports }),
      ),
      [owner],
      { preflightCommitment: "processed", commitment: "confirmed" },
    ));
    const posSeeds = [Buffer.from("position"), mkt.toBuffer(), yes.publicKey.toBuffer()];
    await marketProgram.methods
      .unbrickPda(posSeeds, PublicKey.findProgramAddressSync(posSeeds, marketProgram.programId)[1])
      .accounts({ rescuer: owner.publicKey, pda: yesPos })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const posAfter = await provider.connection.getAccountInfo(yesPos);
    expect(posAfter === null || posAfter.lamports === 0).to.equal(true);

    await marketProgram.methods
      .bet(1, new anchor.BN(0.3 * LAMPORTS_PER_SOL))
      .accounts({ bettor: yes.publicKey, run: run1, market: mkt, position: yesPos })
      .signers([yes])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await marketProgram.methods
      .bet(0, new anchor.BN(0.5 * LAMPORTS_PER_SOL))
      .accounts({ bettor: no.publicKey, run: run1, market: mkt, position: posPda(mkt, no.publicKey) })
      .signers([no])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    m = await marketProgram.account.market.fetch(mkt);
    expect(m.totals[0].toNumber()).to.equal(0.5 * LAMPORTS_PER_SOL);
    expect(m.totals[1].toNumber()).to.equal(0.3 * LAMPORTS_PER_SOL);

    // 3-way market needs stake on every outcome to resolve; `yes` covers all bands.
    for (let i = 0; i < 3; i++) {
      await marketProgram.methods
        .bet(i, new anchor.BN(0.01 * LAMPORTS_PER_SOL))
        .accounts({ bettor: yes.publicKey, run: run1, market: mkt3, position: posPda(mkt3, yes.publicKey) })
        .signers([yes])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }
    // Fee market: 0.2 SOL on each side; winner takes 95% of the pot.
    await marketProgram.methods
      .bet(0, new anchor.BN(0.2 * LAMPORTS_PER_SOL))
      .accounts({ bettor: yes.publicKey, run: run1, market: mktF, position: posPda(mktF, yes.publicKey) })
      .signers([yes])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await marketProgram.methods
      .bet(1, new anchor.BN(0.2 * LAMPORTS_PER_SOL))
      .accounts({ bettor: no.publicKey, run: run1, market: mktF, position: posPda(mktF, no.publicKey) })
      .signers([no])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    // Voidable + deadline markets get one bet each.
    await marketProgram.methods
      .bet(0, new anchor.BN(0.05 * LAMPORTS_PER_SOL))
      .accounts({ bettor: yes.publicKey, run: run1, market: mktV, position: posPda(mktV, yes.publicKey) })
      .signers([yes])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await marketProgram.methods
      .bet(1, new anchor.BN(0.05 * LAMPORTS_PER_SOL))
      .accounts({ bettor: no.publicKey, run: run1, market: mktX, position: posPda(mktX, no.publicKey) })
      .signers([no])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // Only the authority can void, and only while the run is still unscored.
    await expectAnchorError(
      marketProgram.methods
        .voidMarket()
        .accounts({ authority: yes.publicKey, run: run1, market: mktV })
        .signers([yes])
        .rpc(),
      "NotAuthority",
    );
    await marketProgram.methods
      .voidMarket()
      .accounts({ authority: owner.publicKey, run: run1, market: mktV })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const mv = await marketProgram.account.market.fetch(mktV);
    expect(mv.status).to.equal(2, "voided");

    // Voided market refunds in full via claim.
    const yesBefore = await provider.connection.getBalance(yes.publicKey);
    await marketProgram.methods
      .claim()
      .accounts({ bettor: yes.publicKey, market: mktV, position: posPda(mktV, yes.publicKey) })
      .signers([yes])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const yesAfter = await provider.connection.getBalance(yes.publicKey);
    expect(yesAfter - yesBefore).to.be.greaterThan(0.04 * LAMPORTS_PER_SOL, "voided market refunded");

    // A mismatched Merkle proof cannot pass outputs into scoring.
    const badOffset = new anchor.BN(randomBytes(8), "hex");
    const badProof = merkleProof(outLeaves, 0);
    badProof[0] = Array.from(randomBytes(32));
    await expectAnchorError(
      program.methods
        .scoreChunk(badOffset, new anchor.BN(1), 0, runOutputs[0].map((o) => new anchor.BN(o.toString())), badProof)
        .accountsPartial({ payer: runner.publicKey, run: run1, runner: runner.publicKey, chunk: chunkPdas[0], ...arciumAccounts(badOffset, "score_chunk") })
        .signers([runner])
        .rpc(),
      "OutputsRootMismatch",
    );

    // Deadline passed while the run is still pending -> permissionless expiry
    // cancels mktX; `no`'s stake refunds in full via claim.
    await waitChainTs(provider, resolveBy);
    await marketProgram.methods
      .expireMarket()
      .accounts({ market: mktX, runA: run1, runB: run1 })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const mx = await marketProgram.account.market.fetch(mktX);
    expect(mx.status).to.equal(2, "expired");
    await marketProgram.methods
      .claim()
      .accounts({ bettor: no.publicKey, market: mktX, position: posPda(mktX, no.publicKey) })
      .signers([no])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // MPC-score run #1: 10+0 planted -> 10 < 30 -> NO wins.
    let total = 0;
    for (let i = 0; i < 2; i++) {
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(1), i, runOutputs[i].map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, i))
        .accountsPartial({ payer: runner.publicKey, run: run1, runner: runner.publicKey, chunk: chunkPdas[i], ...arciumAccounts(offset, "score_chunk") })
        .signers([runner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
      total += planted[i];
    }
    const r1 = await program.account.run.fetch(run1);
    expect(r1.status).to.equal(1);
    expect(r1.correct).to.equal(total);

    // Betting and voiding are both closed once the run is finalized.
    await expectAnchorError(
      marketProgram.methods
        .bet(0, new anchor.BN(1000))
        .accounts({ bettor: yes.publicKey, run: run1, market: mkt, position: posPda(mkt, yes.publicKey) })
        .signers([yes])
        .rpc(),
      "RunNotPending",
    );
    await expectAnchorError(
      marketProgram.methods
        .voidMarket()
        .accounts({ authority: owner.publicKey, run: run1, market: mkt })
        .signers([owner])
        .rpc(),
      "RunNotPending",
    );

    // The run finalized before resolve_by — expiry must NOT cancel a market
    // that can still resolve, or losers would refund their stakes.
    await expectAnchorError(
      marketProgram.methods
        .expireMarket()
        .accounts({ market: mktX2, runA: run1, runB: run1 })
        .rpc(),
      "MarketResolvable",
    );

    // Permissionless resolve: score 10 < 30 -> outcome 0 (the "<30" bucket).
    await marketProgram.methods
      .resolve()
      .accounts({ run: run1, market: mkt })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    m = await marketProgram.account.market.fetch(mkt);
    expect(m.status).to.equal(1, "resolved");
    expect(m.outcome).to.equal(0, "score < threshold wins");
    expect(m.resolvedScore).to.equal(total);
    expect(m.feesAccrued.toNumber()).to.equal(0, "no fee on the zero-fee market");

    // The 3-way market resolves on the same run: score 10 lands in bucket [10,20).
    await marketProgram.methods
      .resolve()
      .accounts({ run: run1, market: mkt3 })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const m3 = await marketProgram.account.market.fetch(mkt3);
    expect(m3.status).to.equal(1);
    expect(m3.outcome).to.equal(1, "10 lands in the 10..19 band");

    // The fee market resolves and accrues 5% of the 0.4 SOL pot.
    await marketProgram.methods
      .resolve()
      .accounts({ run: run1, market: mktF })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const mF = await marketProgram.account.market.fetch(mktF);
    expect(mF.status).to.equal(1);
    expect(mF.outcome).to.equal(0);
    expect(mF.feesAccrued.toNumber()).to.equal(0.02 * LAMPORTS_PER_SOL, "5% fee accrued");

    // Authority takes the fee BEFORE bettors claim — claims must stay solvent
    // because the fee is recomputed from fee_bps, not the zeroed fees_accrued.
    const authBefore = await provider.connection.getBalance(owner.publicKey);
    await marketProgram.methods
      .claimFee()
      .accounts({ authority: owner.publicKey, market: mktF })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const authAfter = await provider.connection.getBalance(owner.publicKey);
    expect(authAfter - authBefore).to.be.greaterThan(0.01 * LAMPORTS_PER_SOL, "fee collected");
    await expectAnchorError(
      marketProgram.methods
        .claimFee()
        .accounts({ authority: owner.publicKey, market: mktF })
        .signers([owner])
        .rpc(),
      "NoFees",
    );

    // Post-fee claims: winner `yes` takes 0.38 (0.4 pot - 0.02 fee); loser
    // `no` closes for rent only. Under the old accounting the last claim
    // underflowed and locked the remaining pot.
    const yesF = await provider.connection.getBalance(yes.publicKey);
    await marketProgram.methods
      .claim()
      .accounts({ bettor: yes.publicKey, market: mktF, position: posPda(mktF, yes.publicKey) })
      .signers([yes])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const yesF2 = await provider.connection.getBalance(yes.publicKey);
    expect(yesF2 - yesF).to.be.greaterThan(0.35 * LAMPORTS_PER_SOL, "winner paid after fee-claim-first");
    await marketProgram.methods
      .claim()
      .accounts({ bettor: no.publicKey, market: mktF, position: posPda(mktF, no.publicKey) })
      .signers([no])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // Loser still closes its position (payout 0, rent back) — no locked account.
    await marketProgram.methods
      .claim()
      .accounts({ bettor: yes.publicKey, market: mkt, position: posPda(mkt, yes.publicKey) })
      .signers([yes])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const gone = await marketProgram.account.position.fetchNullable(posPda(mkt, yes.publicKey));
    expect(gone).to.equal(null, "losing position closed");

    // Winner takes the whole pot (0.8 SOL) plus the position's rent back.
    await marketProgram.methods
      .claim()
      .accounts({ bettor: no.publicKey, market: mkt, position: posPda(mkt, no.publicKey) })
      .signers([no])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const noAfter = await provider.connection.getBalance(no.publicKey);
    expect(noAfter - noBefore).to.be.greaterThan(0.04 * LAMPORTS_PER_SOL, "NO bettor profited");
    console.log(`market settled: NO bettor ${noBefore / LAMPORTS_PER_SOL} -> ${noAfter / LAMPORTS_PER_SOL} SOL, fee claimed`);
  });

  it("mints a generated bank inside MPC and scores a run against it", async () => {
    await initCompDef("gen_part", () => program.methods.initGenPartCompDef());

    const GCHUNKS = 1;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(GEN_ID)],
      program.programId,
    );
    // Generated banks start items_root at zero; each gen_part callback folds its specs in.
    let b: any = await program.account.benchmark.fetchNullable(benchmark);
    if (!b) {
      await program.methods
        .createBenchmark(GEN_ID, "sealed-gen", GCHUNKS, Array.from(new Uint8Array(32)), new anchor.BN(0), 1)
        .accounts({ authority: owner.publicKey })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      b = await program.account.benchmark.fetch(benchmark);
    }
    expect(b.kind).to.equal(1);

    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [itemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);
    if (!(await program.account.answerChunk.fetchNullable(chunk))) {
      await program.methods.initChunk(0).accounts({ authority: owner.publicKey, benchmark }).signers([owner]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }
    if (!(await program.account.itemChunk.fetchNullable(itemsPda))) {
      await program.methods.initItems(0).accounts({ authority: owner.publicKey, benchmark, items: itemsPda }).signers([owner]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }

    // Authored-only paths must reject a generated bank.
    const authorPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
    await expectAnchorError(
      program.methods
        .stagePart(0, 0, Array.from(authorPub), new anchor.BN(1), Array.from({ length: PART }, () => Array.from(randomBytes(32))))
        .accounts({ authority: owner.publicKey, benchmark, chunk })
        .signers([owner])
        .rpc(),
      "WrongBankKind",
    );

    // Mint all four parts: item specs land public in the ItemChunk, the answer
    // fingerprints land sealed in the AnswerChunk — no plaintext key ever existed.
    for (let p = 0; p < PARTS; p++) {
      let state: any = await program.account.answerChunk.fetch(chunk);
      if (state.partsSealed & (1 << p)) continue;
      console.log(`gen_part chunk 0 part ${p}`);
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .genPart(offset, 0, p)
        .accountsPartial({ payer: owner.publicKey, benchmark, chunk, items: itemsPda, ...arciumAccounts(offset, "gen_part") })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      const finalizeSig = await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
      state = await program.account.answerChunk.fetch(chunk);
      if (!(state.partsSealed & (1 << p))) await dumpTx(provider, finalizeSig);
      expect(state.partsSealed & (1 << p)).to.not.equal(0, `part ${p} minted`);
    }
    const itemsAcc = await provider.connection.getAccountInfo(itemsPda);
    const st = decodeItemChunk(Buffer.from(itemsAcc!.data));
    expect(st.partsWritten).to.equal((1 << PARTS) - 1);
    b = await program.account.benchmark.fetch(benchmark);
    expect(b.status).to.equal(1, "generated bank live");
    expect(Buffer.from(b.itemsRoot).equals(Buffer.alloc(32))).to.equal(false, "items_root folded");

    // Specs are public: render the prompts and derive the true values locally.
    const prompts = st.specs.map(renderPrompt);
    expect(new Set(prompts).size).to.equal(CHUNK, "all prompts distinct");
    const truth = st.specs.map(evalSpec);

    // A run that answers the first PLANTED items correctly, garbage elsewhere.
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.3 * LAMPORTS_PER_SOL);
    const runIndex = BigInt((await program.account.benchmark.fetch(benchmark)).runCount.toString());
    const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(runIndex)], program.programId);
    const PLANTED = 17;
    const outputs = truth.map((v, j) => (j < PLANTED ? genAnswerHash(GEN_ID, j, v) : randomU64()));
    const outLeaves = [chunkOutLeaf(0, outputs)];
    await program.methods
      .createRun("test/gen-oracle", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .scoreChunk(offset, new anchor.BN(runIndex.toString()), 0, outputs.map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
      .accountsPartial({ payer: runner.publicKey, run, runner: runner.publicKey, chunk, ...arciumAccounts(offset, "score_chunk") })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    const r = await program.account.run.fetch(run);
    expect(r.status).to.equal(1, "finalized");
    expect(r.correct).to.equal(PLANTED);
    console.log(`generated bank scored: ${r.correct}/${CHUNK} correct, answers never existed in plaintext`);
  });

  it("mints a PRIVATE bank: ciphertext-only on chain, decryptable by the authority", async () => {
    await initCompDef("gen_part_private", () => program.methods.initGenPartPrivateCompDef());

    const PCHUNKS = 1;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(PRIV_ID)],
      program.programId,
    );
    let b: any = await program.account.benchmark.fetchNullable(benchmark);
    if (!b) {
      await program.methods
        .createBenchmark(PRIV_ID, "sealed-priv", PCHUNKS, Array.from(new Uint8Array(32)), new anchor.BN(0), 2)
        .accounts({ authority: owner.publicKey })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      b = await program.account.benchmark.fetch(benchmark);
    }
    expect(b.kind).to.equal(2);

    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [pitemsPda] = PublicKey.findProgramAddressSync([Buffer.from("pitems"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [pubItemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);
    if (!(await program.account.answerChunk.fetchNullable(chunk))) {
      await program.methods.initChunk(0).accounts({ authority: owner.publicKey, benchmark }).signers([owner]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }
    if (!(await program.account.privItemChunk.fetchNullable(pitemsPda))) {
      await program.methods.initItemsPrivate(0).accounts({ authority: owner.publicKey, benchmark, items: pitemsPda }).signers([owner]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }

    // The public-items path must reject a private bank (would publish its specs).
    await expectAnchorError(
      program.methods
        .initItems(0)
        .accounts({ authority: owner.publicKey, benchmark, items: pubItemsPda })
        .signers([owner])
        .rpc(),
      "WrongBankKind",
    );
    // And a private-mint ix against the PUBLIC bank is rejected at the seeds
    // constraint (its PrivItemChunk PDA can never exist for kind!=2).
    const [genBench] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(GEN_ID)],
      program.programId,
    );
    const [genChunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), genBench.toBuffer(), u16le(0)], program.programId);
    const [genPitems] = PublicKey.findProgramAddressSync([Buffer.from("pitems"), genBench.toBuffer(), u16le(0)], program.programId);
    const stray = new anchor.BN(randomBytes(8), "hex");
    await expectAnchorError(
      program.methods
        .genPartPrivate(stray, 0, 0, Array.from(new Uint8Array(32)))
        .accountsPartial({ payer: owner.publicKey, benchmark: genBench, chunk: genChunk, items: genPitems, ...arciumAccounts(stray, "gen_part_private") })
        .signers([owner])
        .rpc(),
      "AccountNotInitialized",
    );

    // Mint all four parts; specs return Enc<Shared, Pack<GenPart>> to the
    // authority's x25519 key (derived from its Solana keypair).
    const viewerPriv = ed25519.utils.toMontgomerySecret(owner.secretKey.subarray(0, 32));
    const viewerPub = ed25519.utils.toMontgomery(owner.publicKey.toBytes());
    for (let p = 0; p < PARTS; p++) {
      let state: any = await program.account.answerChunk.fetch(chunk);
      if (state.partsSealed & (1 << p)) continue;
      console.log(`gen_part_private chunk 0 part ${p}`);
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .genPartPrivate(offset, 0, p, Array.from(viewerPub))
        .accountsPartial({ payer: owner.publicKey, benchmark, chunk, items: pitemsPda, ...arciumAccounts(offset, "gen_part_private") })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      const finalizeSig = await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
      state = await program.account.answerChunk.fetch(chunk);
      if (!(state.partsSealed & (1 << p))) await dumpTx(provider, finalizeSig);
      expect(state.partsSealed & (1 << p)).to.not.equal(0, `part ${p} minted`);
    }
    b = await program.account.benchmark.fetch(benchmark);
    expect(b.status).to.equal(1, "private bank live");

    // A public RPC reader sees ONLY ciphertext — the account layout has no
    // plaintext spec field, and bytes are indistinguishable from random.
    const info = await provider.connection.getAccountInfo(pitemsPda);
    const st = decodePrivItemChunk(Buffer.from(info!.data));
    expect(st.partsWritten).to.equal((1 << PARTS) - 1);
    expect(Buffer.from(st.encryptionKey).equals(Buffer.from(viewerPub))).to.equal(true, "encrypted to the authority");

    // The items_root commits to the ciphertext stream — verifiable without keys.
    // The fold is landing-order-dependent; mint_order records the true sequence.
    let root: Uint8Array = new Uint8Array(32);
    for (const p of [0, 1, 2, 3].sort((a, b) => st.mintOrder[a] - st.mintOrder[b])) {
      const enc = concatBytes(st.ciphertexts[p * 2], st.ciphertexts[p * 2 + 1], u128le(st.nonces[p]));
      root = privItemsFold(root, 0, p, enc);
    }
    expect(Buffer.from(root).equals(Buffer.from(b.itemsRoot))).to.equal(true, "ciphertext transcript committed on-chain");

    // The authority decrypts: shared secret = DH(viewer_priv, mxe_pub).
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const cipher = new RescueCipher(x25519.getSharedSecret(viewerPriv, mxePublicKey));
    const specs: ItemSpec[] = [];
    for (let p = 0; p < PARTS; p++) {
      const cts = st.ciphertexts.slice(p * 2, p * 2 + 2).map((x) => Array.from(x));
      specs.push(...unpackSpecs(cipher.decrypt(cts, u128le(st.nonces[p]))));
    }
    expect(specs.length).to.equal(CHUNK);
    for (const s of specs) {
      expect(s.a).to.be.lessThan(64); expect(s.b).to.be.lessThan(64); expect(s.c).to.be.lessThan(64);
      expect(s.op0).to.be.lessThan(3); expect(s.op1).to.be.lessThan(3);
    }
    const prompts = specs.map(renderPrompt);
    expect(new Set(prompts).size).to.equal(CHUNK, "all private prompts distinct");
    const truth = specs.map(evalSpec);

    // Wrong-key decryption must NOT yield valid specs (range check catches it).
    const stranger = Keypair.generate();
    const wrongPriv = ed25519.utils.toMontgomerySecret(stranger.secretKey.subarray(0, 32));
    const wrongCipher = new RescueCipher(x25519.getSharedSecret(wrongPriv, mxePublicKey));
    const garbage = wrongCipher.decrypt(st.ciphertexts.slice(0, 2).map((x) => Array.from(x)), u128le(st.nonces[0]));
    const gbytes = Array.from({ length: 40 }, (_, i) => {
      const f = i < 26 ? 0 : 1;
      return Number((garbage[f] >> BigInt(8 * (i - f * 26))) & 0xffn);
    });
    const plausible = gbytes.every((v, i) => (i % 5 < 3 ? v < 64 : v < 3));
    expect(plausible).to.equal(false, "wrong key must not decode plausible specs");

    // Score against it exactly like a public generated bank.
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.3 * LAMPORTS_PER_SOL);
    const runIndex = BigInt((await program.account.benchmark.fetch(benchmark)).runCount.toString());
    const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(runIndex)], program.programId);
    const PLANTED = 21;
    const outputs = truth.map((v, j) => (j < PLANTED ? genAnswerHash(PRIV_ID, j, v) : randomU64()));
    const outLeaves = [chunkOutLeaf(0, outputs)];
    await program.methods
      .createRun("test/priv-oracle", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .scoreChunk(offset, new anchor.BN(runIndex.toString()), 0, outputs.map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
      .accountsPartial({ payer: runner.publicKey, run, runner: runner.publicKey, chunk, ...arciumAccounts(offset, "score_chunk") })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    const r = await program.account.run.fetch(run);
    expect(r.status).to.equal(1, "finalized");
    expect(r.correct).to.equal(PLANTED);
    console.log(`private bank scored: ${r.correct}/${CHUNK} correct — specs never appeared on-chain`);
  });

  it("reshares private specs to a delegate key — selective question disclosure", async () => {
    await initCompDef("reshare_part", () => program.methods.initResharePartCompDef());

    // Reuse the private bank from the previous test (id 3, kind 2, live).
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(PRIV_ID)],
      program.programId,
    );
    const b: any = await program.account.benchmark.fetch(benchmark);
    expect(b.kind).to.equal(2);
    expect(b.status).to.equal(1, "private bank live");
    const [pitemsPda] = PublicKey.findProgramAddressSync([Buffer.from("pitems"), benchmark.toBuffer(), u16le(0)], program.programId);

    // The delegate is a fresh keypair — a "judge" the authority wants to show
    // the exam questions to, without publishing them.
    const delegate = Keypair.generate();
    const delegatePub = ed25519.utils.toMontgomery(delegate.publicKey.toBytes());
    const [grant] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant"), benchmark.toBuffer(), u16le(0), Uint8Array.of(0), delegatePub],
      program.programId,
    );

    // A stranger cannot queue a reshare — the ix is authority-gated.
    const stranger = Keypair.generate();
    await fund(provider, owner, stranger.publicKey, 0.1 * LAMPORTS_PER_SOL);
    const stray = new anchor.BN(randomBytes(8), "hex");
    await expectAnchorError(
      program.methods
        .resharePart(stray, 0, 0, Array.from(delegatePub))
        .accountsPartial({ payer: stranger.publicKey, benchmark, items: pitemsPda, grant, ...arciumAccounts(stray, "reshare_part") })
        .signers([stranger])
        .rpc(),
      "NotAuthority",
    );

    // Authority reshares part 0 of chunk 0 to the delegate.
    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .resharePart(offset, 0, 0, Array.from(delegatePub))
      .accountsPartial({ payer: owner.publicKey, benchmark, items: pitemsPda, grant, ...arciumAccounts(offset, "reshare_part") })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    const g: any = await program.account.shareGrant.fetch(grant);
    expect(g.chunkIndex).to.equal(0);
    expect(g.part).to.equal(0);
    expect(Buffer.from(g.viewer).equals(Buffer.from(delegatePub))).to.equal(true, "grant addressed to the delegate");
    expect(Buffer.from(g.encryptionKey).equals(Buffer.from(delegatePub))).to.equal(true, "circuit echoed the delegate key");
    expect(g.sharedAt.toNumber()).to.be.greaterThan(0);

    // The delegate decrypts the grant with its own wallet-derived key — the
    // Shared-encryption scheme is DH(viewer_priv, mxe_pub), same as the
    // authority's. What comes out must be the SAME specs the authority sees.
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const delegatePriv = ed25519.utils.toMontgomerySecret(delegate.secretKey.subarray(0, 32));
    const delegateCipher = new RescueCipher(x25519.getSharedSecret(delegatePriv, mxePublicKey));
    const gnonce = BigInt(g.nonce.toString());
    const specs = unpackSpecs(delegateCipher.decrypt(g.ciphertexts.map((x: number[]) => Array.from(x)), u128le(gnonce)));
    expect(specs.length).to.equal(PART);
    for (const s of specs) {
      expect(s.a).to.be.lessThan(64); expect(s.b).to.be.lessThan(64); expect(s.c).to.be.lessThan(64);
      expect(s.op0).to.be.lessThan(3); expect(s.op1).to.be.lessThan(3);
    }

    const info = await provider.connection.getAccountInfo(pitemsPda);
    const st = decodePrivItemChunk(Buffer.from(info!.data));
    const authPriv = ed25519.utils.toMontgomerySecret(owner.secretKey.subarray(0, 32));
    const authCipher = new RescueCipher(x25519.getSharedSecret(authPriv, mxePublicKey));
    const authSpecs = unpackSpecs(authCipher.decrypt(st.ciphertexts.slice(0, 2).map((x) => Array.from(x)), u128le(st.nonces[0])));
    expect(specs).to.deep.equal(authSpecs, "delegate sees exactly the authority's items");

    // The grant is fresh randomness: the authority's own key must NOT open it
    // (selective disclosure is one-directional — only the delegate can read it).
    const leak = authCipher.decrypt(g.ciphertexts.map((x: number[]) => Array.from(x)), u128le(gnonce));
    const leakBytes = Array.from({ length: 40 }, (_, i) => Number((leak[i < 26 ? 0 : 1] >> BigInt(8 * (i - (i < 26 ? 0 : 1) * 26))) & 0xffn));
    const plausible = leakBytes.every((v, i) => (i % 5 < 3 ? v < 64 : v < 3));
    expect(plausible).to.equal(false, "authority key must not open the delegate's grant");

    // Re-resharing to the same viewer hits the grant PDA's init constraint.
    const again = new anchor.BN(randomBytes(8), "hex");
    await expectAnchorError(
      program.methods
        .resharePart(again, 0, 0, Array.from(delegatePub))
        .accountsPartial({ payer: owner.publicKey, benchmark, items: pitemsPda, grant, ...arciumAccounts(again, "reshare_part") })
        .signers([owner])
        .rpc(),
      "PartAlreadyShared",
    );
    console.log(`reshare verified: delegate decrypted ${specs.length} items identical to the authority's`);
  });

  it("lets a delegated runner rebuild the bank and get scored — confidential eval end-to-end", async () => {
    // The complete product flow: authority grants all parts to a runner's
    // key, the runner rebuilds the bank from grants alone, runs its model,
    // and gets MPC-scored — while the questions were never public and the
    // answers were never plaintext anywhere.
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(PRIV_ID)],
      program.programId,
    );
    const [pitemsPda] = PublicKey.findProgramAddressSync([Buffer.from("pitems"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);

    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.5 * LAMPORTS_PER_SOL);
    const runnerPub = ed25519.utils.toMontgomery(runner.publicKey.toBytes());

    // Authority grants every part to the runner (skip any already granted).
    for (let p = 0; p < PARTS; p++) {
      const [g] = PublicKey.findProgramAddressSync(
        [Buffer.from("grant"), benchmark.toBuffer(), u16le(0), Uint8Array.of(p), runnerPub],
        program.programId,
      );
      if (await program.account.shareGrant.fetchNullable(g)) continue;
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .resharePart(offset, 0, p, Array.from(runnerPub))
        .accountsPartial({ payer: owner.publicKey, benchmark, items: pitemsPda, grant: g, ...arciumAccounts(offset, "reshare_part") })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    }

    // The runner rebuilds the bank from ITS grants alone — same decode path
    // `delegate-bank` uses, mirrored independently here.
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const runnerPriv = ed25519.utils.toMontgomerySecret(runner.secretKey.subarray(0, 32));
    const cipher = new RescueCipher(x25519.getSharedSecret(runnerPriv, mxePublicKey));
    const specs: ItemSpec[] = [];
    for (let p = 0; p < PARTS; p++) {
      const [g] = PublicKey.findProgramAddressSync(
        [Buffer.from("grant"), benchmark.toBuffer(), u16le(0), Uint8Array.of(p), runnerPub],
        program.programId,
      );
      const grant: any = await program.account.shareGrant.fetch(g);
      specs.push(...unpackSpecs(cipher.decrypt(grant.ciphertexts.map((x: number[]) => Array.from(x)), u128le(BigInt(grant.nonce.toString())))));
    }
    expect(specs.length).to.equal(CHUNK, "bank rebuilt entirely from grants");
    const truth = specs.map(evalSpec);

    // The runner's "model" answers PLANTED of them right; MPC counts the rest.
    const runIndex = (await program.account.benchmark.fetch(benchmark)).runCount;
    const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(BigInt(runIndex.toString()))], program.programId);
    const PLANTED = 19;
    const outputs = truth.map((v, j) => (j < PLANTED ? genAnswerHash(PRIV_ID, j, v) : randomU64()));
    const outLeaves = [chunkOutLeaf(0, outputs)];
    await program.methods
      .createRun("delegate/runner-1", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .scoreChunk(offset, new anchor.BN(runIndex.toString()), 0, outputs.map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
      .accountsPartial({ payer: runner.publicKey, run, runner: runner.publicKey, chunk, ...arciumAccounts(offset, "score_chunk") })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    const r = await program.account.run.fetch(run);
    expect(r.status).to.equal(1, "finalized");
    expect(r.correct).to.equal(PLANTED);
    console.log(`delegated runner scored: ${r.correct}/${CHUNK} — exam granted by MPC, questions never public, answers never plaintext`);
  });

  it("settles a head-to-head duel market between two MPC-scored runs", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(GEN_ID)],
      program.programId,
    );
    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [itemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);

    // Same bank, two different runners — the "who mogs whom" primitive.
    const truth = decodeItemChunk(Buffer.from((await provider.connection.getAccountInfo(itemsPda))!.data)).specs.map(evalSpec);
    const runnerA = Keypair.generate();
    const runnerB = Keypair.generate();
    await fund(provider, owner, runnerA.publicKey, 0.4 * LAMPORTS_PER_SOL);
    await fund(provider, owner, runnerB.publicKey, 0.4 * LAMPORTS_PER_SOL);

    const idx0 = BigInt((await program.account.benchmark.fetch(benchmark)).runCount.toString());
    const mkRun = async (kp: Keypair, model: string, idx: bigint, planted: number) => {
      const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(idx)], program.programId);
      const outputs = truth.map((v, j) => (j < planted ? genAnswerHash(GEN_ID, j, v) : randomU64()));
      const outLeaves = [chunkOutLeaf(0, outputs)];
      await program.methods
        .createRun(model, Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
        .accountsPartial({ runner: kp.publicKey, authority: owner.publicKey, benchmark, run })
        .signers([kp])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      return { run, outputs, outLeaves };
    };
    const A = await mkRun(runnerA, "duel/model-a", idx0, 25);
    const B = await mkRun(runnerB, "duel/model-b", idx0 + 1n, 19);
    const runA = A.run;
    const runB = B.run;

    const duelPda = (a: PublicKey, b: PublicKey, salt: bigint) =>
      PublicKey.findProgramAddressSync([Buffer.from("duel"), a.toBuffer(), b.toBuffer(), u64le(salt)], marketProgram.programId)[0];
    const posPda = (mkt: PublicKey, bettor: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("position"), mkt.toBuffer(), bettor.toBuffer()], marketProgram.programId)[0];

    // A duel between a run and itself is nonsense.
    const BN0 = new anchor.BN(0);
    await expectAnchorError(
      marketProgram.methods
        .createDuel(new anchor.BN(7), 0, BN0, FAR_FUTURE)
        .accounts({ authority: owner.publicKey, runA, runB: runA, market: duelPda(runA, runA, 7n) })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "RunsMustDiffer",
    );

    // Duel deadlines follow the same rules: resolve_by is required and capped.
    await expectAnchorError(
      marketProgram.methods
        .createDuel(new anchor.BN(8), 0, BN0, BN0)
        .accounts({ authority: owner.publicKey, runA, runB, market: duelPda(runA, runB, 8n) })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "DeadlineTooSoon",
    );

    const mkt = duelPda(runA, runB, 0n);
    await marketProgram.methods
      .createDuel(new anchor.BN(0), 0, BN0, FAR_FUTURE)
      .accounts({ authority: owner.publicKey, runA, runB, market: mkt })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    let m = await marketProgram.account.market.fetch(mkt);
    expect(m.nOutcomes).to.equal(3);
    expect(m.runB.toBase58()).to.equal(runB.toBase58());

    // All three buckets must be backed or the duel cancels on resolve.
    const betA = Keypair.generate(), betB = Keypair.generate(), betTie = Keypair.generate();
    await fund(provider, owner, betA.publicKey, 0.4 * LAMPORTS_PER_SOL);
    await fund(provider, owner, betB.publicKey, 0.3 * LAMPORTS_PER_SOL);
    await fund(provider, owner, betTie.publicKey, 0.1 * LAMPORTS_PER_SOL);
    await marketProgram.methods.betDuel(0, new anchor.BN(0.30 * LAMPORTS_PER_SOL))
      .accounts({ bettor: betA.publicKey, runA, runB, market: mkt, position: posPda(mkt, betA.publicKey) })
      .signers([betA]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await marketProgram.methods.betDuel(1, new anchor.BN(0.20 * LAMPORTS_PER_SOL))
      .accounts({ bettor: betB.publicKey, runA, runB, market: mkt, position: posPda(mkt, betB.publicKey) })
      .signers([betB]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await marketProgram.methods.betDuel(2, new anchor.BN(0.05 * LAMPORTS_PER_SOL))
      .accounts({ bettor: betTie.publicKey, runA, runB, market: mkt, position: posPda(mkt, betTie.publicKey) })
      .signers([betTie]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    m = await marketProgram.account.market.fetch(mkt);
    expect(Number(m.totals[0]) + Number(m.totals[1]) + Number(m.totals[2])).to.equal(0.55 * LAMPORTS_PER_SOL);

    // MPC-score run A (25 right); once it finalizes, duel bets must close —
    // half the outcome is already known.
    const score = async (kp: Keypair, run: PublicKey, idx: bigint, outputs: bigint[], outLeaves: Uint8Array[]) => {
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(idx.toString()), 0, outputs.map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
        .accountsPartial({ payer: kp.publicKey, run, runner: kp.publicKey, chunk, ...arciumAccounts(offset, "score_chunk") })
        .signers([kp])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    };
    await score(runnerA, runA, idx0, A.outputs, A.outLeaves);
    expect((await program.account.run.fetch(runA)).correct).to.equal(25);

    await expectAnchorError(
      marketProgram.methods.betDuel(1, new anchor.BN(1000))
        .accounts({ bettor: betB.publicKey, runA, runB, market: mkt, position: posPda(mkt, betB.publicKey) })
        .signers([betB]).rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "RunNotPending",
    );

    await score(runnerB, runB, idx0 + 1n, B.outputs, B.outLeaves);
    expect((await program.account.run.fetch(runB)).correct).to.equal(19);

    // Permissionless settle from the two finalized runs.
    await marketProgram.methods
      .resolveDuel()
      .accounts({ runA, runB, market: mkt })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    m = await marketProgram.account.market.fetch(mkt);
    expect(m.status).to.equal(1, "resolved");
    expect(m.outcome).to.equal(0, "model A wins 25-19");
    expect(m.resolvedScore).to.equal((25 << 16) | 19);

    const before = await provider.connection.getBalance(betA.publicKey);
    await marketProgram.methods
      .claim()
      .accounts({ bettor: betA.publicKey, market: mkt, position: posPda(mkt, betA.publicKey) })
      .signers([betA])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const after = await provider.connection.getBalance(betA.publicKey);
    expect(after).to.be.greaterThan(before, "winner paid pro-rata");
    console.log(`duel settled: model-a ${25} vs model-b ${19} — A bettor ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
  });

  it("settles a 3-way ladder race by argmax with dead-heat semantics", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(GEN_ID)],
      program.programId,
    );
    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [itemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);

    const truth = decodeItemChunk(Buffer.from((await provider.connection.getAccountInfo(itemsPda))!.data)).specs.map(evalSpec);
    const runners = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    for (const r of runners) await fund(provider, owner, r.publicKey, 0.4 * LAMPORTS_PER_SOL);

    const idx0 = BigInt((await program.account.benchmark.fetch(benchmark)).runCount.toString());
    const mkRun = async (kp: Keypair, model: string, idx: bigint, planted: number) => {
      const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(idx)], program.programId);
      const outputs = truth.map((v, j) => (j < planted ? genAnswerHash(GEN_ID, j, v) : randomU64()));
      const outLeaves = [chunkOutLeaf(0, outputs)];
      await program.methods
        .createRun(model, Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
        .accountsPartial({ runner: kp.publicKey, authority: owner.publicKey, benchmark, run })
        .signers([kp])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      return { run, outputs, outLeaves };
    };
    const legs = [
      await mkRun(runners[0], "ladder/model-a", idx0, 30),
      await mkRun(runners[1], "ladder/model-b", idx0 + 1n, 20),
      await mkRun(runners[2], "ladder/model-c", idx0 + 2n, 10),
    ];
    const legPks = legs.map((x) => x.run);
    const legMeta = (pk: PublicKey) => ({ pubkey: pk, isSigner: false, isWritable: false });

    const ladderPda = (firstLeg: PublicKey, salt: bigint) =>
      PublicKey.findProgramAddressSync([Buffer.from("ladder"), firstLeg.toBuffer(), u64le(salt)], marketProgram.programId)[0];
    const posPda = (mkt: PublicKey, bettor: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("position"), mkt.toBuffer(), bettor.toBuffer()], marketProgram.programId)[0];

    const BN0 = new anchor.BN(0);
    // A leg raced against itself is nonsense (3+ legs required — pairs are duels).
    await expectAnchorError(
      marketProgram.methods
        .createLadder(legPks[0], new anchor.BN(7), 0, FAR_FUTURE, FAR_FUTURE)
        .accounts({ authority: owner.publicKey, ladder: ladderPda(legPks[0], 7n) })
        .remainingAccounts([legMeta(legPks[0]), legMeta(legPks[1]), legMeta(legPks[0])])
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "RunsMustDiffer",
    );
    // closes_at is REQUIRED for ladders — an open-ended window invites sniping.
    await expectAnchorError(
      marketProgram.methods
        .createLadder(legPks[0], new anchor.BN(8), 0, BN0, FAR_FUTURE)
        .accounts({ authority: owner.publicKey, ladder: ladderPda(legPks[0], 8n) })
        .remainingAccounts(legPks.map(legMeta))
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "DeadlineTooSoon",
    );

    const mkt = ladderPda(legPks[0], 0n);
    await marketProgram.methods
      .createLadder(legPks[0], new anchor.BN(0), 0, FAR_FUTURE, FAR_FUTURE)
      .accounts({ authority: owner.publicKey, ladder: mkt })
      .remainingAccounts(legPks.map(legMeta))
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    let l = await marketProgram.account.ladder.fetch(mkt);
    expect(l.legCount).to.equal(3);
    expect(l.legs[2].toBase58()).to.equal(legPks[2].toBase58());

    const bettors = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await fund(provider, owner, bettors[0].publicKey, 0.4 * LAMPORTS_PER_SOL);
    await fund(provider, owner, bettors[1].publicKey, 0.3 * LAMPORTS_PER_SOL);
    await fund(provider, owner, bettors[2].publicKey, 0.2 * LAMPORTS_PER_SOL);
    const stakes = [0.30, 0.20, 0.10];
    for (let i = 0; i < 3; i++) {
      await marketProgram.methods.betLadder(i, new anchor.BN(stakes[i] * LAMPORTS_PER_SOL))
        .accounts({ bettor: bettors[i].publicKey, ladder: mkt, position: posPda(mkt, bettors[i].publicKey) })
        .remainingAccounts(legPks.map(legMeta))
        .signers([bettors[i]]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }
    l = await marketProgram.account.ladder.fetch(mkt);
    expect(Number(l.totals[0]) + Number(l.totals[1]) + Number(l.totals[2])).to.equal(0.6 * LAMPORTS_PER_SOL);

    const score = async (kp: Keypair, run: PublicKey, idx: bigint, outputs: bigint[], outLeaves: Uint8Array[]) => {
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(idx.toString()), 0, outputs.map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
        .accountsPartial({ payer: kp.publicKey, run, runner: kp.publicKey, chunk, ...arciumAccounts(offset, "score_chunk") })
        .signers([kp])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    };

    // Once leg 0 leaves pending the whole board latches — no late information.
    await score(runners[0], legPks[0], idx0, legs[0].outputs, legs[0].outLeaves);
    expect((await program.account.run.fetch(legPks[0])).correct).to.equal(30);
    await expectAnchorError(
      marketProgram.methods.betLadder(1, new anchor.BN(1000))
        .accounts({ bettor: bettors[1].publicKey, ladder: mkt, position: posPda(mkt, bettors[1].publicKey) })
        .remainingAccounts(legPks.map(legMeta))
        .signers([bettors[1]]).rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "RunNotPending",
    );

    // Reordered legs at resolve are rejected — scores must map to bound legs.
    await score(runners[1], legPks[1], idx0 + 1n, legs[1].outputs, legs[1].outLeaves);
    await score(runners[2], legPks[2], idx0 + 2n, legs[2].outputs, legs[2].outLeaves);
    await expectAnchorError(
      marketProgram.methods.resolveLadder()
        .accounts({ ladder: mkt })
        .remainingAccounts([legMeta(legPks[1]), legMeta(legPks[0]), legMeta(legPks[2])])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "LegMismatch",
    );

    await marketProgram.methods.resolveLadder()
      .accounts({ ladder: mkt })
      .remainingAccounts(legPks.map(legMeta))
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    l = await marketProgram.account.ladder.fetch(mkt);
    expect(l.status).to.equal(1, "resolved");
    expect(l.resultMask).to.equal(0b001, "leg 0 wins outright");
    expect(l.resolvedScore).to.equal(30);

    const before = await provider.connection.getBalance(bettors[0].publicKey);
    await marketProgram.methods.claimLadder()
      .accounts({ bettor: bettors[0].publicKey, ladder: mkt, position: posPda(mkt, bettors[0].publicKey) })
      .signers([bettors[0]])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const after = await provider.connection.getBalance(bettors[0].publicKey);
    expect(after).to.be.greaterThan(before, "winning leg paid pro-rata");
    console.log(`ladder settled: 30/20/10 — leg-0 bettor ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL} SOL`);
  });

  it("splits a ladder dead-heat pro-rata across co-leaders", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(GEN_ID)],
      program.programId,
    );
    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [itemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);

    const truth = decodeItemChunk(Buffer.from((await provider.connection.getAccountInfo(itemsPda))!.data)).specs.map(evalSpec);
    const runners = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    for (const r of runners) await fund(provider, owner, r.publicKey, 0.4 * LAMPORTS_PER_SOL);

    const idx0 = BigInt((await program.account.benchmark.fetch(benchmark)).runCount.toString());
    const mkRun = async (kp: Keypair, model: string, idx: bigint, planted: number) => {
      const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(idx)], program.programId);
      const outputs = truth.map((v, j) => (j < planted ? genAnswerHash(GEN_ID, j, v) : randomU64()));
      const outLeaves = [chunkOutLeaf(0, outputs)];
      await program.methods
        .createRun(model, Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
        .accountsPartial({ runner: kp.publicKey, authority: owner.publicKey, benchmark, run })
        .signers([kp])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      return { run, outputs, outLeaves };
    };
    // A and B tie at 25 — the dead-heat; C loses at 10.
    const legs = [
      await mkRun(runners[0], "ladder/tie-a", idx0, 25),
      await mkRun(runners[1], "ladder/tie-b", idx0 + 1n, 25),
      await mkRun(runners[2], "ladder/tie-c", idx0 + 2n, 10),
    ];
    const legPks = legs.map((x) => x.run);
    const legMeta = (pk: PublicKey) => ({ pubkey: pk, isSigner: false, isWritable: false });
    const [mkt] = PublicKey.findProgramAddressSync([Buffer.from("ladder"), legPks[0].toBuffer(), u64le(0n)], marketProgram.programId);
    const posPda = (m: PublicKey, b: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), b.toBuffer()], marketProgram.programId)[0];

    await marketProgram.methods
      .createLadder(legPks[0], new anchor.BN(0), 0, FAR_FUTURE, FAR_FUTURE)
      .accounts({ authority: owner.publicKey, ladder: mkt })
      .remainingAccounts(legPks.map(legMeta))
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    const bettors = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await fund(provider, owner, bettors[0].publicKey, 0.4 * LAMPORTS_PER_SOL);
    await fund(provider, owner, bettors[1].publicKey, 0.3 * LAMPORTS_PER_SOL);
    await fund(provider, owner, bettors[2].publicKey, 0.3 * LAMPORTS_PER_SOL);
    // Winners split the WHOLE pot pro-rata on their winning stakes:
    // 0.15 on A + 0.05 on B back co-leaders; 0.10 on C is dead money.
    const stakes = [0.15, 0.05, 0.10];
    for (let i = 0; i < 3; i++) {
      await marketProgram.methods.betLadder(i, new anchor.BN(stakes[i] * LAMPORTS_PER_SOL))
        .accounts({ bettor: bettors[i].publicKey, ladder: mkt, position: posPda(mkt, bettors[i].publicKey) })
        .remainingAccounts(legPks.map(legMeta))
        .signers([bettors[i]]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }

    const score = async (kp: Keypair, run: PublicKey, idx: bigint, outputs: bigint[], outLeaves: Uint8Array[]) => {
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(idx.toString()), 0, outputs.map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
        .accountsPartial({ payer: kp.publicKey, run, runner: kp.publicKey, chunk, ...arciumAccounts(offset, "score_chunk") })
        .signers([kp])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    };
    for (let i = 0; i < 3; i++) await score(runners[i], legPks[i], idx0 + BigInt(i), legs[i].outputs, legs[i].outLeaves);

    await marketProgram.methods.resolveLadder()
      .accounts({ ladder: mkt })
      .remainingAccounts(legPks.map(legMeta))
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const l = await marketProgram.account.ladder.fetch(mkt);
    expect(l.status).to.equal(1, "resolved");
    expect(l.resultMask).to.equal(0b011, "legs 0+1 dead-heat");
    expect(l.resolvedScore).to.equal(25);

    // Pro-rata split: bettor0 takes 0.15/0.20 of the 0.30 pot = 0.225,
    // bettor1 takes 0.05/0.20 = 0.075, bettor2 (loser) gets nothing.
    // Claiming also closes the Position PDA — its rent comes back too.
    const claims = [0.225, 0.075, 0];
    for (let i = 0; i < 3; i++) {
      const pos = posPda(mkt, bettors[i].publicKey);
      const rent = (await provider.connection.getAccountInfo(pos))?.lamports ?? 0;
      const before = await provider.connection.getBalance(bettors[i].publicKey);
      try {
        await marketProgram.methods.claimLadder()
          .accounts({ bettor: bettors[i].publicKey, ladder: mkt, position: pos })
          .signers([bettors[i]])
          .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      } catch (e) {
        expect(claims[i]).to.equal(0, "only losers' claims may fail");
        continue;
      }
      const after = await provider.connection.getBalance(bettors[i].publicKey);
      expect(after - before).to.be.approximately(claims[i] * LAMPORTS_PER_SOL + rent, 20000, `leg ${i} pro-rata share + rent`);
    }
    console.log("dead-heat settled: 25/25/10 — mask 0b011, winners split the loser's stake pro-rata");
  });

  it("settles a dark market — sealed positions reveal for the pot, no-shows forfeit", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(GEN_ID)],
      program.programId,
    );
    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [itemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);

    const truth = decodeItemChunk(Buffer.from((await provider.connection.getAccountInfo(itemsPda))!.data)).specs.map(evalSpec);
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.4 * LAMPORTS_PER_SOL);
    const idx0 = BigInt((await program.account.benchmark.fetch(benchmark)).runCount.toString());
    const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(idx0)], program.programId);
    const outputs = truth.map((v, j) => (j < 30 ? genAnswerHash(GEN_ID, j, v) : randomU64()));
    const outLeaves = [chunkOutLeaf(0, outputs)];
    await program.methods
      .createRun("dark/model-a", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    const darkPda = (r: PublicKey, salt: bigint) =>
      PublicKey.findProgramAddressSync([Buffer.from("dark"), r.toBuffer(), u64le(salt)], marketProgram.programId)[0];
    const darkPosPda = (mkt: PublicKey, bettor: PublicKey, posSalt: bigint) =>
      PublicKey.findProgramAddressSync([Buffer.from("darkpos"), mkt.toBuffer(), bettor.toBuffer(), u64le(posSalt)], marketProgram.programId)[0];
    // sha256("sealed/dark" || market || bettor || outcome u8 || amount u64le || salt[32])
    const commitment = (mkt: PublicKey, bettor: PublicKey, outcome: number, lamports: bigint, salt: Buffer) =>
      Buffer.from(sha256(concatBytes(utf8ToBytes("sealed/dark"), mkt.toBuffer(), bettor.toBuffer(), new Uint8Array([outcome]), u64le(lamports), salt)));

    // Binary market: score <20 vs >=20; planted 30 → outcome 1. 60s reveal
    // window (the on-chain floor) so the test can reach finalize_dark.
    const mkt = darkPda(run, 0n);
    await marketProgram.methods
      .createDark(new anchor.BN(0), [20], 200, new anchor.BN(0), FAR_FUTURE, new anchor.BN(60))
      .accounts({ authority: owner.publicKey, run, darkMarket: mkt })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    let m: any = await (marketProgram.account as any).darkMarket.fetch(mkt);
    expect(m.status).to.equal(0, "open");
    expect(m.revealSecs.toNumber()).to.equal(60);

    // Three sealed positions — the commitment is the only thing on-chain.
    const bettors = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    for (const b of bettors) await fund(provider, owner, b.publicKey, 0.5 * LAMPORTS_PER_SOL);
    const bets = [
      { bettor: bettors[0], outcome: 1, lamports: BigInt(0.30 * LAMPORTS_PER_SOL), salt: randomBytes(32) },
      { bettor: bettors[1], outcome: 1, lamports: BigInt(0.20 * LAMPORTS_PER_SOL), salt: randomBytes(32) }, // never reveals → forfeits
      { bettor: bettors[2], outcome: 0, lamports: BigInt(0.10 * LAMPORTS_PER_SOL), salt: randomBytes(32) }, // loser
    ];
    for (const [i, b] of bets.entries()) {
      await marketProgram.methods
        .darkBet(new anchor.BN(0), Array.from(commitment(mkt, b.bettor.publicKey, b.outcome, b.lamports, b.salt)), new anchor.BN(b.lamports.toString()))
        .accounts({ bettor: b.bettor.publicKey, run, darkMarket: mkt, position: darkPosPda(mkt, b.bettor.publicKey, 0n) })
        .signers([b.bettor])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    }
    m = await (marketProgram.account as any).darkMarket.fetch(mkt);
    expect(m.poolTotal.toNumber()).to.equal(0.6 * LAMPORTS_PER_SOL);
    // Positions carry commitments, not outcomes — the chain saw nothing.
    const pos0: any = await (marketProgram.account as any).darkPosition.fetch(darkPosPda(mkt, bettors[0].publicKey, 0n));
    expect(pos0.revealed).to.equal(255, "still sealed");

    // Revealing before resolution is meaningless — the outcome doesn't exist.
    await expectAnchorError(
      marketProgram.methods
        .revealDark(new anchor.BN(0), 1, Array.from(bets[0].salt))
        .accounts({ bettor: bettors[0].publicKey, market: mkt, position: darkPosPda(mkt, bettors[0].publicKey, 0n) })
        .signers([bettors[0]])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "MarketNotResolved",
    );

    // MPC scores the run (planted 30 → bucket 1), then resolve opens the window.
    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .scoreChunk(offset, new anchor.BN(idx0.toString()), 0, outputs.map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
      .accountsPartial({ payer: runner.publicKey, run, runner: runner.publicKey, chunk, ...arciumAccounts(offset, "score_chunk") })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    expect((await program.account.run.fetch(run)).correct).to.equal(30);

    await marketProgram.methods
      .resolveDark()
      .accounts({ run, darkMarket: mkt })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    m = await (marketProgram.account as any).darkMarket.fetch(mkt);
    expect(m.status).to.equal(1, "resolved");
    expect(m.outcome).to.equal(1, "30 >= 20");
    expect(m.revealUntil.toNumber()).to.be.greaterThan(0);

    // A wrong preimage or a mis-stated outcome fails the commitment check.
    await expectAnchorError(
      marketProgram.methods
        .revealDark(new anchor.BN(0), 1, Array.from(randomBytes(32)))
        .accounts({ bettor: bettors[0].publicKey, market: mkt, position: darkPosPda(mkt, bettors[0].publicKey, 0n) })
        .signers([bettors[0]])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "BadReveal",
    );
    await expectAnchorError(
      marketProgram.methods
        .revealDark(new anchor.BN(0), 0, Array.from(bets[0].salt))
        .accounts({ bettor: bettors[0].publicKey, market: mkt, position: darkPosPda(mkt, bettors[0].publicKey, 0n) })
        .signers([bettors[0]])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "BadReveal",
    );

    // Winner reveals → win_total grows; loser reveals → recorded, pot unchanged.
    await marketProgram.methods
      .revealDark(new anchor.BN(0), 1, Array.from(bets[0].salt))
      .accounts({ bettor: bettors[0].publicKey, market: mkt, position: darkPosPda(mkt, bettors[0].publicKey, 0n) })
      .signers([bettors[0]])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    m = await (marketProgram.account as any).darkMarket.fetch(mkt);
    expect(m.revealedCount).to.equal(1);
    expect(m.winTotal.toNumber()).to.equal(0.30 * LAMPORTS_PER_SOL);
    await expectAnchorError(
      marketProgram.methods
        .revealDark(new anchor.BN(0), 1, Array.from(bets[0].salt))
        .accounts({ bettor: bettors[0].publicKey, market: mkt, position: darkPosPda(mkt, bettors[0].publicKey, 0n) })
        .signers([bettors[0]])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "AlreadyRevealed",
    );
    await marketProgram.methods
      .revealDark(new anchor.BN(0), 0, Array.from(bets[2].salt))
      .accounts({ bettor: bettors[2].publicKey, market: mkt, position: darkPosPda(mkt, bettors[2].publicKey, 0n) })
      .signers([bettors[2]])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    m = await (marketProgram.account as any).darkMarket.fetch(mkt);
    expect(m.revealedCount).to.equal(2);
    expect(m.winTotal.toNumber()).to.equal(0.30 * LAMPORTS_PER_SOL, "losing reveals don't count");

    // bettor[1] never reveals — their winning stake forfeits into the pot.
    await new Promise((r) => setTimeout(r, 63_000));
    await marketProgram.methods.finalizeDark().accounts({ darkMarket: mkt }).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    m = await (marketProgram.account as any).darkMarket.fetch(mkt);
    expect(m.tallied).to.equal(true);
    await expectAnchorError(
      marketProgram.methods
        .revealDark(new anchor.BN(0), 1, Array.from(bets[1].salt))
        .accounts({ bettor: bettors[1].publicKey, market: mkt, position: darkPosPda(mkt, bettors[1].publicKey, 0n) })
        .signers([bettors[1]])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "RevealWindowClosed",
    );

    // Sole revealed winner takes the whole net pot (losers' + forfeited stakes):
    // pool 0.60 − fee 2% (0.012) = 0.588. Loser and no-show close for rent only.
    const expected = [0.588, 0, 0];
    for (const [i, b] of bets.entries()) {
      const pos = darkPosPda(mkt, b.bettor.publicKey, 0n);
      const rent = (await provider.connection.getAccountInfo(pos))?.lamports ?? 0;
      const before = await provider.connection.getBalance(b.bettor.publicKey);
      await marketProgram.methods
        .claimDark(new anchor.BN(0))
        .accounts({ bettor: b.bettor.publicKey, market: mkt, position: pos })
        .signers([b.bettor])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      const after = await provider.connection.getBalance(b.bettor.publicKey);
      expect(after - before).to.be.approximately(expected[i] * LAMPORTS_PER_SOL + rent, 20000, `position ${i} payout + rent`);
    }
    // Authority sweeps the 2% fee.
    const feeBefore = await provider.connection.getBalance(owner.publicKey);
    await marketProgram.methods.claimFeeDark().accounts({ authority: owner.publicKey, darkMarket: mkt }).signers([owner]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const feeAfter = await provider.connection.getBalance(owner.publicKey);
    expect(feeAfter - feeBefore).to.be.approximately(0.012 * LAMPORTS_PER_SOL, 20000, "2% fee sweep");
    console.log("dark settled: sealed 0.30/0.20/0.10 → sole revealed winner took 0.588 net pot, no-show forfeited, fee 0.012");
  });

  it("voids a dark market and refunds sealed positions without a preimage", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(GEN_ID)],
      program.programId,
    );
    const [itemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);
    const truth = decodeItemChunk(Buffer.from((await provider.connection.getAccountInfo(itemsPda))!.data)).specs.map(evalSpec);
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.4 * LAMPORTS_PER_SOL);
    const idx0 = BigInt((await program.account.benchmark.fetch(benchmark)).runCount.toString());
    const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(idx0)], program.programId);
    const outputs = truth.map((v, j) => (j < 5 ? genAnswerHash(GEN_ID, j, v) : randomU64()));
    const outLeaves = [chunkOutLeaf(0, outputs)];
    await program.methods
      .createRun("dark/model-b", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    const darkPda = (r: PublicKey, salt: bigint) =>
      PublicKey.findProgramAddressSync([Buffer.from("dark"), r.toBuffer(), u64le(salt)], marketProgram.programId)[0];
    const darkPosPda = (mkt: PublicKey, bettor: PublicKey, posSalt: bigint) =>
      PublicKey.findProgramAddressSync([Buffer.from("darkpos"), mkt.toBuffer(), bettor.toBuffer(), u64le(posSalt)], marketProgram.programId)[0];
    const commitment = (mkt: PublicKey, bettor: PublicKey, outcome: number, lamports: bigint, salt: Buffer) =>
      Buffer.from(sha256(concatBytes(utf8ToBytes("sealed/dark"), mkt.toBuffer(), bettor.toBuffer(), new Uint8Array([outcome]), u64le(lamports), salt)));

    const mkt = darkPda(run, 0n);
    await marketProgram.methods
      .createDark(new anchor.BN(0), [20], 0, new anchor.BN(0), FAR_FUTURE, new anchor.BN(60))
      .accounts({ authority: owner.publicKey, run, darkMarket: mkt })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const bettor = Keypair.generate();
    await fund(provider, owner, bettor.publicKey, 0.3 * LAMPORTS_PER_SOL);
    const lamports = BigInt(0.05 * LAMPORTS_PER_SOL);
    await marketProgram.methods
      .darkBet(new anchor.BN(0), Array.from(commitment(mkt, bettor.publicKey, 1, lamports, randomBytes(32))), new anchor.BN(lamports.toString()))
      .accounts({ bettor: bettor.publicKey, run, darkMarket: mkt, position: darkPosPda(mkt, bettor.publicKey, 0n) })
      .signers([bettor])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // Only the market authority can void — and only while the run is unscored.
    const stranger = Keypair.generate();
    await fund(provider, owner, stranger.publicKey, 0.05 * LAMPORTS_PER_SOL);
    await expectAnchorError(
      marketProgram.methods.voidDark().accounts({ authority: stranger.publicKey, run, darkMarket: mkt }).signers([stranger]).rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "NotAuthority",
    );
    await marketProgram.methods.voidDark().accounts({ authority: owner.publicKey, run, darkMarket: mkt }).signers([owner]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const m: any = await (marketProgram.account as any).darkMarket.fetch(mkt);
    expect(m.status).to.equal(2, "cancelled");

    // Cancelled → full refund, no preimage needed (amounts were never hidden).
    const pos = darkPosPda(mkt, bettor.publicKey, 0n);
    const rent = (await provider.connection.getAccountInfo(pos))?.lamports ?? 0;
    const before = await provider.connection.getBalance(bettor.publicKey);
    await marketProgram.methods
      .claimDark(new anchor.BN(0))
      .accounts({ bettor: bettor.publicKey, market: mkt, position: pos })
      .signers([bettor])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const after = await provider.connection.getBalance(bettor.publicKey);
    expect(after - before).to.be.approximately(Number(lamports) + rent, 20000, "full refund + rent");
    console.log("dark voided: sealed 0.05 refunded in full without revealing the preimage");
  });

  it("pending sweeps are liveness-only — markets stay latched, swept computations still land", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(AUTH_ID)],
      program.programId,
    );
    let b: any = await program.account.benchmark.fetch(benchmark);
    expect(b.status).to.equal(1, "auth bank still live");
    const runIndex = b.runCount.toNumber();
    const [runP] = PublicKey.findProgramAddressSync(
      [Buffer.from("run"), benchmark.toBuffer(), u64le(BigInt(runIndex))],
      program.programId,
    );
    const chunks = [0, 1].map(
      (i) => PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(i)], program.programId)[0],
    );

    // All-correct run (64/64) committed before any scoring.
    const runOutputs = [answers[0], answers[1]];
    const outLeaves = runOutputs.map((c, i) => chunkOutLeaf(i, c));
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.3 * LAMPORTS_PER_SOL);
    const BN0 = new anchor.BN(0);
    await program.methods
      .createRun("test/sweep-run", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run: runP })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // A second run that is never scored — the dead-run leg of the duel below.
    const idxQ = runIndex + 1;
    const [runQ] = PublicKey.findProgramAddressSync(
      [Buffer.from("run"), benchmark.toBuffer(), u64le(BigInt(idxQ))],
      program.programId,
    );
    const runnerQ = Keypair.generate();
    await fund(provider, owner, runnerQ.publicKey, 0.15 * LAMPORTS_PER_SOL);
    await program.methods
      .createRun("test/dead-run", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runnerQ.publicKey, authority: owner.publicKey, benchmark, run: runQ })
      .signers([runnerQ])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // Unreachable buckets are rejected: edges[0]==0 makes bucket 0 unwinnable.
    const mktPdaX = (salt: bigint) =>
      PublicKey.findProgramAddressSync([Buffer.from("market"), runP.toBuffer(), u64le(salt)], marketProgram.programId)[0];
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(20), [0, 30], 0, BN0, FAR_FUTURE)
        .accounts({ authority: owner.publicKey, run: runP, market: mktPdaX(20n) })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "InvalidEdges",
    );

    // Real market + a bettor.
    const mkt = mktPdaX(21n);
    const posPdaX = (m: PublicKey, bettor: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), bettor.toBuffer()], marketProgram.programId)[0];
    await marketProgram.methods
      .createMarket(new anchor.BN(21), [40], 0, BN0, FAR_FUTURE)
      .accounts({ authority: owner.publicKey, run: runP, market: mkt })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const bettor = Keypair.generate();
    await fund(provider, owner, bettor.publicKey, 0.3 * LAMPORTS_PER_SOL);
    await marketProgram.methods
      .bet(1, new anchor.BN(0.1 * LAMPORTS_PER_SOL))
      .accounts({ bettor: bettor.publicKey, run: runP, market: mkt, position: posPdaX(mkt, bettor.publicKey) })
      .signers([bettor])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    // Back the losing side too — an unbacked bucket cancels on resolve.
    const loser = Keypair.generate();
    await fund(provider, owner, loser.publicKey, 0.1 * LAMPORTS_PER_SOL);
    await marketProgram.methods
      .bet(0, new anchor.BN(0.05 * LAMPORTS_PER_SOL))
      .accounts({ bettor: loser.publicKey, run: runP, market: mkt, position: posPdaX(mkt, loser.publicKey) })
      .signers([loser])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });

    // Duel: runP vs runQ, created while both are still pending.
    const duelPdaX = (a: PublicKey, bb: PublicKey, salt: bigint) =>
      PublicKey.findProgramAddressSync([Buffer.from("duel"), a.toBuffer(), bb.toBuffer(), u64le(salt)], marketProgram.programId)[0];
    const mktD = duelPdaX(runP, runQ, 0n);
    const resolveBy = Math.floor(Date.now() / 1000) + 70;
    await marketProgram.methods
      .createDuel(new anchor.BN(0), 0, BN0, new anchor.BN(resolveBy))
      .accounts({ authority: owner.publicKey, runA: runP, runB: runQ, market: mktD })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await marketProgram.methods
      .betDuel(0, new anchor.BN(0.05 * LAMPORTS_PER_SOL))
      .accounts({ bettor: bettor.publicKey, runA: runP, runB: runQ, market: mktD, position: posPdaX(mktD, bettor.publicKey) })
      .signers([bettor])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    // Before the deadline even the dead run can't cancel the market.
    await expectAnchorError(
      marketProgram.methods.expireMarket().accounts({ market: mktD, runA: runP, runB: runQ }).rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "MarketNotExpired",
    );

    // Queue chunk-0 scoring — the pending_since latch sets and betting closes.
    const off0 = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .scoreChunk(off0, new anchor.BN(runIndex), 0, runOutputs[0].map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 0))
      .accountsPartial({ payer: runner.publicKey, run: runP, runner: runner.publicKey, chunk: chunks[0], ...arciumAccounts(off0, "score_chunk") })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    let r: any = await program.account.run.fetch(runP);
    expect(r.pendingSince.toNumber()).to.be.greaterThan(0, "scoring-start latch set");

    await expectAnchorError(
      marketProgram.methods
        .bet(0, new anchor.BN(1000))
        .accounts({ bettor: bettor.publicKey, run: runP, market: mkt, position: posPdaX(mkt, bettor.publicKey) })
        .signers([bettor])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "ScoringStarted",
    );

    // A stranger cannot sweep a live pending bit before the timeout.
    const stranger = Keypair.generate();
    await fund(provider, owner, stranger.publicKey, 0.05 * LAMPORTS_PER_SOL);
    await expectAnchorError(
      program.methods
        .resetPending(new anchor.BN(runIndex), 0)
        .accounts({ sweeper: stranger.publicKey, run: runP })
        .signers([stranger])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "NotRunner",
    );

    // The runner sweeps the in-flight bit (e.g. the computation died).
    await program.methods
      .resetPending(new anchor.BN(runIndex), 0)
      .accounts({ sweeper: runner.publicKey, run: runP })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    r = await program.account.run.fetch(runP);
    expect(r.pendingMask.toNumber() & 1).to.equal(0, "bit swept");
    expect(r.pendingSince.toNumber()).to.be.greaterThan(0, "latch stays set");
    expect(r.firstPendingAt.toNumber()).to.be.greaterThan(0, "first-queue horizon recorded");

    // Nobody can sweep a bit that isn't pending.
    await expectAnchorError(
      program.methods
        .resetPending(new anchor.BN(runIndex), 1)
        .accounts({ sweeper: stranger.publicKey, run: runP })
        .signers([stranger])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "ChunkNotPending",
    );

    // Betting stays closed AND new markets are refused — the latch is
    // permanent; a sweep is a liveness tool, never a window to trade on a
    // leaked in-flight result.
    await expectAnchorError(
      marketProgram.methods
        .bet(1, new anchor.BN(1000))
        .accounts({ bettor: bettor.publicKey, run: runP, market: mkt, position: posPdaX(mkt, bettor.publicKey) })
        .signers([bettor])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "ScoringStarted",
    );
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(22), [40], 0, BN0, FAR_FUTURE)
        .accounts({ authority: owner.publicKey, run: runP, market: mktPdaX(22n) })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "ScoringStarted",
    );

    // The swept computation still lands — its output is deterministic over the
    // committed inputs, so applying it is correct and nothing is orphaned.
    await awaitComputationFinalization(provider, off0, program.programId, "confirmed");
    r = await program.account.run.fetch(runP);
    expect(r.scoredMask.toNumber() & 1).to.not.equal(0, "swept computation applied");

    // Chunk 1 scores normally; run finalizes; the market resolves itself.
    const off1 = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .scoreChunk(off1, new anchor.BN(runIndex), 1, runOutputs[1].map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, 1))
      .accountsPartial({ payer: runner.publicKey, run: runP, runner: runner.publicKey, chunk: chunks[1], ...arciumAccounts(off1, "score_chunk") })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await awaitComputationFinalization(provider, off1, program.programId, "confirmed");
    r = await program.account.run.fetch(runP);
    expect(r.status).to.equal(1, "finalized");
    expect(r.correct).to.equal(64);

    // Attestation works once, not twice.
    await program.methods
      .attestRun(new anchor.BN(runIndex))
      .accounts({ authority: owner.publicKey, benchmark, run: runP })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await expectAnchorError(
      program.methods
        .attestRun(new anchor.BN(runIndex))
        .accounts({ authority: owner.publicKey, benchmark, run: runP })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "AlreadyAttested",
    );

    await marketProgram.methods.resolve().accounts({ run: runP, market: mkt }).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    // Prove it was a real WIN, not a cancelled-market refund: both buckets were
    // backed and outcome 1 (yes-bucket) must be settled.
    const mAfterResolve = await marketProgram.account.market.fetch(mkt);
    expect(mAfterResolve.status).to.equal(1, "market resolved, not cancelled");
    expect(mAfterResolve.outcome).to.equal(1, "yes bucket won at 64/64");
    const before = await provider.connection.getBalance(bettor.publicKey);
    await marketProgram.methods
      .claim()
      .accounts({ bettor: bettor.publicKey, market: mkt, position: posPdaX(mkt, bettor.publicKey) })
      .signers([bettor])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const after = await provider.connection.getBalance(bettor.publicKey);
    expect(after).to.be.greaterThan(before, "winner paid after swept computation landed");

    // Duel expiry dead-run bail: runP finalized but runQ was never scored —
    // after resolve_by passes anyone can cancel the duel and refund bettors.
    await waitChainTs(provider, resolveBy);
    await marketProgram.methods
      .expireMarket()
      .accounts({ market: mktD, runA: runP, runB: runQ })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const md = await marketProgram.account.market.fetch(mktD);
    expect(md.status).to.equal(2, "dead-run duel expired and refundable");
    const rBefore = await provider.connection.getBalance(bettor.publicKey);
    await marketProgram.methods
      .claim()
      .accounts({ bettor: bettor.publicKey, market: mktD, position: posPdaX(mktD, bettor.publicKey) })
      .signers([bettor])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    expect(await provider.connection.getBalance(bettor.publicKey)).to.be.greaterThan(
      rBefore,
      "expired duel refunded the bettor",
    );

    // A retired bank refuses all further mutation.
    const RET_ID = 9000 + ID_SALT;
    const [benchR] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(RET_ID)],
      program.programId,
    );
    await program.methods
      .createBenchmark(RET_ID, "sealed-retire", 1, Array.from(randomBytes(32)), BN0, 0)
      .accounts({ authority: owner.publicKey })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await program.methods
      .retireBenchmark()
      .accounts({ authority: owner.publicKey, benchmark: benchR })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const [chunkR] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchR.toBuffer(), u16le(0)], program.programId);
    await expectAnchorError(
      program.methods
        .initChunk(0)
        .accounts({ authority: owner.publicKey, benchmark: benchR, chunk: chunkR })
        .signers([owner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" }),
      "BenchmarkRetired",
    );
    console.log("sweep latch, swept-callback landing, edges bound, double-attest, duel-expire bail, retire guard — all verified");
  });

  it("ensures the shared signer PDA exists and is grief-recoverable", async () => {
    // init_signer_pda is idempotent: already-initialized → Ok. The drain path
    // (prefunded PDA → lamports returned to payer, account created anyway)
    // needs a fresh ledger to exercise — epoch-4+ wipe coverage.
    const [signPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ArciumSignerAccount")],
      program.programId,
    );
    const before = await provider.connection.getAccountInfo(signPda);
    expect(before, "signer PDA must already exist (chain init / first queue)").to.not.equal(null);
    await program.methods
      .initSignerPda()
      .accounts({ payer: owner.publicKey, signPdaAccount: signPda })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const after = await provider.connection.getAccountInfo(signPda);
    expect(after!.data.length).to.equal(9);
  });

  it("unbrick_pda reclaims grief prefunds and guards against wrong-seed drains", async () => {
    // Anchor's `init` codegen already tolerates a prefunded PDA (it tops up
    // to rent-exempt then allocate+assigns — the attacker's dust becomes a
    // rent subsidy). `unbrick_pda` closes the loop: anyone can sweep the
    // grief dust back out BEFORE init, so the prefunder loses their lamports
    // and gains nothing. This test asserts the reclaim contract + guards.
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(AUTH_ID)],
      program.programId,
    );
    const bank: any = await program.account.benchmark.fetch(benchmark);
    const idx = BigInt(bank.runCount.toString());
    const seeds = [Buffer.from("run"), benchmark.toBuffer(), u64le(idx)];
    const [runPda, bump] = PublicKey.findProgramAddressSync(seeds, program.programId);

    // Grief: dust onto the next run's PDA. Rent-exempt enforcement means the
    // attacker must prefund at least the 0-data minimum — still ~0.0009 SOL.
    const griefLamports = await provider.connection.getMinimumBalanceForRentExemption(0);
    await sendWithRetry(() => provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: runPda, lamports: griefLamports }),
      ),
      [owner],
      { preflightCommitment: "processed", commitment: "confirmed" },
    ));

    // unbrick_pda sweeps the prefund to the rescuer.
    const rescuerBefore = await provider.connection.getBalance(owner.publicKey);
    await program.methods
      .unbrickPda(seeds, bump)
      .accounts({ rescuer: owner.publicKey, pda: runPda })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    // A fully-drained account is garbage-collected — either null or zero
    // lamports, both un-block `create_account`.
    const drained = await provider.connection.getAccountInfo(runPda);
    expect(drained === null || drained.lamports === 0).to.equal(true);
    const rescuerAfter = await provider.connection.getBalance(owner.publicKey);
    expect(rescuerAfter - rescuerBefore).to.be.greaterThan(0); // dust recovered (minus fee)

    // Wrong seeds can't drain — the proof pins drains to real PDAs.
    await expectAnchorError(
      program.methods
        .unbrickPda([Buffer.from("run"), benchmark.toBuffer(), u64le(idx + 1n)], bump)
        .accounts({ rescuer: owner.publicKey, pda: runPda })
        .signers([owner])
        .rpc(),
      "NotProgramPda",
    );

    // Init lands on the cleaned PDA.
    await program.methods
      .createRun("post-grief", new Array(32).fill(0), new Array(32).fill(0))
      .accounts({ runner: owner.publicKey, authority: owner.publicKey, benchmark, run: runPda })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const r: any = await program.account.run.fetch(runPda);
    expect(r.index.toString()).to.equal(idx.toString());

    // And once initialized, unbrick must refuse — it can never drain a live
    // program-owned account.
    await expectAnchorError(
      program.methods
        .unbrickPda(seeds, bump)
        .accounts({ rescuer: owner.publicKey, pda: runPda })
        .signers([owner])
        .rpc(),
      "NotGriefedPda",
    );
  });

  it("pays a capability bounty to the qualifying run's operator — FCFS, not a bet", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(AUTH_ID)],
      program.programId,
    );
    const chunkPdas = [0, 1].map(
      (i) => PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(i)], program.programId)[0],
    );
    const CHUNKS = 2; // the shared authored bank (AUTH_ID) is 2 chunks
    const bountyPda = (bank: PublicKey, sponsor: PublicKey, salt: bigint) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("bounty"), bank.toBuffer(), sponsor.toBuffer(), u64le(salt)],
        marketProgram.programId,
      )[0];

    const THRESHOLD = 32; // 64 max on this 2-chunk bank
    const POT = new anchor.BN(0.2 * LAMPORTS_PER_SOL);

    // Threshold above the bank's max score is bait — rejected at creation.
    await expectAnchorError(
      marketProgram.methods
        .createBounty(new anchor.BN(0), CHUNK * 2 + 1, POT, FAR_FUTURE)
        .accounts({ sponsor: owner.publicKey, bank: benchmark, bounty: bountyPda(benchmark, owner.publicKey, 0n) })
        .signers([owner])
        .rpc(),
      "InvalidThreshold",
    );

    const bounty = bountyPda(benchmark, owner.publicKey, 1n);
    await marketProgram.methods
      .createBounty(new anchor.BN(1), THRESHOLD, POT, FAR_FUTURE)
      .accounts({ sponsor: owner.publicKey, bank: benchmark, bounty })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    let b: any = await marketProgram.account.bounty.fetch(bounty);
    expect(b.status).to.equal(0);
    expect(b.amount.toNumber()).to.equal(POT.toNumber());

    // The retroactivity wall: an existing finalized run PREDATING the bounty
    // cannot claim it — a sponsor can't self-deal on an already-known result.
    const [run0] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(0n)], program.programId);
    const r0runner = (await program.account.run.fetch(run0)).runner;
    await expectAnchorError(
      marketProgram.methods
        .claimBounty()
        .accounts({ run: run0, bounty, payee: r0runner })
        .rpc(),
      "BelowThreshold",
    );

    // A new run, created after the bounty, scoring >= threshold, claims it.
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.5 * LAMPORTS_PER_SOL);
    const idx = BigInt((await program.account.benchmark.fetch(benchmark)).runCount.toString());
    const [run2] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(idx)], program.programId);
    const planted = [20, 20]; // 40/64 — clears the 32 bar
    const runOutputs: bigint[][] = answers.map((chunk, i) =>
      chunk.map((a, j) => (j < planted[i] ? a : randomU64())),
    );
    const outLeaves = runOutputs.map((chunk, i) => chunkOutLeaf(i, chunk));
    await program.methods
      .createRun("test/bounty-claimant", Array.from(randomBytes(32)), Array.from(merkleRoot(outLeaves)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run: run2 })
      .signers([runner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    for (let i = 0; i < CHUNKS; i++) {
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(idx.toString()), i, runOutputs[i].map((o) => new anchor.BN(o.toString())), merkleProof(outLeaves, i))
        .accountsPartial({ payer: runner.publicKey, run: run2, runner: runner.publicKey, chunk: chunkPdas[i], ...arciumAccounts(offset, "score_chunk") })
        .signers([runner])
        .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    }
    const r2 = await program.account.run.fetch(run2);
    expect(r2.status).to.equal(1, "finalized");
    expect(r2.correct).to.equal(40);

    // The claim is permissionless — a THIRD PARTY triggers it, the pot still
    // lands on run.runner (the operator who earned the score).
    const trigger = Keypair.generate();
    await fund(provider, owner, trigger.publicKey, 0.05 * LAMPORTS_PER_SOL);
    const runnerBefore = await provider.connection.getBalance(runner.publicKey);
    // trigger is the actual fee payer — a real third-party claim, not the
    // provider wallet.
    const claimTx = await marketProgram.methods
      .claimBounty()
      .accounts({ run: run2, bounty, payee: runner.publicKey })
      .transaction();
    const claimSig = await provider.connection.sendTransaction(claimTx, [trigger]);
    await provider.connection.confirmTransaction(claimSig, "confirmed");
    const runnerAfter = await provider.connection.getBalance(runner.publicKey);
    expect(runnerAfter - runnerBefore).to.equal(POT.toNumber(), "pot paid to the run's operator, not the trigger");
    b = await marketProgram.account.bounty.fetch(bounty);
    expect(b.status).to.equal(1);
    expect(b.winningScore).to.equal(40);
    expect(b.winnerRun.toBase58()).to.equal(run2.toBase58());

    // A payout directed anywhere but run.runner is rejected.
    // (already claimed — also proves double-claim is impossible)
    await expectAnchorError(
      marketProgram.methods
        .claimBounty()
        .accounts({ run: run2, bounty, payee: trigger.publicKey })
        .rpc(),
      "MarketNotOpen",
    );

    // A second bounty with a 60s deadline expires permissionlessly → refund.
    const bounty2 = bountyPda(benchmark, owner.publicKey, 2n);
    const shortDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 62);
    await marketProgram.methods
      .createBounty(new anchor.BN(2), THRESHOLD, POT, shortDeadline)
      .accounts({ sponsor: owner.publicKey, bank: benchmark, bounty: bounty2 })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    // Before the deadline, expiry is rejected.
    await expectAnchorError(
      marketProgram.methods.expireBounty().accounts({ bounty: bounty2, sponsor: owner.publicKey }).rpc(),
      "MarketNotExpired",
    );
    while ((await chainNow(provider)) <= shortDeadline.toNumber())
      await new Promise((r) => setTimeout(r, 2000));
    const sponsorBefore = await provider.connection.getBalance(owner.publicKey);
    await marketProgram.methods
      .expireBounty()
      .accounts({ bounty: bounty2, sponsor: owner.publicKey })
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const sponsorAfter = await provider.connection.getBalance(owner.publicKey);
    expect(sponsorAfter - sponsorBefore).to.be.greaterThan(POT.toNumber() - 50_000, "sponsor gets pot + rent back");
    expect(await marketProgram.account.bounty.fetchNullable(bounty2)).to.equal(null, "expired bounty closed");
    console.log("bounty lifecycle verified: threshold cap, retroactivity wall, FCFS claim -> operator, refund expiry");
  });

  // LAST on purpose: spoils AUTH_ID for new runs — every earlier consumer of
  // that bank must already have created what it needs.
  it("declassifies one part's fingerprints for a spot-check audit", async () => {
    await initCompDef("reveal_part", () => program.methods.initRevealPartCompDef());
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(AUTH_ID)],
      program.programId,
    );
    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [reveal] = PublicKey.findProgramAddressSync(
      [Buffer.from("reveal"), benchmark.toBuffer(), u16le(0), Uint8Array.of(0)],
      program.programId,
    );

    // a stranger cannot queue a reveal — authority gate
    const stranger = Keypair.generate();
    await fund(provider, owner, stranger.publicKey, 0.1 * LAMPORTS_PER_SOL);
    const badOffset = new anchor.BN(randomBytes(8), "hex");
    const [badReveal] = PublicKey.findProgramAddressSync(
      [Buffer.from("reveal"), benchmark.toBuffer(), u16le(0), Uint8Array.of(3)],
      program.programId,
    );
    await expectAnchorError(
      program.methods
        .revealPart(badOffset, 0, 3)
        .accountsPartial({
          payer: stranger.publicKey,
          benchmark,
          chunk,
          reveal: badReveal,
          ...arciumAccounts(badOffset, "reveal_part"),
        })
        .signers([stranger])
        .rpc(),
      "NotAuthority",
    );

    // authority declassifies chunk 0 part 0 — MPC returns the fingerprints
    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .revealPart(offset, 0, 0)
      .accountsPartial({ payer: owner.publicKey, benchmark, chunk, reveal, ...arciumAccounts(offset, "reveal_part") })
      .signers([owner])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    const rv: any = await program.account.reveal.fetch(reveal);
    expect(rv.revealedAt.toNumber()).to.be.greaterThan(0);
    // The test planted these answer hashes — the declassified fingerprints must
    // equal them exactly. This is the audit: anyone can now check which of the
    // run's committed output hashes match on the revealed positions.
    const revealed = rv.hashes.map((h: anchor.BN) => BigInt(h.toString()));
    expect(revealed).to.deep.equal(answers[0].slice(0, PART));
    console.log(`reveal verified: ${revealed.length} fingerprints match planted answers`);

    // revealing the same part again fails — the Reveal PDA already exists
    const again = new anchor.BN(randomBytes(8), "hex");
    await expectAnchorError(
      program.methods
        .revealPart(again, 0, 0)
        .accountsPartial({ payer: owner.publicKey, benchmark, chunk, reveal, ...arciumAccounts(again, "reveal_part") })
        .signers([owner])
        .rpc(),
      "PartAlreadyRevealed",
    );

    // F1 closed on-chain: the landed reveal bumps benchmark.reveal_count; any
    // run minted from here is permanently stamped post_reveal=1, and market
    // creation rejects flagged runs outright. Runs minted BEFORE the reveal
    // stay untainted — their outputs_root was committed pre-disclosure.
    const bAcc: any = await program.account.benchmark.fetch(benchmark);
    expect(bAcc.revealCount).to.equal(1);
    const nRuns = bAcc.runCount.toNumber();
    for (let idx = 0; idx < nRuns; idx++) {
      const [rp] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(BigInt(idx))], program.programId);
      const r: any = await program.account.run.fetch(rp);
      expect(r.postReveal, `run ${idx} predates the reveal`).to.equal(0);
    }
    const spoiled = Keypair.generate();
    await fund(provider, owner, spoiled.publicKey, 0.5 * LAMPORTS_PER_SOL);
    const [runNext] = PublicKey.findProgramAddressSync(
      [Buffer.from("run"), benchmark.toBuffer(), u64le(BigInt(nRuns))],
      program.programId,
    );
    await program.methods
      .createRun("test/post-reveal", Array.from(randomBytes(32)), Array.from(randomBytes(32)))
      .accountsPartial({ runner: spoiled.publicKey, authority: owner.publicKey, benchmark, run: runNext })
      .signers([spoiled])
      .rpc({ preflightCommitment: "processed", commitment: "confirmed" });
    const r2: any = await program.account.run.fetch(runNext);
    expect(r2.postReveal).to.equal(1);
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [mkt] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), runNext.toBuffer(), u64le(0n)],
      marketProgram.programId,
    );
    await expectAnchorError(
      marketProgram.methods
        .createMarket(new anchor.BN(0), [30], 0, new anchor.BN(0), FAR_FUTURE)
        .accounts({ authority: owner.publicKey, run: runNext, market: mkt })
        .signers([owner])
        .rpc(),
      "PostRevealRun",
    );
    console.log("F1 closed: post-reveal run stamped post_reveal=1 on-chain; create_market rejects it (PostRevealRun)");
  });
});

// ------------------------------------------------------------------ helpers

function u16le(n: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32le(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64le(n: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function randomU64(): bigint {
  return randomBytes(8).readBigUInt64LE();
}

async function dumpTx(provider: anchor.AnchorProvider, sig: string) {
  const tx = await provider.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  console.log(`--- tx ${sig} err=${JSON.stringify(tx?.meta?.err)}`);
  for (const l of tx?.meta?.logMessages ?? []) console.log("   ", l);
}

async function chainNow(provider: anchor.AnchorProvider): Promise<number> {
  const a = await provider.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  return Number(a!.data.readBigInt64LE(32));
}
async function waitChainTs(provider: anchor.AnchorProvider, ts: number) {
  while ((await chainNow(provider)) <= ts) await new Promise((r) => setTimeout(r, 2000));
}

async function fund(provider: anchor.AnchorProvider, from: Keypair, to: PublicKey, lamports: number) {
  const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  await provider.sendAndConfirm(tx, [from], { preflightCommitment: "processed", commitment: "confirmed" });
}

/** On a loaded box a tx's blockhash can expire while its simulation queues
 *  behind Arcium callback traffic — "Simulation failed: Blockhash not
 *  found". Rebuilding the tx per attempt fetches a fresh hash each time. */
async function sendWithRetry(build: () => Promise<unknown>, attempts = 4) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await build();
    } catch (e: any) {
      last = e;
      if (!String(e?.message ?? e).includes("Blockhash not found")) throw e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw last;
}

async function expectAnchorError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    const msg = String(e?.error?.errorCode?.code ?? e?.message ?? e);
    expect(msg).to.include(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function getMXEPublicKeyWithRetry(provider: anchor.AnchorProvider, programId: PublicKey, maxRetries = 20, delayMs = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const k = await getMXEPublicKey(provider, programId);
      if (k) return k;
    } catch (e) {
      console.log(`mxe pubkey attempt ${attempt} failed`, e);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("MXE public key unavailable");
}

function readKpJson(path: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path).toString())));
}
