// Recompute a Merkle root from a prove artifact and compare with outputsRoot.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { outputLeaf, verifyProof } = await import("../packages/harness/src/hash.js").catch(() => ({}));
// hash.ts is TS; do it inline instead:
const { createHash } = await import("node:crypto");
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const D_OUT = Buffer.from("sealed/v1/output\0");
const D_NODE = Buffer.from([1]);
let h = sha(D_OUT, u32(p.itemIndex), u64(p.outputHash));
let i = p.itemIndex;
for (const s of p.proof.map((x) => Buffer.from(x, "hex"))) {
  h = sha(D_NODE, i % 2 === 0 ? h : s, i % 2 === 0 ? s : h);
  i >>= 1;
}
const root = h.toString("hex");
console.log("recomputed:", root);
console.log("expected:  ", p.outputsRoot);
console.log(root === p.outputsRoot ? "VERIFIED" : "MISMATCH");
