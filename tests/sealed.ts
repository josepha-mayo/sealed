/**
 * End-to-end on Arcium localnet:
 *   init comp defs -> create benchmark -> stage + seal 2 chunks (MPC re-encryption)
 *   -> benchmark goes Live -> create run (fee paid) -> score both chunks in MPC
 *   -> Run.correct equals the planted number of matches -> run finalized
 *   -> re-scoring a chunk and staging a sealed chunk are rejected.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
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
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

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

const CHUNK = 32;
const PART = 8;
const PARTS = CHUNK / PART;

describe("Sealed", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Sealed as Program<Sealed>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
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
      .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });
    await uploadCircuit(provider, name, program.programId, fs.readFileSync(`build/${name}.arcis`), true);
    return sig;
  }

  it("seals a bank, scores a run in MPC, and finalizes", async () => {
    console.log(`init comp defs (cluster offset ${arciumEnv.arciumClusterOffset}, program ${program.programId.toBase58()})`);
    await initCompDef("seal_part", () => program.methods.initSealPartCompDef());
    await initCompDef("score_chunk", () => program.methods.initScoreChunkCompDef());
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);

    // ---------------------------------------------------------------- benchmark
    const BENCH_ID = 1;
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
      .rpc({ commitment: "confirmed" });
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
      await program.methods.initChunk(i).accounts({ authority: owner.publicKey, benchmark }).signers([owner]).rpc({ commitment: "confirmed" });

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
          .rpc({ commitment: "confirmed" });
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
          .rpc({ commitment: "confirmed" });
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
    await program.methods
      .createRun("test/oracle", Array.from(randomBytes(32)), Array.from(randomBytes(32)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ commitment: "confirmed" });
    const authorityAfter = await provider.connection.getBalance(owner.publicKey);
    // The provider wallet (owner) is the tx fee payer, so it nets FEE minus a few thousand lamports.
    expect(FEE - (authorityAfter - authorityBefore)).to.be.within(0, 20_000, "fee paid to authority");
    let r = await program.account.run.fetch(run);
    expect(r.status).to.equal(0);
    expect(r.modelId).to.equal("test/oracle");

    // ---------------------------------------------------------------- score
    const planted = [13, CHUNK];
    let total = 0;
    for (let i = 0; i < CHUNKS; i++) {
      const outputs = answers[i].map((a, j) => (j < planted[i] ? a : randomU64()));
      console.log(`score chunk ${i} (expect ${planted[i]})`);
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(0), i, outputs.map((o) => new anchor.BN(o.toString())))
        .accountsPartial({
          payer: runner.publicKey,
          run,
          runner: runner.publicKey,
          chunk: chunkPdas[i],
          ...arciumAccounts(offset, "score_chunk"),
        })
        .signers([runner])
        .rpc({ commitment: "confirmed" });
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
        .scoreChunk(again, new anchor.BN(0), 0, answers[0].map((o) => new anchor.BN(o.toString())))
        .accountsPartial({ payer: runner.publicKey, run, runner: runner.publicKey, chunk: chunkPdas[0], ...arciumAccounts(again, "score_chunk") })
        .signers([runner])
        .rpc(),
      "RunAlreadyFinalized",
    );
  });

  it("settles a parimutuel market on an MPC-scored run", async () => {
    const marketProgram = anchor.workspace.Market as Program<Market>;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(1)],
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
        .createMarket(new anchor.BN(0), [30])
        .accounts({ authority: owner.publicKey, run: run0, market: mktPda(run0) })
        .signers([owner])
        .rpc(),
      "RunNotPending",
    );

    // Run #1 is created pending; the market opens on it while unscored.
    const runner = Keypair.generate();
    await fund(provider, owner, runner.publicKey, 0.5 * LAMPORTS_PER_SOL);
    const [run1] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(1n)], program.programId);
    await program.methods
      .createRun("test/market-run", Array.from(randomBytes(32)), Array.from(randomBytes(32)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run: run1 })
      .signers([runner])
      .rpc({ commitment: "confirmed" });

    const THRESHOLD = 30;
    const mkt = mktPda(run1);
    await marketProgram.methods
      .createMarket(new anchor.BN(0), [THRESHOLD])
      .accounts({ authority: owner.publicKey, run: run1, market: mkt })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    let m = await marketProgram.account.market.fetch(mkt);
    expect(m.status).to.equal(0);
    expect(m.nOutcomes).to.equal(2);
    expect(m.edges[0]).to.equal(THRESHOLD);

    // Second market on the same run, different salt + 3-way score bands.
    const mkt3 = mktPda(run1, 1n);
    await marketProgram.methods
      .createMarket(new anchor.BN(1), [10, 20])
      .accounts({ authority: owner.publicKey, run: run1, market: mkt3 })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    // Binary market: YES(outcome1) 0.3 SOL vs NO(outcome0) 0.5 SOL.
    const yes = Keypair.generate();
    const no = Keypair.generate();
    await fund(provider, owner, yes.publicKey, 0.5 * LAMPORTS_PER_SOL);
    await fund(provider, owner, no.publicKey, 0.6 * LAMPORTS_PER_SOL);
    const noBefore = await provider.connection.getBalance(no.publicKey);
    await marketProgram.methods
      .bet(1, new anchor.BN(0.3 * LAMPORTS_PER_SOL))
      .accounts({ bettor: yes.publicKey, run: run1, market: mkt, position: posPda(mkt, yes.publicKey) })
      .signers([yes])
      .rpc({ commitment: "confirmed" });
    await marketProgram.methods
      .bet(0, new anchor.BN(0.5 * LAMPORTS_PER_SOL))
      .accounts({ bettor: no.publicKey, run: run1, market: mkt, position: posPda(mkt, no.publicKey) })
      .signers([no])
      .rpc({ commitment: "confirmed" });
    m = await marketProgram.account.market.fetch(mkt);
    expect(m.totals[0].toNumber()).to.equal(0.5 * LAMPORTS_PER_SOL);
    expect(m.totals[1].toNumber()).to.equal(0.3 * LAMPORTS_PER_SOL);

    // 3-way market needs stake on every outcome to resolve; `yes` covers all bands.
    for (let i = 0; i < 3; i++) {
      await marketProgram.methods
        .bet(i, new anchor.BN(0.01 * LAMPORTS_PER_SOL))
        .accounts({ bettor: yes.publicKey, run: run1, market: mkt3, position: posPda(mkt3, yes.publicKey) })
        .signers([yes])
        .rpc({ commitment: "confirmed" });
    }

    // MPC-score run #1 with 10+0 planted correct answers -> 10 < 30 -> NO wins.
    const planted = [10, 0];
    let total = 0;
    for (let i = 0; i < 2; i++) {
      const outputs = Array.from({ length: CHUNK }, (_, j) => new anchor.BN((j < planted[i] ? answers[i][j] : randomU64()).toString()));
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .scoreChunk(offset, new anchor.BN(1), i, outputs)
        .accountsPartial({ payer: runner.publicKey, run: run1, runner: runner.publicKey, chunk: chunkPdas[i], ...arciumAccounts(offset, "score_chunk") })
        .signers([runner])
        .rpc({ commitment: "confirmed" });
      await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
      total += planted[i];
    }
    const r1 = await program.account.run.fetch(run1);
    expect(r1.status).to.equal(1);
    expect(r1.correct).to.equal(total);

    // Betting is closed once the run is finalized.
    await expectAnchorError(
      marketProgram.methods
        .bet(0, new anchor.BN(1000))
        .accounts({ bettor: yes.publicKey, run: run1, market: mkt, position: posPda(mkt, yes.publicKey) })
        .signers([yes])
        .rpc(),
      "RunNotPending",
    );

    // Permissionless resolve: score 10 < 30 -> outcome 0 (the "<30" bucket).
    await marketProgram.methods
      .resolve()
      .accounts({ run: run1, market: mkt })
      .rpc({ commitment: "confirmed" });
    m = await marketProgram.account.market.fetch(mkt);
    expect(m.status).to.equal(1, "resolved");
    expect(m.outcome).to.equal(0, "score < threshold wins");
    expect(m.resolvedScore).to.equal(total);

    // The 3-way market resolves on the same run: score 10 lands in bucket [10,20).
    await marketProgram.methods
      .resolve()
      .accounts({ run: run1, market: mkt3 })
      .rpc({ commitment: "confirmed" });
    const m3 = await marketProgram.account.market.fetch(mkt3);
    expect(m3.status).to.equal(1);
    expect(m3.outcome).to.equal(1, "10 lands in the 10..19 band");

    // Loser has nothing to claim.
    await expectAnchorError(
      marketProgram.methods
        .claim()
        .accounts({ bettor: yes.publicKey, market: mkt, position: posPda(mkt, yes.publicKey) })
        .signers([yes])
        .rpc(),
      "NothingToClaim",
    );

    // Winner takes the whole pot (0.8 SOL) plus the position's rent back.
    await marketProgram.methods
      .claim()
      .accounts({ bettor: no.publicKey, market: mkt, position: posPda(mkt, no.publicKey) })
      .signers([no])
      .rpc({ commitment: "confirmed" });
    const noAfter = await provider.connection.getBalance(no.publicKey);
    expect(noAfter - noBefore).to.be.greaterThan(0.29 * LAMPORTS_PER_SOL, "NO bettor profited");
    console.log(`market settled: NO bettor ${noBefore / LAMPORTS_PER_SOL} -> ${noAfter / LAMPORTS_PER_SOL} SOL`);
  });

  it("mints a generated bank inside MPC and scores a run against it", async () => {
    await initCompDef("gen_part", () => program.methods.initGenPartCompDef());

    const GEN_ID = 2;
    const GCHUNKS = 1;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(GEN_ID)],
      program.programId,
    );
    // Generated banks start items_root at zero; each gen_part callback folds its specs in.
    await program.methods
      .createBenchmark(GEN_ID, "sealed-gen", GCHUNKS, Array.from(new Uint8Array(32)), new anchor.BN(0), 1)
      .accounts({ authority: owner.publicKey })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    let b = await program.account.benchmark.fetch(benchmark);
    expect(b.kind).to.equal(1);

    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [itemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);
    await program.methods.initChunk(0).accounts({ authority: owner.publicKey, benchmark }).signers([owner]).rpc({ commitment: "confirmed" });
    await program.methods.initItems(0).accounts({ authority: owner.publicKey, benchmark, items: itemsPda }).signers([owner]).rpc({ commitment: "confirmed" });

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
      console.log(`gen_part chunk 0 part ${p}`);
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .genPart(offset, 0, p)
        .accountsPartial({ payer: owner.publicKey, benchmark, chunk, items: itemsPda, ...arciumAccounts(offset, "gen_part") })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
      const finalizeSig = await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
      const state = await program.account.answerChunk.fetch(chunk);
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
    const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(0n)], program.programId);
    await program.methods
      .createRun("test/gen-oracle", Array.from(randomBytes(32)), Array.from(randomBytes(32)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ commitment: "confirmed" });

    const PLANTED = 17;
    const outputs = truth.map((v, j) => new anchor.BN((j < PLANTED ? genAnswerHash(GEN_ID, j, v) : randomU64()).toString()));
    const offset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .scoreChunk(offset, new anchor.BN(0), 0, outputs)
      .accountsPartial({ payer: runner.publicKey, run, runner: runner.publicKey, chunk, ...arciumAccounts(offset, "score_chunk") })
      .signers([runner])
      .rpc({ commitment: "confirmed" });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    const r = await program.account.run.fetch(run);
    expect(r.status).to.equal(1, "finalized");
    expect(r.correct).to.equal(PLANTED);
    console.log(`generated bank scored: ${r.correct}/${CHUNK} correct, answers never existed in plaintext`);
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

async function fund(provider: anchor.AnchorProvider, from: Keypair, to: PublicKey, lamports: number) {
  const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  await provider.sendAndConfirm(tx, [from], { commitment: "confirmed" });
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
