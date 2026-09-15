import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/** Deterministic, seedable PRNG: SHA-256 in counter mode over (seed, stream). */
export class Prng {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private counter = 0;
  private readonly key: Uint8Array;

  constructor(seed: string, stream: string) {
    this.key = sha256(utf8ToBytes(`sealed/prng/v1\0${seed}\0${stream}`));
  }

  private refill() {
    const block = new Uint8Array(this.key.length + 4);
    block.set(this.key);
    new DataView(block.buffer).setUint32(this.key.length, this.counter++, true);
    this.buf = sha256(block);
    this.pos = 0;
  }

  byte(): number {
    if (this.pos >= this.buf.length) this.refill();
    return this.buf[this.pos++];
  }

  u32(): number {
    return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
  }

  /** Uniform integer in [lo, hi] (inclusive) via rejection sampling. */
  int(lo: number, hi: number): number {
    const range = hi - lo + 1;
    if (range <= 0) throw new Error(`bad range ${lo}..${hi}`);
    const limit = Math.floor(0x1_0000_0000 / range) * range;
    let x = this.u32();
    while (x >= limit) x = this.u32();
    return lo + (x % range);
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)];
  }

  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.byte();
    return out;
  }
}
