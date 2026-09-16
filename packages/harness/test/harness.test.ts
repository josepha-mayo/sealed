import { test } from "node:test";
import assert from "node:assert/strict";
import { Prng } from "../src/prng.js";
import { canonicalAnswer, normalize } from "../src/canonical.js";
import { answerHash, itemLeaf, outputLeaf, merkleRoot, merkleProof, verifyProof, harnessHash, hex } from "../src/hash.js";
import { FAMILIES } from "../src/items.js";
import { buildBank, chunkHashes, CHUNK } from "../src/bank.js";
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

test("output proofs verify against the committed outputs_root (prover/verifier split)", async () => {
  const bank = buildBank("master", 4, 1);
  const client = new ModelClient({
    apiKey: "test",
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const prompt: string = JSON.parse(String(init?.body)).messages[1].content;
      const item = bank.items.find((it) => it.prompt === prompt)!;
      return new Response(JSON.stringify({ choices: [{ message: { content: `ANSWER: ${item.answer}` } }] }), { status: 200 });
    }) as typeof fetch,
  });
  const run = await runModel(bank, "oracle/all", client);

  // Prover side: what `sealed prove --item i` emits.
  const i = 5;
  const leaves = run.items.map((r) => outputLeaf(r.index, BigInt(r.outputHash)));
  const proofJson = {
    leaf: Buffer.from(leaves[i]).toString("hex"),
    proof: merkleProof(leaves, i).map((p) => Buffer.from(p).toString("hex")),
    outputsRoot: run.outputsRoot,
  };

  // Verifier side: only sees the JSON (what web/index.html does).
  const leaf = new Uint8Array(Buffer.from(proofJson.leaf, "hex"));
  const proof = proofJson.proof.map((p: string) => new Uint8Array(Buffer.from(p, "hex")));
  assert.ok(verifyProof(leaf, i, proof, new Uint8Array(Buffer.from(proofJson.outputsRoot, "hex"))));

  // Tampered hash or wrong index must fail.
  const bad = new Uint8Array(leaves[i]); bad[0] ^= 1;
  assert.ok(!verifyProof(bad, i, proof, new Uint8Array(Buffer.from(run.outputsRoot, "hex"))));
  assert.ok(!verifyProof(leaf, i + 1, proof, new Uint8Array(Buffer.from(run.outputsRoot, "hex"))));
});
