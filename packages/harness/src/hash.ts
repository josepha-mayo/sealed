import { sha256 } from "@noble/hashes/sha2.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";

const DOMAIN_ANSWER = utf8ToBytes("sealed/v1/answer\0");
const DOMAIN_ITEM = utf8ToBytes("sealed/v1/item\0");
const DOMAIN_OUTPUT = utf8ToBytes("sealed/v1/output\0");
const DOMAIN_GEN_ANSWER = utf8ToBytes("sealed/v1/genanswer\0");
const DOMAIN_GEN_ITEMS = utf8ToBytes("sealed/v1/genitems\0");
const DOMAIN_PRIV_ITEMS = utf8ToBytes("sealed/v1/privitems\0");
const DOMAIN_NODE = new Uint8Array([0x01]);

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

/** Signed 64-bit little-endian — the circuit encodes answers as two's-complement i64. */
export function i64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}

/** First 8 bytes of SHA-256 as a little-endian u64. This is what the circuit compares. */
export function truncate64(digest: Uint8Array): bigint {
  return new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0, true);
}

/** Hash of a canonical answer, bound to benchmark and item position. */
export function answerHash(benchmarkId: number, itemIndex: number, canonical: string): bigint {
  return truncate64(
    sha256(concatBytes(DOMAIN_ANSWER, u32le(benchmarkId), u32le(itemIndex), utf8ToBytes(canonical))),
  );
}

/**
 * Generated-bank answer fingerprint. The circuit hashes the answer as 8 raw
 * two's-complement bytes (SHA3-256), so the runner must parse the model's
 * canonical reply as an integer rather than hashing the string.
 */
export function genAnswerHash(benchmarkId: number, itemIndex: number, answer: bigint): bigint {
  return truncate64(
    sha3_256(concatBytes(DOMAIN_GEN_ANSWER, u32le(benchmarkId), u32le(itemIndex), i64le(answer))),
  );
}

/** One step of the on-chain items_root fold for generated banks (see gen_part_callback). */
export function genItemsFold(root: Uint8Array, chunkIndex: number, part: number, specBytes: Uint8Array): Uint8Array {
  return sha256(concatBytes(DOMAIN_GEN_ITEMS, root, u32le(chunkIndex).subarray(0, 2), new Uint8Array([part]), specBytes));
}

/** Same fold for PRIVATE banks: commits to the encrypted spec stream (cts + nonce). */
export function privItemsFold(root: Uint8Array, chunkIndex: number, part: number, encBytes: Uint8Array): Uint8Array {
  return sha256(concatBytes(DOMAIN_PRIV_ITEMS, root, u32le(chunkIndex).subarray(0, 2), new Uint8Array([part]), encBytes));
}

/** Merkle leaf committing to a question without revealing it (salted). */
export function itemLeaf(benchmarkId: number, itemIndex: number, salt: Uint8Array, prompt: string): Uint8Array {
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");
  return sha256(concatBytes(DOMAIN_ITEM, u32le(benchmarkId), u32le(itemIndex), salt, utf8ToBytes(prompt)));
}

/** Merkle leaf for one output hash of a run. */
export function outputLeaf(itemIndex: number, hash: bigint): Uint8Array {
  return sha256(concatBytes(DOMAIN_OUTPUT, u32le(itemIndex), u64le(hash)));
}

/** Binary Merkle root; odd levels duplicate the last node. Empty input -> 32 zero bytes. */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves.slice();
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(concatBytes(DOMAIN_NODE, l, r)));
    }
    level = next;
  }
  return level[0];
}

export function merkleProof(leaves: Uint8Array[], index: number): Uint8Array[] {
  const proof: Uint8Array[] = [];
  let level = leaves.slice();
  let i = index;
  while (level.length > 1) {
    const sib = i ^ 1;
    proof.push(sib < level.length ? level[sib] : level[i]);
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const l = level[j];
      const r = j + 1 < level.length ? level[j + 1] : level[j];
      next.push(sha256(concatBytes(DOMAIN_NODE, l, r)));
    }
    level = next;
    i >>= 1;
  }
  return proof;
}

export function verifyProof(leaf: Uint8Array, index: number, proof: Uint8Array[], root: Uint8Array): boolean {
  let h = leaf;
  let i = index;
  for (const sib of proof) {
    h = i % 2 === 0 ? sha256(concatBytes(DOMAIN_NODE, h, sib)) : sha256(concatBytes(DOMAIN_NODE, sib, h));
    i >>= 1;
  }
  return Buffer.from(h).equals(Buffer.from(root));
}

/** Stable hash of the harness configuration (prompt template, sampling, version). */
export function harnessHash(config: Record<string, unknown>): Uint8Array {
  const canonical = JSON.stringify(sortKeys(config));
  return sha256(utf8ToBytes(`sealed/v1/harness\0${canonical}`));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
