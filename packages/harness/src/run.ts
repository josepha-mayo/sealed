/**
 * Off-chain half of a run: ask a model every item, canonicalize, hash, and commit.
 * The chain half (create_run / score_chunk) consumes `RunArtifact`.
 */
import { canonicalAnswer } from "./canonical.js";
import { answerHash, genAnswerHash, chunkOutLeaves, merkleRoot, hex } from "./hash.js";
import { parseCanonicalInt } from "./genbank.js";
import { type Bank, CHUNK } from "./bank.js";
import { type HarnessConfig, DEFAULT_CONFIG, ModelClient, configHash } from "./models.js";

export interface RunItemRecord {
  index: number;
  raw: string;
  canonical: string;
  outputHash: string;
  /** Local-only convenience; never leaves the author's machine. */
  correct: boolean;
  latencyMs: number;
}

export interface RunArtifact {
  schema: "sealed.run/1";
  benchmarkId: number;
  model: string;
  harnessHash: string;
  outputsRoot: string;
  startedAt: string;
  finishedAt: string;
  items: RunItemRecord[];
  /** Local pre-score. The chain score is the one that counts. */
  localCorrect: number;
}

export async function runModel(
  bank: Bank,
  model: string,
  client: ModelClient,
  cfg: HarnessConfig = DEFAULT_CONFIG,
  onProgress?: (done: number, total: number) => void,
): Promise<RunArtifact> {
  const startedAt = new Date().toISOString();
  const completions = await client.completeAll(model, bank.items.map((it) => it.prompt), cfg, onProgress);
  // An endpoint that returns the SAME reply to every prompt (a credit-wall,
  // quota, or outage notice rendered as assistant content) is an API error,
  // not a model answering — committing it would mint a garbage 0-score run.
  const raws = completions.map((c) => c.text.trim());
  const top = new Map<string, number>();
  for (const r of raws) top.set(r, (top.get(r) ?? 0) + 1);
  const [topText, topCount] = [...top.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (topCount >= Math.max(4, Math.ceil(raws.length * 0.9)))
    throw new Error(
      `endpoint returned the same reply to ${topCount}/${raws.length} prompts — ` +
        `looks like an API error, not a model answer: ${topText.slice(0, 120)}`,
    );
  const gen = bank.kind === "generated" || bank.kind === "generated-private";
  const items: RunItemRecord[] = bank.items.map((it, i) => {
    const canonical = canonicalAnswer(completions[i].text);
    const h = gen
      ? genAnswerHash(bank.benchmarkId, it.index, parseCanonicalInt(canonical))
      : answerHash(bank.benchmarkId, it.index, canonical);
    return {
      index: it.index,
      raw: completions[i].text,
      canonical,
      outputHash: h.toString(),
      correct: h.toString() === it.answerHash,
      latencyMs: completions[i].latencyMs,
    };
  });
  return {
    schema: "sealed.run/1",
    benchmarkId: bank.benchmarkId,
    model,
    harnessHash: hex(configHash(cfg)),
    outputsRoot: hex(outputsRoot(items.map((r) => BigInt(r.outputHash)))),
    startedAt,
    finishedAt: new Date().toISOString(),
    items,
    localCorrect: items.filter((r) => r.correct).length,
  };
}

/** Two-level commitment: Merkle root over per-chunk leaves (32 outputs each).
 *  `score_chunk` verifies each submitted chunk against this root on-chain. */
export function outputsRoot(hashes: bigint[]): Uint8Array {
  return merkleRoot(chunkOutLeaves(hashes));
}

/** Output hashes for chunk `i` in circuit order. */
export function runChunkOutputs(run: RunArtifact, i: number): bigint[] {
  return run.items.slice(i * CHUNK, (i + 1) * CHUNK).map((r) => BigInt(r.outputHash));
}
