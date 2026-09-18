// Recompute a Merkle root from a prove artifact and compare with outputsRoot.
// Two-level commitment (same as score_chunk on-chain):
//   leaf = sha256("sealed/v1/chunkout\0" || u16le(chunkIndex) || 32×u64le outputs)
//   node = sha256(0x01 || left || right)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const D_COUT = Buffer.from("sealed/v1/chunkout\0");
const D_NODE = Buffer.from([1]);
const outputs = [...(p.chunkOutputs ?? [p.outputHash])]; // tolerate a single-output artifact
while (outputs.length < 32) outputs.push(0); // chunkOutLeaf zero-pads short tails
let h = sha(D_COUT, u32(p.chunkIndex).subarray(0, 2), ...outputs.map(u64));
let i = p.chunkIndex;
for (const s of p.proof.map((x) => Buffer.from(x, "hex"))) {
  h = sha(D_NODE, i % 2 === 0 ? h : s, i % 2 === 0 ? s : h);
  i >>= 1;
}
const root = h.toString("hex");
console.log(`item ${p.itemIndex} (chunk ${p.chunkIndex}), ${outputs.length} outputs in leaf`);
console.log("recomputed:", root);
console.log("expected:  ", p.outputsRoot);
console.log(root === p.outputsRoot ? "VERIFIED" : "MISMATCH");
