/**
 * Off-chain half of a run: ask a model every item, canonicalize, hash, and commit.
 * The chain half (create_run / score_chunk) consumes `RunArtifact`.
 */
import { canonicalAnswer } from "./canonical.js";
import { answerHash, genAnswerHash, outputLeaf, merkleRoot, hex } from "./hash.js";
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
  const gen = bank.kind === "generated";
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

export function outputsRoot(hashes: bigint[]): Uint8Array {
  return merkleRoot(hashes.map((h, i) => outputLeaf(i, h)));
}

/** Output hashes for chunk `i` in circuit order. */
export function runChunkOutputs(run: RunArtifact, i: number): bigint[] {
  return run.items.slice(i * CHUNK, (i + 1) * CHUNK).map((r) => BigInt(r.outputHash));
}
