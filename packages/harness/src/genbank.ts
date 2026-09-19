/**
 * Generated banks: item specs minted inside MPC by `gen_part` and stored
 * publicly in `ItemChunk` accounts. Anyone can render the prompts from the
 * specs; the answers were born encrypted to the MXE key — no answer key ever
 * existed in plaintext.
 *
 * The circuit semantics (encrypted-ixs `gen_part`):
 *   spec  = { a, b, c, op0, op1 }  (a..c drawn 0..63, ops from {0,1,2})
 *   value = apply_op(apply_op(a, op0, b), op1, c)   ops: 0=+ 1=- 2=*
 *   hash  = genAnswerHash(benchmark_id, item_index, value)
 */
import { PublicKey } from "@solana/web3.js";
import { genAnswerHash, genItemsFold, privItemsFold, hex } from "./hash.js";
import { type Bank, type BankItem, CHUNK, PART } from "./bank.js";

export interface ItemSpec {
  a: number;
  b: number;
  c: number;
  op0: number;
  op1: number;
}

export const ITEM_SPEC_LEN = 5;
const OPS = ["+", "-", "*"] as const;
const PARTS = CHUNK / PART;

/** Apply one spec op exactly like the circuit's `apply_op`. */
const apply = (x: bigint, op: number, y: bigint): bigint =>
  op === 0 ? x + y : op === 1 ? x - y : x * y;

/** The integer the MPC cluster computed as this item's answer. */
export function evalSpec(s: ItemSpec): bigint {
  return apply(apply(BigInt(s.a), s.op0, BigInt(s.b)), s.op1, BigInt(s.c));
}

/** Deterministic prompt for a spec — the same for every renderer, on any machine. */
export function renderPrompt(s: ItemSpec): string {
  const sym = (op: number) => OPS[op] ?? `?op${op}`;
  const expr = `(((${s.a} ${sym(s.op0)} ${s.b}) ${sym(s.op1)} ${s.c}))`;
  return `Evaluate ${expr}. Reply with only the integer.\nANSWER:`;
}

/** Compact spec bytes exactly as stored on-chain and folded into items_root. */
export function specBytes(s: ItemSpec): Uint8Array {
  return new Uint8Array([s.a, s.b, s.c, s.op0, s.op1]);
}

/**
 * Value the circuit can never produce: reachable answers are bounded by
 * (0*63*63 .. 63*63*63), so i64::MIN is a safe stand-in for a model reply
 * that does not parse as an integer — it will simply never match.
 */
export const UNPARSEABLE = -(1n << 63n);

/** Parse a canonical reply as the integer the generated bank expects. */
export function parseCanonicalInt(canonical: string): bigint {
  if (!/^[+-]?\d+$/.test(canonical)) return UNPARSEABLE;
  const v = BigInt(canonical);
  // Out-of-i64 values would crash setBigInt64 downstream — treat as wrong answer.
  return v >= -(1n << 63n) && v <= (1n << 63n) - 1n ? v : UNPARSEABLE;
}

export interface ItemChunkState {
  benchmark: PublicKey;
  index: number;
  partsWritten: number;
  specs: ItemSpec[];
  /** Landing sequence per part — the on-chain fold is landing-order-dependent. */
  mintOrder: number[];
}

/** Decode an ItemChunk account: 8 disc | 32 benchmark | 2 index | 1 bump | 1 parts | 160 specs | 8 mint_order. Tolerates tail-appended fields. */
export function decodeItemChunk(data: Buffer): ItemChunkState {
  if (data.length < 8 + 32 + 2 + 1 + 1 + CHUNK * ITEM_SPEC_LEN + PARTS * 2) {
    throw new Error(`ItemChunk size mismatch: ${data.length}`);
  }
  const specs: ItemSpec[] = [];
  for (let i = 0; i < CHUNK; i++) {
    const o = 44 + i * ITEM_SPEC_LEN;
    specs.push({ a: data[o], b: data[o + 1], c: data[o + 2], op0: data[o + 3], op1: data[o + 4] });
  }
  const mintOrder: number[] = [];
  for (let p = 0; p < PARTS; p++) mintOrder.push(data.readUInt16LE(44 + CHUNK * ITEM_SPEC_LEN + p * 2));
  return {
    benchmark: new PublicKey(data.subarray(8, 40)),
    index: data.readUInt16LE(40),
    partsWritten: data[43],
    specs,
    mintOrder,
  };
}

/**
 * Render a Bank file from fetched ItemChunks. `answer` and `answerHash` are
 * derived locally for prompts/mock/pre-score; on-chain scoring never sees them.
 * `itemsRoot` is recomputed with the same fold the callback applies.
 */
export function bankFromChunks(benchmarkId: number, chunks: ItemChunkState[]): Bank {
  const items: BankItem[] = [];
  let root: Uint8Array = new Uint8Array(32);
  const byIndex = chunks.slice().sort((a, b) => a.index - b.index);
  // Replay the on-chain fold in true landing order — callbacks may land in any
  // sequence, and each part's position is stamped in `mint_order`.
  const steps: { seq: number; ci: number; part: number; bytes: Uint8Array }[] = [];
  for (const c of byIndex) {
    for (let part = 0; part < CHUNK / PART; part++) {
      if (!(c.partsWritten & (1 << part))) throw new Error(`chunk ${c.index} part ${part} not minted yet`);
      const bytes = new Uint8Array(PART * ITEM_SPEC_LEN);
      for (let k = 0; k < PART; k++) bytes.set(specBytes(c.specs[part * PART + k]), k * ITEM_SPEC_LEN);
      steps.push({ seq: c.mintOrder[part], ci: c.index, part, bytes });
    }
  }
  for (const s of steps.sort((a, b) => a.seq - b.seq)) root = genItemsFold(root, s.ci, s.part, s.bytes);
  for (const c of byIndex) {
    for (let k = 0; k < CHUNK; k++) {
      const index = c.index * CHUNK + k;
      const spec = c.specs[k];
      const answer = evalSpec(spec).toString();
      items.push({
        index,
        family: "gen_arith",
        prompt: renderPrompt(spec),
        answer,
        salt: "",
        answerHash: genAnswerHash(benchmarkId, index, evalSpec(spec)).toString(),
      });
    }
  }
  return {
    schema: "sealed.bank/1",
    kind: "generated",
    benchmarkId,
    chunkCount: byIndex.length,
    chunk: CHUNK,
    itemsRoot: hex(root),
    items,
  };
}

// ── Private generated banks ──────────────────────────────────────────────────
//
// `gen_part_private` mints the same specs but returns `Pack<GenPart>` encrypted
// to the authority's x25519 key. On chain, `PrivItemChunk` stores only
// ciphertext — a public RPC reader sees encrypted bytes, the items_root fold
// commits to (cts || nonce) so decryption can be verified.

export const PRIV_CTS_PER_PART = 2;
const PACK_U8_PER_FIELD = 26; // 255-bit field, 40-bit stat reserve (arcis::Pack)

export interface PrivItemChunkState {
  benchmark: PublicKey;
  index: number;
  partsWritten: number;
  encryptionKey: Uint8Array;
  /** 8 ciphertexts (2 per part), each 32 bytes. */
  ciphertexts: Uint8Array[];
  /** Per-part Shared-encryption nonces. */
  nonces: bigint[];
  /** Landing sequence per part — the on-chain fold is landing-order-dependent. */
  mintOrder: number[];
}

/**
 * Decode a PrivItemChunk account:
 * 8 disc | 32 benchmark | 2 index | 1 bump | 1 parts | 32 key | 64 nonces | 256 cts | 8 mint_order.
 */
export function decodePrivItemChunk(data: Buffer): PrivItemChunkState {
  const len = 8 + 32 + 2 + 1 + 1 + 32 + PARTS * 16 + 8 * 32 + PARTS * 2;
  if (data.length < len) throw new Error(`PrivItemChunk size mismatch: ${data.length}`);
  const nonces: bigint[] = [];
  for (let p = 0; p < PARTS; p++) nonces.push(readU128le(data, 76 + p * 16));
  const ciphertexts: Uint8Array[] = [];
  for (let i = 0; i < 8; i++) ciphertexts.push(new Uint8Array(data.subarray(140 + i * 32, 172 + i * 32)));
  const mintOrder: number[] = [];
  for (let p = 0; p < PARTS; p++) mintOrder.push(data.readUInt16LE(396 + p * 2));
  return {
    benchmark: new PublicKey(data.subarray(8, 40)),
    index: data.readUInt16LE(40),
    partsWritten: data[43],
    encryptionKey: new Uint8Array(data.subarray(44, 76)),
    ciphertexts,
    nonces,
    mintOrder,
  };
}

function readU128le(buf: Buffer, off: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
}

/**
 * Unpack one decrypted part: 2 field elements → 40 spec bytes → 8 specs.
 * Field 0 carries bytes 0..25, field 1 carries bytes 26..39 (little-endian
 * bit order, matching arcis::Pack's 26-u8-per-container layout).
 */
export function unpackSpecs(fields: bigint[]): ItemSpec[] {
  if (fields.length !== PRIV_CTS_PER_PART) throw new Error(`expected ${PRIV_CTS_PER_PART} packed fields, got ${fields.length}`);
  const bytes = new Array<number>(PART * ITEM_SPEC_LEN);
  for (let i = 0; i < bytes.length; i++) {
    const f = i < PACK_U8_PER_FIELD ? 0 : 1;
    const shift = BigInt(8 * (i - f * PACK_U8_PER_FIELD));
    bytes[i] = Number((fields[f] >> shift) & 0xffn);
  }
  const specs: ItemSpec[] = [];
  for (let k = 0; k < PART; k++) {
    const o = k * ITEM_SPEC_LEN;
    const s = { a: bytes[o], b: bytes[o + 1], c: bytes[o + 2], op0: bytes[o + 3], op1: bytes[o + 4] };
    if (s.a > 63 || s.b > 63 || s.c > 63 || s.op0 > 2 || s.op1 > 2)
      throw new Error(`spec ${k} out of range — wrong key or layout?`);
    specs.push(s);
  }
  return specs;
}

/**
 * Recompute a private bank's items_root from ciphertext alone — exactly the
 * fold the callback applies. Anyone can verify this without the key.
 */
export function privItemsRoot(chunks: PrivItemChunkState[]): string {
  let root: Uint8Array = new Uint8Array(32);
  // Replay the fold in true landing order (see ItemChunk.mint_order).
  const steps: { seq: number; ci: number; part: number; enc: Uint8Array }[] = [];
  for (const c of chunks.slice().sort((a, b) => a.index - b.index)) {
    for (let part = 0; part < PARTS; part++) {
      if (!(c.partsWritten & (1 << part))) throw new Error(`chunk ${c.index} part ${part} not minted yet`);
      const enc = new Uint8Array(PRIV_CTS_PER_PART * 32 + 16);
      for (let k = 0; k < PRIV_CTS_PER_PART; k++) enc.set(c.ciphertexts[part * PRIV_CTS_PER_PART + k], k * 32);
      const nb = new Uint8Array(16);
      let n = c.nonces[part];
      for (let i = 0; i < 16; i++) { nb[i] = Number(n & 0xffn); n >>= 8n; }
      enc.set(nb, PRIV_CTS_PER_PART * 32);
      steps.push({ seq: c.mintOrder[part], ci: c.index, part, enc });
    }
  }
  for (const s of steps.sort((a, b) => a.seq - b.seq)) root = privItemsFold(root, s.ci, s.part, s.enc);
  return hex(root);
}

/**
 * Render a Bank from a private bank's decrypted spec parts.
 * `parts[chunkIndex][part]` = the 8 specs of that part.
 */
export function privBankFromSpecs(benchmarkId: number, chunkCount: number, parts: ItemSpec[][][], itemsRoot: string): Bank {
  const items: BankItem[] = [];
  for (let ci = 0; ci < chunkCount; ci++) {
    for (let k = 0; k < CHUNK; k++) {
      const spec = parts[ci][Math.floor(k / PART)][k % PART];
      const index = ci * CHUNK + k;
      const answer = evalSpec(spec);
      items.push({
        index,
        family: "gen_arith",
        prompt: renderPrompt(spec),
        answer: answer.toString(),
        salt: "",
        answerHash: genAnswerHash(benchmarkId, index, answer).toString(),
      });
    }
  }
  return {
    schema: "sealed.bank/1",
    kind: "generated-private",
    benchmarkId,
    chunkCount,
    chunk: CHUNK,
    itemsRoot,
    items,
  };
}
