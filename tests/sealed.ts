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
      .createBenchmark(BENCH_ID, "sealed-test", CHUNKS, Array.from(itemsRoot), new anchor.BN(FEE))
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
    const mktPda = (run: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("market"), run.toBuffer()], marketProgram.programId)[0];
    const posPda = (mkt: PublicKey, bettor: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("position"), mkt.toBuffer(), bettor.toBuffer()], marketProgram.programId)[0];

    // A market cannot be opened on the already-finalized run #0.
    const [run0] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(0n)], program.programId);
    await expectAnchorError(
      marketProgram.methods
        .createMarket(30)
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
      .createMarket(THRESHOLD)
      .accounts({ authority: owner.publicKey, run: run1, market: mkt })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    let m = await marketProgram.account.market.fetch(mkt);
    expect(m.status).to.equal(0);
    expect(m.threshold).to.equal(THRESHOLD);

    // Two bettors: YES 0.3 SOL vs NO 0.5 SOL.
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
      .bet(2, new anchor.BN(0.5 * LAMPORTS_PER_SOL))
      .accounts({ bettor: no.publicKey, run: run1, market: mkt, position: posPda(mkt, no.publicKey) })
      .signers([no])
      .rpc({ commitment: "confirmed" });
    m = await marketProgram.account.market.fetch(mkt);
    expect(m.yesTotal.toNumber()).to.equal(0.3 * LAMPORTS_PER_SOL);
    expect(m.noTotal.toNumber()).to.equal(0.5 * LAMPORTS_PER_SOL);

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
        .bet(1, new anchor.BN(1000))
        .accounts({ bettor: yes.publicKey, run: run1, market: mkt, position: posPda(mkt, yes.publicKey) })
        .signers([yes])
        .rpc(),
      "RunNotPending",
    );

    // Permissionless resolve: outcome = run.correct >= threshold.
    await marketProgram.methods
      .resolve()
      .accounts({ run: run1, market: mkt })
      .rpc({ commitment: "confirmed" });
    m = await marketProgram.account.market.fetch(mkt);
    expect(m.status).to.equal(1, "resolved");
    expect(m.outcome).to.equal(2, "NO wins");
    expect(m.resolvedScore).to.equal(total);

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
