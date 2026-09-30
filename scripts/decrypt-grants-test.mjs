// Offline regression for the explorer's "decrypt as delegate" feature:
// runs the browser code path end-to-end — web/vendor/rescue.mjs + the committed
// throwaway delegate key + ShareGrant accounts out of web/snapshot.json —
// and checks the decrypted specs against the bank's on-chain ciphertext fold.
// No chain access: fully offline, CI-safe.
// Usage: node scripts/decrypt-grants-test.mjs
import { readFileSync } from "node:fs";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { RescueCipher } from "../web/vendor/rescue.mjs";

const GRANT_DISC = "a47067c1839cb4c0";
const PRIVATE_BANK = "8HHm4HgAjSDMc1HWMBpsgY5LZ3saEEyZenM3KyitVAug";

const b58d = (s) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const M = Object.fromEntries([...A].map((c, i) => [c, BigInt(i)]));
  let n = 0n; for (const c of s) { if (!(c in M)) throw new Error("bad base58"); n = n * 58n + M[c]; }
  const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
};
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const OPS = ["+", "-", "*"];
const specVal = (s) => ((x, y, z, o0, o1) => { const ap = (p, o, q) => (o === 0 ? p + q : o === 1 ? p - q : p * q); return ap(ap(x, o0, y), o1, z); })(s.a, s.b, s.c, s.op0, s.op1);

function unpackSpecs(fields) {
  if (fields.length !== 2) throw new Error(`expected 2 packed fields, got ${fields.length}`);
  const bytes = new Array(40);
  for (let i = 0; i < 40; i++) {
    const f = i < 26 ? 0 : 1;
    bytes[i] = Number((fields[f] >> BigInt(8 * (i - f * 26))) & 0xffn);
  }
  const specs = [];
  for (let k = 0; k < 8; k++) {
    const o = k * 5;
    const s = { a: bytes[o], b: bytes[o + 1], c: bytes[o + 2], op0: bytes[o + 3], op1: bytes[o + 4] };
    if (s.a > 63 || s.b > 63 || s.c > 63 || s.op0 > 2 || s.op1 > 2) throw new Error(`spec ${k} out of range`);
    specs.push(s);
  }
  return specs;
}

const snap = JSON.parse(readFileSync(new URL("../web/snapshot.json", import.meta.url), "utf8"));
const demo = JSON.parse(readFileSync(new URL("../web/demo-delegate.json", import.meta.url), "utf8"));
if (!snap.meta?.mxe_x25519) throw new Error("snapshot.meta.mxe_x25519 missing — regenerate with scripts/snapshot.mjs");

const secret = Uint8Array.from(demo.secret_key);
const priv = ed25519.utils.toMontgomerySecret(secret.slice(0, 32));
const viewerPub = ed25519.utils.toMontgomery(secret.slice(32, 64));
const viewerB58 = ((u8) => { let n = 0n; for (const b of u8) n = n * 256n + BigInt(b); const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } return s; })(viewerPub);
if (viewerB58 !== demo.viewer_x25519) throw new Error("demo key viewer mismatch — keypair file corrupt");

const cipher = new RescueCipher(x25519.getSharedSecret(priv, unhex(snap.meta.mxe_x25519)));

const grants = snap.sealed
  .filter(({ data }) => hex(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).slice(0, 8)) === GRANT_DISC)
  .map(({ pubkey, data }) => {
    const d = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return {
      pk: pubkey,
      bench: (() => { const b = d.slice(8, 40); let n = 0n; for (const x of b) n = n * 256n + BigInt(x); const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } return s; })(),
      chunk: v.getUint16(40, true), part: d[42],
      viewer: (() => { const b = d.slice(44, 76); let n = 0n; for (const x of b) n = n * 256n + BigInt(x); const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } return s; })(),
      nonce: d.slice(108, 124),
      cts: [d.slice(124, 156), d.slice(156, 188)],
    };
  })
  .filter((g) => g.bench === PRIVATE_BANK && g.viewer === viewerB58)
  .sort((a, b) => a.chunk - b.chunk || a.part - b.part);

console.log(`${grants.length} demo-delegate grants on ${PRIVATE_BANK.slice(0, 8)}…`);
if (!grants.length) throw new Error("no grants found — run the reshare step first");

const specs = [];
for (const g of grants) {
  const fields = cipher.decrypt(g.cts.map((c) => [...c]), g.nonce);
  specs.push(...unpackSpecs(fields));
}
console.log(`decrypted ${specs.length} item specs`);
if (specs.length !== 32) throw new Error(`expected 32 specs, got ${specs.length}`);

// Exact-answer pin: sha256 over the full decrypted spec list. Keeps the CI
// check deterministic without storing a single plaintext question in git.
const { createHash } = await import("node:crypto");
const digest = createHash("sha256").update(JSON.stringify(specs)).digest("hex");
const EXPECTED = "af15a73ddac76e0abc96860349768c61013d7947057882e2cdddfd857dbbff22";
if (digest !== EXPECTED) throw new Error(`spec digest drifted: ${digest}`);
console.log(`spec digest ${digest.slice(0, 16)}… matches pin`);

// Reference check: the harness' own delegate-bank reconstruction (written to
// /tmp/demo-bank.json by `chain delegate-bank`) must agree spec-for-spec.
let ref = null;
try { ref = JSON.parse(readFileSync("/tmp/demo-bank.json", "utf8")); } catch { /* optional */ }
if (ref?.items?.length === 32) {
  let ok = 0;
  for (let i = 0; i < 32; i++) {
    const s = specs[i];
    const want = `Evaluate (((${s.a} ${OPS[s.op0]} ${s.b}) ${OPS[s.op1]} ${s.c})). Reply with only the integer.\nANSWER:`;
    if (ref.items[i].prompt === want && BigInt(ref.items[i].answer) === BigInt(specVal(specs[i]))) ok++;
  }
  console.log(`vs harness delegate-bank: ${ok}/32 items identical`);
  if (ok !== 32) throw new Error("browser-path decryption diverged from harness");
} else {
  console.log("(no /tmp/demo-bank.json reference — spec sanity already enforced)");
}
console.log("PASS: browser decrypt path reproduces the sealed exam");
