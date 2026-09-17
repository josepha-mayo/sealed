import { Prng } from "./prng.js";
import { FAMILIES, type Item } from "./items.js";
import { answerHash, itemLeaf, merkleRoot, hex } from "./hash.js";

/** Must match `CHUNK` in encrypted-ixs and the program. */
export const CHUNK = 32;
export const PART = 8;

export interface BankItem extends Item {
  index: number;
  /** 16-byte salt (hex) for the Merkle leaf; revealed with the prompt when an item retires. */
  salt: string;
  /** Decimal string of the u64 answer hash (what gets encrypted and sealed). */
  answerHash: string;
}

export interface Bank {
  schema: "sealed.bank/1";
  /** "authored" (default) | "generated" — rendered from on-chain MPC-minted specs. */
  kind?: string;
  benchmarkId: number;
  chunkCount: number;
  chunk: number;
  itemsRoot: string;
  items: BankItem[];
}

/**
 * Deterministically generate a bank. `masterSeed` is the only secret: anyone holding
 * it can regenerate every prompt and answer, so it stays with the author.
 */
export function buildBank(masterSeed: string, benchmarkId: number, chunkCount: number): Bank {
  const total = chunkCount * CHUNK;
  const names = Object.keys(FAMILIES);
  const rng = new Prng(masterSeed, `bank/${benchmarkId}`);
  const items: BankItem[] = [];
  for (let index = 0; index < total; index++) {
    // Balanced family mix inside every chunk; difficulty ramps 1 -> 3 across the bank.
    const family = names[(index + Math.floor(index / CHUNK)) % names.length];
    const difficulty = 1 + Math.floor((3 * index) / total);
    const item = FAMILIES[family](new Prng(masterSeed, `item/${benchmarkId}/${index}`), difficulty);
    const salt = rng.bytes(16);
    items.push({
      index,
      ...item,
      salt: hex(salt),
      answerHash: answerHash(benchmarkId, index, item.answer).toString(),
    });
  }
  const leaves = items.map((it) => itemLeaf(benchmarkId, it.index, Buffer.from(it.salt, "hex"), it.prompt));
  return {
    schema: "sealed.bank/1",
    benchmarkId,
    chunkCount,
    chunk: CHUNK,
    itemsRoot: hex(merkleRoot(leaves)),
    items,
  };
}

/** Answer hashes for chunk `i`, in circuit order. */
export function chunkHashes(bank: Bank, i: number): bigint[] {
  return bank.items.slice(i * CHUNK, (i + 1) * CHUNK).map((it) => BigInt(it.answerHash));
}

/** Public, contamination-safe description of a bank (no prompts, no answers). */
export function publicSummary(bank: Bank) {
  const families: Record<string, number> = {};
  for (const it of bank.items) families[it.family] = (families[it.family] ?? 0) + 1;
  return {
    benchmarkId: bank.benchmarkId,
    itemCount: bank.items.length,
    chunkCount: bank.chunkCount,
    itemsRoot: bank.itemsRoot,
    families,
  };
}
