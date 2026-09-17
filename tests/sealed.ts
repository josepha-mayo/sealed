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
  return {
    index: data.readUInt16LE(40),
    partsWritten: data[43],
    encryptionKey: new Uint8Array(data.subarray(44, 76)),
    ciphertexts,
    nonces,
  };
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

  it("declassifies one part's fingerprints for a spot-check audit", async () => {
    await initCompDef("reveal_part", () => program.methods.initRevealPartCompDef());
    const BENCH_ID = 1;
    const [benchmark] = PublicKey.findProgramAddressSync(
      [Buffer.from("benchmark"), owner.publicKey.toBuffer(), u32le(BENCH_ID)],
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
      .rpc({ commitment: "confirmed" });
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
      "already in use",
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

  it("mints a PRIVATE bank: ciphertext-only on chain, decryptable by the authority", async () => {
    await initCompDef("gen_part_private", () => program.methods.initGenPartPrivateCompDef());

    const PRIV_ID = 3;
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
        .rpc({ commitment: "confirmed" });
      b = await program.account.benchmark.fetch(benchmark);
    }
    expect(b.kind).to.equal(2);

    const [chunk] = PublicKey.findProgramAddressSync([Buffer.from("chunk"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [pitemsPda] = PublicKey.findProgramAddressSync([Buffer.from("pitems"), benchmark.toBuffer(), u16le(0)], program.programId);
    const [pubItemsPda] = PublicKey.findProgramAddressSync([Buffer.from("items"), benchmark.toBuffer(), u16le(0)], program.programId);
    if (!(await program.account.answerChunk.fetchNullable(chunk))) {
      await program.methods.initChunk(0).accounts({ authority: owner.publicKey, benchmark }).signers([owner]).rpc({ commitment: "confirmed" });
    }
    if (!(await program.account.privItemChunk.fetchNullable(pitemsPda))) {
      await program.methods.initItemsPrivate(0).accounts({ authority: owner.publicKey, benchmark, items: pitemsPda }).signers([owner]).rpc({ commitment: "confirmed" });
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
    const GEN_ID = 2;
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
        .rpc({ commitment: "confirmed" });
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
    let root: Uint8Array = new Uint8Array(32);
    for (let p = 0; p < PARTS; p++) {
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
    const [run] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchmark.toBuffer(), u64le(0n)], program.programId);
    await program.methods
      .createRun("test/priv-oracle", Array.from(randomBytes(32)), Array.from(randomBytes(32)))
      .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark, run })
      .signers([runner])
      .rpc({ commitment: "confirmed" });

    const PLANTED = 21;
    const outputs = truth.map((v, j) => new anchor.BN((j < PLANTED ? genAnswerHash(PRIV_ID, j, v) : randomU64()).toString()));
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
    console.log(`private bank scored: ${r.correct}/${CHUNK} correct — specs never appeared on-chain`);
  });

  it("reshares private specs to a delegate key — selective question disclosure", async () => {
    await initCompDef("reshare_part", () => program.methods.initResharePartCompDef());

    // Reuse the private bank from the previous test (id 3, kind 2, live).
    const PRIV_ID = 3;
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
      .rpc({ commitment: "confirmed" });
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
      "already in use",
    );
    console.log(`reshare verified: delegate decrypted ${specs.length} items identical to the authority's`);
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
