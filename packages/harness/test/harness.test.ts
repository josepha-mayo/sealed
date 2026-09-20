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
