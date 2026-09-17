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
import { genAnswerHash, genItemsFold, hex } from "./hash.js";
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
  return /^[+-]?\d+$/.test(canonical) ? BigInt(canonical) : UNPARSEABLE;
}

export interface ItemChunkState {
  benchmark: PublicKey;
  index: number;
  partsWritten: number;
  specs: ItemSpec[];
}

/** Decode an ItemChunk account: 8 disc | 32 benchmark | 2 index | 1 bump | 1 parts | 160 specs. */
export function decodeItemChunk(data: Buffer): ItemChunkState {
  if (data.length !== 8 + 32 + 2 + 1 + 1 + CHUNK * ITEM_SPEC_LEN) {
    throw new Error(`ItemChunk size mismatch: ${data.length}`);
  }
  const specs: ItemSpec[] = [];
  for (let i = 0; i < CHUNK; i++) {
    const o = 44 + i * ITEM_SPEC_LEN;
    specs.push({ a: data[o], b: data[o + 1], c: data[o + 2], op0: data[o + 3], op1: data[o + 4] });
  }
  return {
    benchmark: new PublicKey(data.subarray(8, 40)),
    index: data.readUInt16LE(40),
    partsWritten: data[43],
    specs,
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
  for (const c of byIndex) {
    for (let part = 0; part < CHUNK / PART; part++) {
      if (!(c.partsWritten & (1 << part))) throw new Error(`chunk ${c.index} part ${part} not minted yet`);
      const bytes = new Uint8Array(PART * ITEM_SPEC_LEN);
      for (let k = 0; k < PART; k++) bytes.set(specBytes(c.specs[part * PART + k]), k * ITEM_SPEC_LEN);
      root = genItemsFold(root, c.index, part, bytes);
    }
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
