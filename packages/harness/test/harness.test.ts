import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { Prng } from "../src/prng.js";
import { canonicalAnswer, normalize } from "../src/canonical.js";
import { answerHash, genAnswerHash, itemLeaf, chunkOutLeaves, merkleRoot, merkleProof, verifyProof, harnessHash, hex } from "../src/hash.js";
import { FAMILIES } from "../src/items.js";
import { buildBank, chunkHashes, CHUNK, PART } from "../src/bank.js";
import { bankFromChunks, decodeItemChunk, evalSpec, parseCanonicalInt, renderPrompt, specBytes, UNPARSEABLE, type ItemChunkState, type ItemSpec } from "../src/genbank.js";
import { runModel, runChunkOutputs } from "../src/run.js";
import { ModelClient } from "../src/models.js";

test("prng is deterministic and in range", () => {
  const a = new Prng("seed", "s"), b = new Prng("seed", "s"), c = new Prng("seed", "other");
  const xs = Array.from({ length: 50 }, () => a.int(-5, 5));
  assert.deepEqual(xs, Array.from({ length: 50 }, () => b.int(-5, 5)));
  assert.notDeepEqual(xs, Array.from({ length: 50 }, () => c.int(-5, 5)));
  assert.ok(xs.every((x) => x >= -5 && x <= 5));
});

test("canonicalization is forgiving on format, strict on content", () => {
  assert.equal(canonicalAnswer("Let me think...\n\nANSWER: 1,024"), "1024");
  assert.equal(canonicalAnswer("The answer is **42**.\nAnswer: -0042."), "-42");
  assert.equal(canonicalAnswer("blah\nanswer: (3, -2)"), "3,-2");
  assert.equal(canonicalAnswer("ANSWER: `Wednesday`"), "wednesday");
  assert.equal(canonicalAnswer("no marker here\n\n  0x1f  "), "0x1f");
  assert.equal(canonicalAnswer("ANSWER: +0"), "0");
  assert.equal(normalize("Hello   World"), "hello world");
  assert.notEqual(canonicalAnswer("ANSWER: 1025"), canonicalAnswer("ANSWER: 1024"));
});

test("answer hash binds benchmark and item", () => {
  const h = answerHash(7, 3, "42");
  assert.equal(typeof h, "bigint");
  assert.ok(h < 1n << 64n);
  assert.notEqual(h, answerHash(7, 4, "42"));
  assert.notEqual(h, answerHash(8, 3, "42"));
  assert.equal(h, answerHash(7, 3, "42"));
});

test("merkle root and proofs", () => {
  const leaves = Array.from({ length: 5 }, (_, i) => itemLeaf(1, i, new Uint8Array(16).fill(i), `q${i}`));
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    assert.ok(verifyProof(leaves[i], i, merkleProof(leaves, i), root), `proof ${i}`);
  }
  assert.ok(!verifyProof(leaves[0], 1, merkleProof(leaves, 0), root));
  assert.equal(hex(merkleRoot([])), "0".repeat(64));
  assert.equal(hex(harnessHash({ b: 1, a: [2, { d: 1, c: 2 }] })), hex(harnessHash({ a: [2, { c: 2, d: 1 }], b: 1 })));
});

test("every family yields canonical answers that round-trip through the model path", () => {
  for (const [name, fam] of Object.entries(FAMILIES)) {
    for (let d = 1; d <= 3; d++) {
      for (let s = 0; s < 20; s++) {
        const item = fam(new Prng("t", `${name}/${d}/${s}`), d);
        assert.equal(item.family, name);
        assert.ok(item.prompt.length > 20, `${name} prompt`);
        assert.ok(item.answer.length > 0, `${name} answer`);
        // A model that replies "ANSWER: <answer>" must hash to the reference.
        assert.equal(canonicalAnswer(`reasoning...\nANSWER: ${item.answer}`), item.answer, `${name}#${s}`);
        assert.equal(normalize(item.answer), item.answer, `${name} answer already canonical`);
      }
    }
  }
});

test("bank is deterministic, chunked, and committed", () => {
  const a = buildBank("master", 1, 2), b = buildBank("master", 1, 2), c = buildBank("other", 1, 2);
  assert.equal(a.items.length, 2 * CHUNK);
  assert.equal(a.itemsRoot, b.itemsRoot);
  assert.notEqual(a.itemsRoot, c.itemsRoot);
  assert.deepEqual(chunkHashes(a, 1), chunkHashes(b, 1));
  assert.equal(chunkHashes(a, 0).length, CHUNK);
  const families = new Set(a.items.slice(0, CHUNK).map((i) => i.family));
  assert.ok(families.size >= 8, "chunks mix families");
  assert.ok(a.items.every((it) => BigInt(it.answerHash) === answerHash(1, it.index, it.answer)));
});

test("run pipeline hashes model output the same way as the bank", async () => {
  const bank = buildBank("master", 3, 1);
  // Oracle model: right on even items, wrong on odd, sloppy formatting throughout.
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const prompt: string = body.messages[1].content;
    const item = bank.items.find((it) => it.prompt === prompt)!;
    const reply = item.index % 2 === 0 ? `Working...\n\n**ANSWER:**  ${item.answer.toUpperCase()} .` : "ANSWER: nope";
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
  }) as typeof fetch;
  const client = new ModelClient({ apiKey: "test", fetchImpl, concurrency: 4 });
  const run = await runModel(bank, "oracle/half", client);
  assert.equal(run.localCorrect, CHUNK / 2);
  const outs = runChunkOutputs(run, 0), refs = chunkHashes(bank, 0);
  const matches = outs.filter((h, i) => h === refs[i]).length;
  assert.equal(matches, CHUNK / 2);
  assert.equal(run.outputsRoot.length, 64);
  // The artifact binds to this exact bank revision so a re-minted/rewritten
  // bank file is rejected at score time instead of scoring stale outputs.
  assert.equal(run.itemsRoot, bank.itemsRoot);
});

test("provider error notices and degenerate replies never become an artifact", async () => {
  const bank = buildBank("master", 3, 1);
  const client = (reply: string) =>
    new ModelClient({
      apiKey: "test",
      retries: 0,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 })) as typeof fetch,
    });
  // A credit/quota wall rendered as assistant content (Pollinations-style 200).
  await assert.rejects(
    () => runModel(bank, "x", client("The account behind this API key doesn't have enough credits")),
    /provider notice as content/,
  );
  // Some other identical non-answer repeated for every prompt must also be refused.
  await assert.rejects(
    () => runModel(bank, "x", client("I cannot help with that.")),
    /same reply to .* prompts/,
  );
});

test("output proofs verify against the committed outputs_root (prover/verifier split)", async () => {
  const bank = buildBank("master", 4, 2);
  const client = new ModelClient({
    apiKey: "test",
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const prompt: string = JSON.parse(String(init?.body)).messages[1].content;
      const item = bank.items.find((it) => it.prompt === prompt)!;
      return new Response(JSON.stringify({ choices: [{ message: { content: `ANSWER: ${item.answer}` } }] }), { status: 200 });
    }) as typeof fetch,
  });
  const run = await runModel(bank, "oracle/all", client);

  // Prover side: what `sealed prove --item i` emits (chunk-level commitment —
  // the leaf is the whole 32-output chunk, the path binds it to outputs_root).
  const i = 5;
  const ci = Math.floor(i / CHUNK);
  const leaves = chunkOutLeaves(run.items.map((r) => BigInt(r.outputHash)));
  const proofJson = {
    leaf: Buffer.from(leaves[ci]).toString("hex"),
    proof: merkleProof(leaves, ci).map((p) => Buffer.from(p).toString("hex")),
    outputsRoot: run.outputsRoot,
  };

  // Verifier side: only sees the JSON (what web/index.html does).
  const leaf = new Uint8Array(Buffer.from(proofJson.leaf, "hex"));
  const proof = proofJson.proof.map((p: string) => new Uint8Array(Buffer.from(p, "hex")));
  assert.ok(verifyProof(leaf, ci, proof, new Uint8Array(Buffer.from(proofJson.outputsRoot, "hex"))));

  // Tampered hash or wrong index must fail.
  const bad = new Uint8Array(leaves[ci]); bad[0] ^= 1;
  assert.ok(!verifyProof(bad, ci, proof, new Uint8Array(Buffer.from(run.outputsRoot, "hex"))));
  assert.ok(!verifyProof(leaf, ci + 1, proof, new Uint8Array(Buffer.from(run.outputsRoot, "hex"))));
});

// ------------------------------------------------- generated (MPC-minted) banks

test("evalSpec matches the circuit: ((a op0 b) op1 c), ops +,-,*", () => {
  const s = (a: number, b: number, c: number, op0: number, op1: number): ItemSpec => ({ a, b, c, op0, op1 });
  assert.equal(evalSpec(s(2, 3, 4, 0, 0)), 9n);      // (2+3)+4
  assert.equal(evalSpec(s(2, 3, 4, 0, 1)), 1n);      // (2+3)-4
  assert.equal(evalSpec(s(2, 3, 4, 0, 2)), 20n);     // (2+3)*4
  assert.equal(evalSpec(s(2, 3, 4, 1, 0)), 3n);      // (2-3)+4
  assert.equal(evalSpec(s(2, 3, 4, 2, 1)), 2n);      // (2*3)-4
  assert.equal(evalSpec(s(2, 3, 4, 2, 2)), 24n);     // (2*3)*4
  assert.equal(evalSpec(s(0, 63, 63, 1, 2)), -3969n); // min corner
  assert.equal(evalSpec(s(63, 63, 63, 2, 2)), 250047n); // max corner
});

test("generated spec -> prompt -> model reply -> genAnswerHash round-trips", () => {
  const spec: ItemSpec = { a: 17, b: 29, c: 41, op0: 0, op1: 2 };
  const prompt = renderPrompt(spec);
  assert.ok(prompt.includes("17") && prompt.includes("29") && prompt.includes("41"));
  // The oracle replies with the true value in sloppy format; the pipeline must still match.
  const canonical = canonicalAnswer(`reasoning...\n**ANSWER:** ${evalSpec(spec)} .`);
  assert.equal(genAnswerHash(9, 3, parseCanonicalInt(canonical)), genAnswerHash(9, 3, evalSpec(spec)));
  // Binding: benchmark id and index both matter.
  assert.notEqual(genAnswerHash(9, 3, evalSpec(spec)), genAnswerHash(9, 4, evalSpec(spec)));
  assert.notEqual(genAnswerHash(9, 3, evalSpec(spec)), genAnswerHash(10, 3, evalSpec(spec)));
  // Non-integer replies get the unmatchable sentinel.
  assert.equal(parseCanonicalInt("no idea"), UNPARSEABLE);
  assert.equal(parseCanonicalInt("-3969"), -3969n);
  assert.equal(parseCanonicalInt("250047"), 250047n);
});

test("ItemChunk decode and items_root fold are deterministic and lossless", () => {
  const rng = new Prng("t", "genchunk");
  const specs: ItemSpec[] = Array.from({ length: CHUNK }, () => ({
    a: rng.int(0, 63), b: rng.int(0, 63), c: rng.int(0, 63), op0: rng.int(0, 2), op1: rng.int(0, 2),
  }));
  const NPARTS = CHUNK / PART;
  const data = Buffer.alloc(8 + 32 + 2 + 1 + 1 + CHUNK * 5 + NPARTS * 2);
  new PublicKey("11111111111111111111111111111112").toBuffer().copy(data, 8);
  data.writeUInt16LE(1, 40);
  data[42] = 254;
  data[43] = 0b1111;
  specs.forEach((s, i) => Buffer.from(specBytes(s)).copy(data, 44 + i * 5));
  for (let p = 0; p < NPARTS; p++) data.writeUInt16LE(p, 44 + CHUNK * 5 + p * 2);
  const st = decodeItemChunk(data);
  assert.equal(st.index, 1);
  assert.equal(st.partsWritten, 0b1111);
  assert.deepEqual(st.specs, specs);
  assert.deepEqual(st.mintOrder, [0, 1, 2, 3]);

  const bank = bankFromChunks(5, [st]);
  assert.equal(bank.kind, "generated");
  assert.equal(bank.items.length, CHUNK);
  assert.equal(bank.items[0].index, CHUNK); // chunk 1 -> indices 32..63
  assert.equal(bank.items[0].answer, evalSpec(specs[0]).toString());
  assert.equal(BigInt(bank.items[0].answerHash), genAnswerHash(5, CHUNK, evalSpec(specs[0])));
  assert.equal(bank.itemsRoot.length, 64);
  // Every spec occupies a distinct slot in the fold: same specs, different chunk -> different root.
  const st2 = { ...st, index: 0 };
  assert.notEqual(bankFromChunks(5, [st2]).itemsRoot, bank.itemsRoot);
  // Out-of-order MPC landings replay via mint_order, not chunk position:
  // [2,0,3,1] folds differently than [0,1,2,3] — and must verify as-minted.
  const st3 = { ...st, mintOrder: [2, 0, 3, 1] };
  assert.notEqual(bankFromChunks(5, [st3]).itemsRoot, bank.itemsRoot);
  const st4 = { ...st, mintOrder: [1, 0, 3, 2] };
  const st5 = { ...st, mintOrder: [2, 3, 0, 1] };
  assert.notEqual(bankFromChunks(5, [st4]).itemsRoot, bankFromChunks(5, [st5]).itemsRoot);
});

test("generated bank scores model outputs through the same pipeline", async () => {
  const specs: ItemSpec[] = Array.from({ length: CHUNK }, (_, i) => ({
    a: (i * 7) % 64, b: (i * 11) % 64, c: (i * 13) % 64, op0: i % 3, op1: (i * 2) % 3,
  }));
  const st: ItemChunkState = { benchmark: new PublicKey("11111111111111111111111111111112"), index: 0, partsWritten: (1 << (CHUNK / PART)) - 1, specs, mintOrder: [0, 1, 2, 3] };
  const bank = bankFromChunks(6, [st]);
  const client = new ModelClient({
    apiKey: "test",
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const prompt: string = JSON.parse(String(init?.body)).messages[1].content;
      const item = bank.items.find((it) => it.prompt === prompt)!;
      const right = item.index % 4 !== 3;
      return new Response(JSON.stringify({ choices: [{ message: { content: `ANSWER: ${right ? item.answer : "?"}` } }] }), { status: 200 });
    }) as typeof fetch,
  });
  const run = await runModel(bank, "oracle/three-quarter", client);
  assert.equal(run.localCorrect, (CHUNK / 4) * 3);
  const refs = bank.items.map((it) => BigInt(it.answerHash));
  const matches = runChunkOutputs(run, 0).filter((h, i) => h === refs[i]).length;
  assert.equal(matches, (CHUNK / 4) * 3);
});

test("capability gate: policy evaluation over registry receipts", async () => {
  const { evalGate } = await import("../src/gate.js");
  const receipts = [
    { correct: 24, items: 32, vouchedAtRecord: 1, postReveal: 0 },
    { correct: 20, items: 32, vouchedAtRecord: 1, postReveal: 0 },
    { correct: 2, items: 32, vouchedAtRecord: 0, postReveal: 1 },
  ];
  // All evidence: 46/96 = 47.9% — fails a 60% floor, passes 45%.
  const all = evalGate(receipts, { minPct: 45 });
  assert.equal(all.pass, true);
  assert.equal(all.scope, "all");
  assert.equal(all.postRevealRuns, 1);
  assert.equal(evalGate(receipts, { minPct: 60 }).pass, false);
  // Vouched-only drops the self-reported 2/32 -> 44/64 = 68.8% passes 60%.
  const v = evalGate(receipts, { minPct: 60, vouchedOnly: true });
  assert.equal(v.pass, true);
  assert.equal(v.scope, "vouched");
  assert.equal(v.runs, 2);
  // Runs/items floors are measured on the selected set.
  assert.equal(evalGate(receipts, { minRuns: 3, vouchedOnly: true }).pass, false);
  assert.equal(evalGate(receipts, { minItems: 100 }).pass, false);
  assert.equal(evalGate(receipts, { minItems: 96 }).pass, true);
  // Honest absence: no record -> no-record; record but no vouched receipts
  // -> no-evidence (absent proof is not disproof). Neither counts as a
  // policy failure.
  assert.equal(evalGate([], { minPct: 1 }, false).reason, "no-record");
  assert.equal(evalGate([{ correct: 1, items: 1, vouchedAtRecord: 0 }], { minPct: 1, vouchedOnly: true }).reason, "no-evidence");
  // A zero-threshold gate on an empty registry still distinguishes the
  // record existing at all.
  assert.equal(evalGate([], {}, true).reason, "no-evidence");
});

test("capability gate: post-reveal exclusion + Wilson bound", async () => {
  const { evalGate, wilsonLowerBoundPct } = await import("../src/gate.js");
  const receipts = [
    { correct: 24, items: 32, vouchedAtRecord: 1, postReveal: 0 },
    { correct: 20, items: 32, vouchedAtRecord: 1, postReveal: 0 },
    { correct: 2, items: 32, vouchedAtRecord: 0, postReveal: 1 },
  ];
  // noPostReveal drops the 2/32 stuffed receipt -> 44/64 = 68.8%.
  const npr = evalGate(receipts, { minPct: 60, noPostReveal: true });
  assert.equal(npr.pass, true);
  assert.equal(npr.runs, 2);
  assert.equal(npr.postRevealRuns, 1); // still reported, just not counted
  // Combined with vouchedOnly: both filters apply.
  assert.equal(evalGate(receipts, { minPct: 60, vouchedOnly: true, noPostReveal: true }).runs, 2);
  // Wilson LCB: a perfect thin sample can't flatter a strict gate —
  // 3/3 = 100% point estimate but only ~43.8% LCB.
  const perfect = [{ correct: 3, items: 3, vouchedAtRecord: 1, postReveal: 0 }];
  assert.equal(evalGate(perfect, { minPct: 90 }).pass, true); // naive floor passes
  assert.equal(evalGate(perfect, { minWilsonPct: 50 }).pass, false); // LCB doesn't
  // 44/64 LCB ≈ 56.6% — passes a 50% bound, fails a 60% bound.
  assert.ok(wilsonLowerBoundPct(44, 64) > 56 && wilsonLowerBoundPct(44, 64) < 58);
  assert.equal(evalGate(receipts, { minWilsonPct: 50, vouchedOnly: true }).pass, true);
  assert.equal(evalGate(receipts, { minWilsonPct: 60, vouchedOnly: true }).pass, false);
  assert.equal(wilsonLowerBoundPct(0, 0), 0);
});

test("venue board: keeper classification over bounties, markets, ladders", async () => {
  const { classifyBoard, HARD_CAP_SECS } = await import("../src/board.js");
  const now = 1_000_000;
  const run = (pk: string, over: Partial<any> = {}) => ({
    pubkey: pk, benchmark: "bank1", runner: "runnerA", status: 1,
    correct: 40, createdAt: now - 1000, firstPendingAt: 0, allQueuedAt: 0,
    scoredMask: "0", postReveal: 0, ...over,
  });
  const rows = {
    runs: [
      run("runWin"),                                    // finalized — qualifies
      // proven partial: pending but fully committed a full landing window
      // ago with landed chunks — bounty_qualifies accepts it on-chain.
      run("runPart", { status: 0, correct: 45, scoredMask: "3",
        allQueuedAt: now - HARD_CAP_SECS - 10 }),
      run("runRetro", { createdAt: now - 5000 }),       // predates bounty — no retro claim
      run("runSelf", { runner: "sponsor1", correct: 60 }),// sponsor can't self-deal
      run("runPR", { postReveal: 1, correct: 63 }),     // post-reveal doesn't count
      run("runBand"), run("runDuelA"), run("runDuelB"),
      run("leg1"), run("leg2"), run("leg3"),
      run("runPending", { status: 0 }),                 // never queued — not moving
      run("runMoving", { status: 0, firstPendingAt: now - 100 }),  // inside 24h queue window
      run("runCommitted", { status: 0, scoredMask: "7", allQueuedAt: now - 100 }), // inside landing window
    ],
    bounties: [
      { pubkey: "bClaim", sponsor: "sponsor1", bank: "bank1", status: 0, threshold: 40,
        amount: 1e9, createdAt: now - 2000, deadline: now + 1000 },
      { pubkey: "bSelf", sponsor: "sponsor1", bank: "bankX", status: 0, threshold: 10,
        amount: 1e9, createdAt: now - 2000, deadline: now + 1000 },   // no runs on bankX → live
      { pubkey: "bDead", sponsor: "sponsor1", bank: "bank1", status: 0, threshold: 99,
        amount: 2e9, createdAt: now - 5000, deadline: now - 1 },      // expired → sweepable
      { pubkey: "bWon", sponsor: "sponsor1", bank: "bank1", status: 1, threshold: 30,
        amount: 0, createdAt: now - 5000, deadline: now + 1000 },     // claimed → count
    ],
    markets: [
      { pubkey: "mBand", kind: "band" as const, status: 0, run: "runBand", resolveBy: now + 100 },
      { pubkey: "mDuel", kind: "duel" as const, status: 0, run: "runDuelA", runB: "runDuelB", resolveBy: now + 100 },
      { pubkey: "mDark", kind: "dark" as const, status: 0, run: "runBand", resolveBy: now + 100, tallied: false },
      { pubkey: "mHalf", kind: "duel" as const, status: 0, run: "runDuelA", runB: "runPending", resolveBy: now + 100 },
      { pubkey: "mDead", kind: "band" as const, status: 0, run: "runPending", resolveBy: now - 10 },
      // proven-partial run past deadline → expire SETTLES, doesn't refund.
      { pubkey: "mDeadSettle", kind: "band" as const, status: 0, run: "runPart", resolveBy: now - 10 },
      // past resolve_by but the run is still inside its queue window —
      // expire_decision Blocks (MarketResolvable): no action, not expirable.
      { pubkey: "mMoving", kind: "band" as const, status: 0, run: "runMoving", resolveBy: now - 10 },
      { pubkey: "mDuelMoving", kind: "duel" as const, status: 0, run: "runDuelA", runB: "runMoving", resolveBy: now - 10 },
      // finalized AND past deadline → still resolvable (expire Blocks on it).
      { pubkey: "mLate", kind: "band" as const, status: 0, run: "runBand", resolveBy: now - 10 },
      { pubkey: "mSettled", kind: "band" as const, status: 1, run: "runBand", resolveBy: now - 100 },
      { pubkey: "mDarkRevealing", kind: "dark" as const, status: 1, run: "runBand",
        resolveBy: now - 100, revealUntil: now + 100, tallied: false },
      { pubkey: "mDarkTally", kind: "dark" as const, status: 1, run: "runBand",
        resolveBy: now - 100, revealUntil: now - 10, tallied: false },
      { pubkey: "mDarkDone", kind: "dark" as const, status: 1, run: "runBand",
        resolveBy: now - 100, revealUntil: now - 10, tallied: true },
    ],
    ladders: [
      { pubkey: "ladDone", status: 0, legs: ["leg1", "leg2", "leg3"], resolveBy: now + 100 },
      { pubkey: "ladWait", status: 0, legs: ["leg1", "runMoving"], resolveBy: now + 100 },
      // The resolution gate is `!still_moving` per leg, NOT resolve_by —
      // a never-queued leg forfeits at 0, so this resolves BEFORE deadline.
      { pubkey: "ladEarly", status: 0, legs: ["leg1", "runPending"], resolveBy: now + 100 },
      { pubkey: "ladCommitted", status: 0, legs: ["leg1", "runCommitted"], resolveBy: now + 100 },
    ],
  };
  const b = classifyBoard(rows, now);

  // Claimable: runPart outranks runWin (45 > 40) — a proven partial claims
  // the same way a finalized run does; retro/self-deal/post-reveal refused.
  assert.equal(b.claimable.length, 1);
  assert.equal(b.claimable[0].pubkey, "bClaim");
  assert.equal(b.claimable[0].qualifyingRun, "runPart");
  assert.equal(b.claimable[0].qualifyingScore, 45);
  assert.equal(b.liveBounties.length, 1);
  assert.equal(b.expiredBounties.length, 1);
  assert.equal(b.expiredBounties[0].pubkey, "bDead");
  assert.equal(b.claimedBounties, 1);

  // Resolvable: band + duel (both legs) + dark + the past-deadline-but-
  // finalized band (resolve always lands on a finalized run).
  assert.deepEqual(b.resolvable.map((m) => m.pubkey).sort(),
    ["mBand", "mDark", "mDuel", "mLate"]);
  // Expirable: never-queued (refunds) and proven-partial (settles) — the
  // still-moving markets are NOT expirable even past resolve_by.
  assert.equal(b.expirable.length, 2);
  assert.equal(b.expirable.find((m) => m.pubkey === "mDead")?.expireOutcome, "refunds");
  assert.equal(b.expirable.find((m) => m.pubkey === "mDeadSettle")?.expireOutcome, "settles");
  // Darks: resolved+untallied past reveal_until is a finalize_dark target;
  // inside the window it's a reveal in play.
  assert.deepEqual(b.tallyable.map((m) => m.pubkey), ["mDarkTally"]);
  assert.equal(b.revealing, 1);
  // Ladders: all-finalized AND the never-started race both resolve now;
  // a leg inside either landing window keeps the race filling.
  assert.deepEqual(b.resolvableLadders.map((l) => l.pubkey).sort(),
    ["ladDone", "ladEarly"]);
  assert.equal(b.settled, 2);          // mSettled + tallied mDarkDone
  assert.equal(b.filling, 5);          // mHalf, mMoving, mDuelMoving, ladWait, ladCommitted
});

test("snapshot decoder replays the committed bundle, camelCase-normalized", async () => {
  const { decodeSnapshotSection, loadSnapshotJson, snapOf } = await import("../src/snapshot.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const snap = loadSnapshotJson(snapPath);
  const ss = decodeSnapshotSection(snap, "sealed");
  const sm = decodeSnapshotSection(snap, "market");
  // The bundle's published counts — decode must find every account.
  assert.equal(snapOf(ss, "Run").length, 503);
  assert.equal(snapOf(ss, "ModelRecord").length, 31);
  assert.equal(snapOf(ss, "ScoreLog").length, 292);
  assert.equal(snapOf(sm, "Market").length + snapOf(sm, "DarkMarket").length +
    snapOf(sm, "Ladder").length + snapOf(sm, "Bounty").length, 340);
  // Fields arrive camelCase (matching `.all()`), not the coder's snake_case.
  const run = snapOf(ss, "Run")[0].account;
  assert.ok("scoredMask" in run && "firstPendingAt" in run && !("scored_mask" in run));
  // And the decoded accounts feed the REAL board path — the explorer's
  // 36-actionable keeper surface reproduced offline through marketBoard().
  const { marketBoard } = await import("../src/chain.js");
  const origLog = console.log;
  console.log = () => {};
  let b: any;
  try { b = await marketBoard(true, snapPath); } finally { console.log = origLog; }
  const actionable = b.claimable.length + b.resolvable.length +
    b.resolvableLadders.length + b.tallyable.length +
    b.expirable.length + b.expiredBounties.length;
  assert.equal(actionable, 36);
  assert.equal(b.settled, 246);
  assert.equal(b.claimedBounties, 33);
  assert.equal(b.filling, 24);
});

test("chain compare joins receipts by benchmark — paired verdict, honest disjoint sets", async () => {
  const { modelCompare } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    // ladder/model-a vs model-b: 17 shared banks, decisive +31.3pp.
    const win: any = await modelCompare("ladder/model-a", "ladder/model-b", false, snapPath);
    assert.equal(win.verdict, "a");
    assert.equal(win.sharedBanks.length, 17);
    assert.equal(win.bankWins.a, 17);
    assert.ok(Math.abs(win.pooled.pctA - 93.75) < 0.01);
    assert.equal(process.exitCode, 0);
    // Identical evidence → tie → exit 1.
    const tie: any = await modelCompare("dark/model-a", "ladder/model-a", false, snapPath);
    assert.equal(tie.verdict, "tie");
    assert.equal(process.exitCode, 1);
    // Disjoint coverage → can't rank → exit 2 (aggregate leaderboards lie;
    // shared evidence is the honest answer).
    const disjoint: any = await modelCompare("test/sweep-run", "dark/model-a", false, snapPath);
    assert.equal(disjoint.verdict, "no-evidence");
    assert.equal(disjoint.sharedBanks.length, 0);
    assert.equal(process.exitCode, 2);
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("chain compare --all ranks on shared evidence only — disjoint pairs stay unranked", async () => {
  const { compareAll } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  let ranked: any;
  try { ranked = await compareAll(true, snapPath); } finally { console.log = origLog; }
  assert.equal(ranked.length, 31);
  // dark/model-a and ladder/model-a tie each other and beat all 8 rankable
  // opponents — they top the table on shared evidence, not on aggregate.
  const top = ranked.slice(0, 2).map((r: any) => r.modelId).sort();
  assert.deepEqual(top, ["dark/model-a", "ladder/model-a"]);
  assert.equal(ranked[0].wins, 8);
  // The aggregate leader (test/sweep-run, 100%) drops — its runs share
  // banks with few others, so paired evidence can't crown it.
  const sweep = ranked.find((r: any) => r.modelId === "test/sweep-run");
  assert.ok(sweep.wins < 8);
  // qwen family ordering is recovered from shared banks alone.
  const ix = (id: string) => ranked.findIndex((r: any) => r.modelId === id);
  assert.ok(ix("qwen2.5-3b-instruct") < ix("qwen2.5-1.5b-instruct"));
  assert.ok(ix("qwen2.5-1.5b-instruct") < ix("qwen2.5-0.5b-instruct"));
});

test("chain trail re-verifies every venue's resolution against Run.correct — duels unpacked", async () => {
  const { chainTrail } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  let out: any;
  // A run with a band, a duel, a binary band, and a ladder leg priced on it.
  try { out = await chainTrail("BoEDCeg4jP9vCyaj2Q1Y9jVCeZd2rweFCJcmM2GNRvY9", false, snapPath); }
  finally { console.log = origLog; }
  assert.equal(out.modelId, "mock/oracle-0.75");
  assert.equal(out.score, "53/64");
  assert.ok(out.receipt, "ScoreLog receipt found");
  assert.equal(out.venues.length, 4);
  assert.ok(out.venues.every((v: any) => v.verified === true),
    "every resolved venue's score re-verified against Run.correct");
  // The duel packs (a << 16) | b — 53-32, our run is side A.
  const duel = out.venues.find((v: any) => v.kind === "duel");
  assert.equal(duel.resolvedScore, "53-32");
  assert.equal(duel.outcome, "A won");
});


test("chain feed emits cross-type chronology newest-first over the bundle", async () => {
  const { chainFeed } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  let evs: any[];
  try { evs = (await chainFeed(25, undefined, 0, false, snapPath)) as any[]; }
  finally { console.log = origLog; }
  assert.equal(evs.length, 25);
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i - 1].t >= evs[i].t, "sorted newest-first");
  const types = new Set(evs.map((e: any) => e.type));
  assert.ok(types.has("receipt") && types.has("run"), "mixed event classes present");
  // every event references a real account pubkey
  assert.ok(evs.every((e: any) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(e.pk)));
});

test("marketPosition dossier classifies a payable band position over the bundle", async () => {
  const { marketPosition, marketPositions } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    // find any payable row, then look the position up by pk
    const rows = (await marketPositions(undefined, true, snapPath, "B5rBjujEKaujKpVf214YguWJ55iL8n1F77hrxmbgHfqg")) as any[];
    const pay = rows.find((r: any) => r.state === "payable");
    assert.ok(pay, "a payable position exists in the bundle");
    const doc = (await marketPosition("14AQTPw2KjckgvkTWbyVVpKp2mcfZgQuNaRFpdt6gnd6", true, snapPath)) as any;
    assert.equal(doc.state, "payable");
    assert.equal(doc.venue, pay.pk);
    assert.equal(BigInt(doc.estPayout), BigInt(pay.est));
    assert.equal(doc.kind, "band");
    assert.equal(doc.venueStatus.outcome, 1);
    // dark position forfeits render too
    const d = (await marketPosition("14fQMWDHF3nRERFm53rc5xSW2pxKGb8WY5gGAF4QU8NB", true, snapPath)) as any;
    assert.equal(d.kind, "dark");
    assert.equal(d.state, "forfeit");
    // unknown pk exits 2 with no row
    const missing = (await marketPosition("11111111111111111111111111111111", true, snapPath)) as any;
    assert.equal(missing, null);
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("chain search resolves every account class to its dossier route", async () => {
  const { chainSearch } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const one = async (pk: string) => ((await chainSearch(pk, true, snapPath)) as any[])[0];
    assert.equal((await one("2cwT4xY7e6UDFePX7tB5PoiihJDfFT2kEqefayVtMVxZ")).type, "benchmark");
    assert.equal((await one("XbsHhxrufPXsaiPZWr8BxYeJt8EGzi1EKNqAL5XXtHp")).type, "run");
    assert.equal((await one("5sSQxH3QP9MEBbptGzu16PovJkBsVpggNjtqUtdLtFGH")).type, "score-receipt");
    assert.equal((await one("BPEm7wpeWHNWRrKLXuJmsLHU2AYySZuLNyr4fCRFrtrK")).type, "model-record");
    assert.equal((await one("7Lt4RooJSmDg3ibpDYrwQ2CgengYdPAyfurqREfmAqvm")).type, "venue");
    assert.equal((await one("14AQTPw2KjckgvkTWbyVVpKp2mcfZgQuNaRFpdt6gnd6")).type, "position");
    // a wallet that signs but isn't an account → actor fallback
    assert.equal((await one("B5rBjujEKaujKpVf214YguWJ55iL8n1F77hrxmbgHfqg")).type, "actor");
    // every hit routes to a dossier command
    for (const h of (await chainSearch("2cwT4xY7e6UDFePX7tB5PoiihJDfFT2kEqefayVtMVxZ", true, snapPath)) as any[])
      assert.match(h.cmd, /^sealed chain /);
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("marketQuote simulates parimutuel payout and validates venue state", async () => {
  const { marketQuote } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    // open 3-leg ladder: 0.05 stake on leg 0 → est + ROI + implied share
    const q = (await marketQuote("4gx1VhwgTK9bKQUUupZCA8LCiATPJGy1FQMi6GupDBbV", 0, 50000000n, true, snapPath)) as any;
    assert.equal(q.kind, "ladder leg 0");
    assert.equal(q.stake, "50000000");
    assert.ok(BigInt(q.estPayoutIfWins) > 50000000n, "winning pays above stake");
    assert.equal(q.impliedChancePct, 53.84);
    assert.ok(q.roiPct > 80 && q.roiPct < 90);
    // legCount bounds the ladder — the 8-slot totals array has 3 live legs
    const bad = (await marketQuote("4gx1VhwgTK9bKQUUupZCA8LCiATPJGy1FQMi6GupDBbV", 5, 50000000n, true, snapPath)) as any;
    assert.equal(bad, null);
    // resolved venue rejects
    const res = (await marketQuote("Ftw6cvBE381ftyFtSGTb2CSAoDNsqBfLyf39iHLeK7B3", 0, 50000000n, true, snapPath)) as any;
    assert.equal(res, null);
    // open band: one-sided pool → stake returns stake (+0% ROI, 100% implied)
    const band = (await marketQuote("4kVnqJDrVBRXSyyf4Z3JfyfWgeK6yo6JmtB9MCpm7qRy", 0, 50000000n, true, snapPath)) as any;
    assert.equal(band.impliedChancePct, 100);
    // unknown venue pk exits without a row
    const none = (await marketQuote("11111111111111111111111111111111", 0, 50000000n, true, snapPath)) as any;
    assert.equal(none, null);
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("marketOdds derives the implied-probability board from pool weights", async () => {
  const { marketOdds } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const all = (await marketOdds(undefined, true, snapPath)) as any[];
    assert.ok(all.length > 50, "every open venue boards");
    const duel = all.find((v) => v.kind === "duel");
    assert.ok(duel, "an open duel exists");
    const sum = duel.legs.reduce((s: number, l: any) => s + l.impliedPct, 0);
    assert.ok(Math.abs(sum - 100) < 0.02, `implied percentages total ~100 (got ${sum})`);
    assert.equal(duel.legs[0].label.includes("duel/model-a"), true, "duel legs carry model labels");
    assert.ok(duel.legs[0].decimal > 1, "decimal odds above 1x");
    // single-venue mode + resolved rejection
    const one = (await marketOdds("GL4yEgmZPa5kTGkumRcUkQogosZZ2JzPwGbne47ALREv", true, snapPath)) as any[];
    assert.equal(one.length, 1);
    const dead = (await marketOdds("Ftw6cvBE381ftyFtSGTb2CSAoDNsqBfLyf39iHLeK7B3", true, snapPath)) as any;
    assert.equal(dead, null);
    // the 8-slot totals array is bounded by nOutcomes — a 3-way duel has 3 legs, not 8
    assert.equal(duel.legs.length, 3);
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("marketSentiment pools books into stake-weighted per-model belief", async () => {
  const { marketSentiment } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const rows = (await marketSentiment(true, snapPath)) as any[];
    assert.ok(rows.length >= 5, "models priced by the books");
    const a = rows.find((r) => r.model === "ladder/model-a");
    const b = rows.find((r) => r.model === "ladder/model-b");
    const c = rows.find((r) => r.model === "ladder/model-c");
    // two identical 0.6◎ ladders: 50/33.33/16.66 implied per leg
    assert.equal(a.impliedWinPct, 50);
    assert.equal(b.impliedWinPct, 33.33);
    assert.equal(c.impliedWinPct, 16.67);
    // the duel's tie book splits half to each side: 54.54 + 4.55 = 59.09
    const da = rows.find((r) => r.model === "duel/model-a");
    assert.equal(da.impliedWinPct, 59.09);
    // a band book implies an expected score, not a win share
    const band = rows.find((r) => r.impliedScore !== null);
    assert.ok(band && band.impliedScore > 0, "band model carries implied score");
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("marketChampions reconstructs the settlement record per model", async () => {
  const { marketChampions } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const rows = (await marketChampions(true, snapPath)) as any[];
    assert.ok(rows.length >= 10, "models with resolved venues");
    const a = rows.find((r) => r.model === "duel/model-a");
    const b = rows.find((r) => r.model === "duel/model-b");
    assert.equal(a.duelW + b.duelL, 42, "a-side wins == b-side losses across 21 duels…");
    assert.equal(a.duelW, 21);
    assert.equal(a.duelWinPct, 100);
    // dead-heat masks count every co-winner — tie-a and tie-b both 22/22
    const ta = rows.find((r) => r.model === "ladder/tie-a");
    const tb = rows.find((r) => r.model === "ladder/tie-b");
    assert.equal(ta.ladderWins, 22);
    assert.equal(tb.ladderWins, 22);
    assert.equal(ta.ladderEntries, 22);
    // real models carry their honest record — qwen ordering preserved
    const q3 = rows.find((r) => r.model === "qwen2.5-3b-instruct");
    const q05 = rows.find((r) => r.model === "qwen2.5-0.5b-instruct");
    assert.equal(q3.ladderWins, 1);
    assert.equal(q05.ladderWins, 0);
    // bounty claims count too
    const claimant = rows.find((r) => r.model === "test/bounty-claimant");
    assert.ok(claimant.bounties > 10);
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("chainModel fuses registry + evidence + settlement + belief per model", async () => {
  const { chainModel } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const m = (await chainModel("ladder/model-a", true, snapPath)) as any;
    assert.equal(m.model, "ladder/model-a");
    assert.equal(m.registry.accuracyPct, 93.75);
    assert.equal(m.pairedEvidence.rank, 2);
    assert.equal(m.settlement.ladderLegs, "21/21");
    assert.equal(m.marketBelief.impliedWinPct, 50);
    assert.ok(m.runs.total > 20 && m.runs.finalized === m.runs.total);
    // a real model carries its honest record across every lens
    const q = (await chainModel("qwen2.5-3b-instruct", true, snapPath)) as any;
    assert.equal(q.registry.accuracyPct, 23.96);
    assert.equal(q.settlement.bounties, 1);
    assert.equal(q.marketBelief, null, "no open book prices it");
    // unknown model exits without a dossier
    const none = (await chainModel("no/such-model", true, snapPath)) as any;
    assert.equal(none, null);
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("marketDivergence diffs evidence rank vs conviction rank", async () => {
  const { marketDivergence } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const rows = (await marketDivergence(true, snapPath)) as any[];
    // ladder/model-c loses every paired comparison (0W-8L) yet carries
    // the third-heaviest funded book — the flagship disagreement.
    const mc = rows.find((r) => r.model === "ladder/model-c");
    assert.equal(mc.evidence.rank, 31);
    assert.equal(mc.belief.rank, 3);
    assert.equal(mc.gap, 28, "evidence rank 31 − conviction rank 3 → priced above receipts");
    // a model with no funded book reports unpriced, not zero
    const q = rows.find((r) => r.model === "qwen2.5-3b-instruct");
    assert.equal(q.belief, null);
    assert.equal(q.gap, null);
    // rows sort by |gap|, one-sided last
    assert.ok(Math.abs(rows[0].gap ?? 0) >= Math.abs(rows[rows.length - 1].gap ?? 0) || rows[rows.length - 1].gap === null);
  } finally { console.log = origLog; }
});

test("marketCalibration scores closing books against landed outcomes", async () => {
  const { marketCalibration } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const { summary, venues } = (await marketCalibration(true, snapPath)) as any;
    assert.equal(summary.venuesScored, 143);
    assert.equal(summary.favoriteHitRatePct, 87);
    assert.equal(summary.meanImpliedWinnerPct, 55.18);
    assert.ok(summary.meanBrier < summary.uniformBrier, "books beat the uniform baseline");
    // dead-heat ladders count every co-winner in the implied share
    const dh = venues.find((v: any) => v.winners.length > 1);
    assert.ok(dh && dh.impliedWinnerPct > 0);
  } finally { console.log = origLog; }
});

test("chainFeed --model filters to one model's timeline", async () => {
  const { chainFeed } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const rows = (await chainFeed(500, undefined, 0, true, snapPath, undefined, true, "qwen2.5-3b-instruct")) as any[];
    assert.ok(rows.length > 10);
    // every event carries the model in its message or refs a run of it
    assert.ok(rows.every((e) => e.msg.includes("qwen2.5-3b") || e.refs.length));
    // the bounty its run claimed shows up through winner_run refs
    assert.ok(rows.some((e) => e.msg.includes("bounty posted")));
    // another model's events are absent
    const other = (await chainFeed(500, undefined, 0, true, snapPath, undefined, true, "ladder/model-c")) as any[];
    assert.ok(other.every((e) => !e.msg.includes("qwen2.5-3b")));
  } finally { console.log = origLog; }
});

test("compareAll --wilson flips thin perfect records below proven ones", async () => {
  const { compareAll } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const raw = (await compareAll(true, snapPath, 1, false)) as any[];
    const wil = (await compareAll(true, snapPath, 1, true)) as any[];
    const ix = (rows: any[], id: string) => rows.findIndex((r) => r.modelId === id);
    // raw wins order: test/oracle (4-1) above qwen2.5-3b (3-0); the 95% LCB
    // of qwen's win rate (3/3 ≈ 43.8%) beats oracle's (4/5 ≈ 37.6%) — the
    // proven-undefeated record must flip above the extra-win-with-a-loss one
    assert.ok(ix(raw, "test/oracle") < ix(raw, "qwen2.5-3b-instruct"));
    assert.ok(ix(wil, "qwen2.5-3b-instruct") < ix(wil, "test/oracle"));
    // every row carries its LCB
    assert.ok(wil.every((r) => typeof r.lcb === "number" && r.lcb >= 0 && r.lcb <= 100));
  } finally { console.log = origLog; }
});

test("chainFeed --bank follows custody one hop — venues join via run refs", async () => {
  const { chainFeed } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    // the most-venue'd bank in the bundle: its run-hosted venues must
    // appear even though venue accounts never reference the bank directly
    const venueRows = (await chainFeed(500, "venue,resolution", 0, true, snapPath, undefined, true, undefined,
      "8FoR83eiNPfd8vPtRBRtFCgA1BsUnKmHUTcLTGjPiETb")) as any[];
    assert.ok(venueRows.length > 5);
    assert.ok(venueRows.every((e) => e.type === "venue" || e.type === "resolution"));
    // every event in a bank filter mentions it (the bank's own name shows
    // in msgs like "on sealed-test", and venue events always ride run refs)
    const runs = (await chainFeed(500, "run", 0, true, snapPath, undefined, true, undefined, "sealed-test")) as any[];
    assert.ok(runs.length > 0);
    assert.ok(runs.every((e) => e.msg.includes("sealed-test")));
    // an unknown bank is an error, never an empty feed pretending coverage
    await assert.rejects(() => chainFeed(10, undefined, 0, true, snapPath, undefined, true, undefined, "no-such-bank"));
  } finally { console.log = origLog; }
});

test("marketLive lists only venues that can still take a bet", async () => {
  const { marketLive } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const out = (await marketLive(true, snapPath)) as any;
    const now = Math.floor(Date.now() / 1000);
    assert.ok(out.open > 0);
    // every listed venue's deadlines are still in the future — a venue
    // whose closes_at/resolve_by passed can't accept a position, and the
    // keeper board (not this one) owns sweeping it
    for (const v of out.venues) {
      assert.ok(!v.closesAt || v.closesAt > now);
      assert.ok(!v.resolveBy || v.resolveBy > now);
    }
    // sorted soonest-close first
    const cs = out.venues.map((v: any) => v.closesAt || Infinity);
    assert.deepEqual(cs, [...cs].sort((a, b) => a - b));
  } finally { console.log = origLog; }
});

test("chainMatrix ranks coverage over the most-run banks", async () => {
  const { chainMatrix } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const out = (await chainMatrix(8, true, snapPath)) as any;
    assert.equal(out.banks.length, 8);
    assert.ok(out.matrix.length > 0);
    // every row covers all 8 fixture banks (the seeded market suite) and
    // scores are in [0,100] — no phantom cells, no >100 arithmetic bugs
    for (const r of out.matrix) {
      assert.ok(r.banksCovered > 0);
      for (const s of r.scores) if (s) assert.ok(s.pct >= 0 && s.pct <= 100);
    }
    // sorted coverage-first: the top row never has fewer banks than the last
    const covs = out.matrix.map((r: any) => r.banksCovered);
    assert.deepEqual(covs, [...covs].sort((a, b) => b - a));
  } finally { console.log = origLog; }
});

test("marketSharps measures the book's anonymity set and honest P&L", async () => {
  const { marketSharps } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const out = (await marketSharps(1, true, snapPath)) as any;
    // the bundle's book is one-position-per-wallet by construction —
    // every resolved bettor is a distinct key, so maxResolved stays 1
    assert.equal(out.maxResolved, 1);
    assert.ok(out.bettors > 100);
    assert.equal(out.resolved, out.byWinRate.reduce((s: number, r: any) => s + r.resolved, 0));
    // honesty: payable is bounded by staked — no bettor finished positive
    // because hedge buckets burn against the winning share
    assert.ok(BigInt(out.staked) > BigInt(out.payable));
    assert.ok(out.byWinRate.every((s: any) => s.pnl === "0" || s.pnl.startsWith("-")));
  } finally { console.log = origLog; }
});

test("marketEscrow reconciles every lamport to an obligation bucket", async () => {
  const { marketEscrow } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const out = (await marketEscrow(true, snapPath)) as any;
    const B = (k: string) => BigInt(out[k]);
    // the ledger must sum EXACTLY to cumulative stakes — any drift is a
    // bookkeeping bug, not a rounding tolerance
    const recomposed = B("inPlay") + B("owedWinners") + B("owedRefunds") +
      B("feesAccrued") + B("contingent") + B("dead") + B("dust") +
      B("bountyOpen") + B("bountyExpired") + B("settledOut");
    assert.equal(recomposed, B("cumulativeStaked"));
    // the bundle's finding: every winning bucket was backed, so `dead`
    // is provably zero and the outflow is winner pots + refunds
    assert.equal(B("dead"), 0n);
    assert.ok(B("claimedWinnerPots") > 0n);
    assert.ok(B("settledOut") >= B("claimedWinnerPots"));
  } finally { console.log = origLog; }
});

test("chainAnomalies enumerates the bundle's own soft spots", async () => {
  const { chainAnomalies } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const out = (await chainAnomalies(true, snapPath)) as any;
    const byWhat = new Map(out.findings.map((f: any) => [f.what, f]));
    // the disclosed warn: 29 post-reveal runs, honestly reported
    const post = byWhat.get("post-reveal evidence") as any;
    assert.equal(post.sev, "warn");
    assert.equal(post.count, 29);
    // the hard invariant: zero venues may touch post-reveal evidence
    const gate = byWhat.get("venues on post-reveal runs") as any;
    assert.equal(gate.count, 0);
    assert.equal(gate.sev, "ok");
    // escrow agrees: no dead money on this bundle
    const dead = byWhat.get("dead money (unbacked winning buckets)") as any;
    assert.equal(dead.sev, "ok");
    // every check returns a drill-in command — the surface is actionable
    for (const x of out.findings) assert.ok(x.drill.length > 0);
  } finally { console.log = origLog; }
});

test("chainProve mints a claim card that verifies — and fails on tamper", async () => {
  const { chainProve, chainProveVerify } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const origLog = console.log;
  console.log = () => {};
  try {
    const card = (await chainProve("ladder/model-a", undefined, snapPath)) as any;
    assert.equal(card.kind, "sealed-claim/v1");
    assert.ok(card.receipts.length > 0);
    assert.ok(card.runs.length > card.model.runsScored); // co-participant runs included
    assert.ok(card.venues.length > 0);
    const dir = mkdtempSync(join(tmpdir(), "sealed-claim-"));
    const good = join(dir, "claim.json");
    writeFileSync(good, JSON.stringify(card));
    const ok = (await chainProveVerify(good)) as any;
    assert.equal(ok.fail, 0);
    // a tampered aggregate must fail exactly at the replay check
    card.model.totalCorrect += 50;
    const bad = join(dir, "tampered.json");
    writeFileSync(bad, JSON.stringify(card));
    process.exitCode = 0;
    await chainProveVerify(bad);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("gateSweep frontiers — every model gets its strictest cleared line", async () => {
  const { gateSweep } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const rows = (await gateSweep({}, false, snapPath)) as any[];
    const byId = new Map(rows.map((r) => [r.modelId, r]));
    // frontier = strictest threshold cleared: perfect record survives the grid
    assert.equal(byId.get("test/sweep-run")?.frontier, 90);
    assert.equal(byId.get("mock/oracle-0.75")?.frontier, 80);
    // real open-weights models land exactly where their receipts put them
    assert.equal(byId.get("qwen2.5-3b-instruct")?.frontier, 20);
    // zero-score models never pass — no-evidence honesty, not disproof
    assert.equal(byId.get("qwen2.5-0.5b-instruct")?.frontier, null);
    // sorted by frontier desc then pct
    for (let i = 1; i < rows.length; i++)
      assert.ok((rows[i - 1].frontier ?? -1) > (rows[i].frontier ?? -1) ||
        ((rows[i - 1].frontier ?? -1) === (rows[i].frontier ?? -1) && rows[i - 1].pct >= rows[i].pct));
  } finally { console.log = origLog; }
});

test("compareMatrix — the N×N paired-evidence grid is antisymmetric and honest", async () => {
  const { compareMatrix } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  let emitted = "";
  const origLog = console.log;
  console.log = (x) => { emitted += String(x) + "\n"; };
  try {
    await compareMatrix(12, 1, true, snapPath);
  } finally { console.log = origLog; }
  const { top, cells, unrankedPairs } = JSON.parse(emitted);
  assert.ok(top.length >= 10);
  const idx = (id: string) => top.indexOf(id);
  // dark/model-a and ladder/model-a dead-heat on their shared banks: 0pp both ways
  assert.equal(cells[idx("dark/model-a")][idx("ladder/model-a")], 0);
  // qwen2.5-3b beats qwen2.5-1.5b on their shared bank — antisymmetric cell
  assert.ok(cells[idx("qwen2.5-3b-instruct")][idx("qwen2.5-1.5b-instruct")] > 0);
  assert.ok(cells[idx("qwen2.5-1.5b-instruct")][idx("qwen2.5-3b-instruct")] < 0);
  // disjoint coverage stays "—" (null), never assumed: mock/oracle-0.75 shares nothing with most
  assert.equal(cells[idx("mock/oracle-0.75")][idx("dark/model-a")], null);
  assert.ok(unrankedPairs > 300);
});

test("gateCert — a policy certificate verifies, and a flipped verdict fails", async () => {
  const { gateCert, gateCertVerify } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const origLog = console.log;
  console.log = () => {};
  try {
    const dir = mkdtempSync(join(tmpdir(), "sealed-cert-"));
    const good = join(dir, "cert.json");
    const cert = (await gateCert({ minPct: 60, minRuns: 3 }, good, snapPath)) as any;
    assert.equal(cert.kind, "sealed-policy/v1");
    assert.equal(cert.models.length, 31);
    assert.equal(cert.summary.pass + cert.summary.fail + cert.summary.noEvidence, 31);
    const ok = (await gateCertVerify(good)) as any;
    assert.equal(ok.fail, 0);
    // flip one stored verdict — the receipt replay must catch it
    cert.models[0].verdict.pass = !cert.models[0].verdict.pass;
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(cert));
    process.exitCode = 0;
    await gateCertVerify(bad);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  } finally { console.log = origLog; process.exitCode = 0; }
});

test("chainReport — the dossier as a document, card-hash pinned", async () => {
  const { chainReport } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const origLog = console.log;
  console.log = () => {};
  try {
    const dir = mkdtempSync(join(tmpdir(), "sealed-report-"));
    const file = join(dir, "r.md");
    const r = (await chainReport("qwen2.5-3b-instruct", file, snapPath)) as any;
    assert.equal(r.model, "qwen2.5-3b-instruct");
    const md = readFileSync(file, "utf8");
    assert.match(md, /sealed-report\/v1/);
    assert.match(md, /claim-card content sha256 `945c3c2b/); // stable canonical digest
    assert.match(md, /23\/96 items \(23\.96%\)/);
    assert.match(md, /Score receipts[\s\S]*3 receipts/);
    assert.match(md, /post-reveal runs: 0/);
  } finally { console.log = origLog; }
});

test("marketUnclaimed — the owed-money ledger names who can collect", async () => {
  const { marketUnclaimed } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const out = (await marketUnclaimed(true, snapPath)) as any;
    assert.equal(out.positions, 17);
    assert.equal(out.payableSol, 0.58);
    assert.equal(out.refundSol, 0);
    assert.equal(out.bettors.length, 17);
    assert.equal(out.bettors[0].payableSol, 0.1); // largest claim first
  } finally { console.log = origLog; }
});

test("gateWhy — the policy envelope names the binding constraint", async () => {
  const { gateWhy } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const out = (await gateWhy("qwen2.5-3b-instruct", undefined, true, snapPath)) as any;
    const all = out.envelope.find((e: any) => e.name === "all evidence").e;
    assert.equal(all.runs, 3);
    assert.equal(all.items, 96);
    assert.equal(all.maxMinRuns, 3);
    assert.ok(Math.abs(all.maxMinPct - 23.95) < 0.01);
    // under a failing policy the binding constraint is named
    const v = (await gateWhy("qwen2.5-3b-instruct", { minPct: 50, minRuns: 4 }, true, snapPath)) as any;
    assert.equal(v.verdict.pass, false);
    assert.equal(v.binding, "accuracy");
    // a model whose sample is thin: test/sweep-run fails runs>=20 — binding is runs
    const v2 = (await gateWhy("test/sweep-run", { minPct: 95, minRuns: 20 }, true, snapPath)) as any;
    assert.equal(v2.binding, "runs");
  } finally { console.log = origLog; }
});

test("bank depth — venues' lamports attribute to the exams they priced", async () => {
  const { bankList, bankShow } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const rows = (await bankList(snapPath, true, undefined, true)) as any[];
    const withDepth = rows.filter(r => (r.depthSol ?? 0) > 0);
    assert.ok(withDepth.length > 0, "some bank must carry venue depth");
    assert.ok(withDepth.every(r => r.depthSol! > 0));
    const b = (await bankShow("A6UkXHYNM8msZgw2PNwAXAj4jTLFLM4equFEZoFtCty1", true, snapPath)) as any;
    assert.equal(b.marketDepth.venues, 10);
    assert.ok(Number(b.marketDepth.lamports) > 1.5e9);
  } finally { console.log = origLog; }
});

test("records --vouched isolates venue-attested receipts only", async () => {
  const { modelRecordList } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const all = (await modelRecordList(snapPath, true)) as any[];
    const vouched = (await modelRecordList(snapPath, true, false, true)) as any[];
    assert.ok(all.length > vouched.length, "vouched is a strict subset");
    assert.equal(vouched.length, 4);
    assert.ok(vouched.every(r => r.vouched !== null));
    assert.ok(vouched.some(r => r.modelId === "test/sweep-run"));
  } finally { console.log = origLog; }
});

test("runs --post-reveal isolates the flagged substrate honestly", async () => {
  const { runList } = await import("../src/chain.js");
  const snapPath = new URL("../../../web/snapshot.json", import.meta.url).pathname;
  const origLog = console.log;
  console.log = () => {};
  try {
    const all = (await runList({ snapPath, json: true })) as any[];
    const pr = (await runList({ snapPath, json: true, postReveal: true })) as any[];
    const clean = (await runList({ snapPath, json: true, postReveal: false })) as any[];
    assert.ok(pr.length > 0, "post-reveal runs exist in the bundle");
    assert.ok(pr.every(r => r.postReveal), "every filtered row carries the flag");
    assert.ok(clean.every(r => !r.postReveal));
    assert.equal(pr.length + clean.length, all.length, "partition is total");
    // real models carry the flag too — honesty over polish
    assert.ok(pr.some(r => r.model === "qwen2.5-1.5b-instruct"));
  } finally { console.log = origLog; }
});
