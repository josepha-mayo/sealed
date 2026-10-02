// Headless test of the explorer's in-browser audit: stubs DOM + web3.js,
// feeds web/snapshot.json through the real page code, then runs runAudit()
// and prints the rendered verdicts. Usage: node scripts/audit-browser-test.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).join("\n");

// --- minimal DOM ---
const els = new Map();
const mkEl = (id) => {
  if (!els.has(id)) els.set(id, { id, innerHTML: "", textContent: "", value: "", scrollIntoView() {}, click() {}, files: [] });
  return els.get(id);
};
const documentStub = { getElementById: mkEl };
const snapText = readFileSync(join(ROOT, "web", "snapshot.json"), "utf8");

const ctx = {
  window: { solanaWeb3: web3 },
  document: documentStub,
  location: { search: "?snapshot=bundled" },
  URLSearchParams,
  fetch: async () => ({ ok: true, json: async () => JSON.parse(snapText) }),
  TextEncoder, TextDecoder, DataView, Uint8Array, BigInt, JSON, Math, Number, Date,
  crypto, console, setInterval: () => 0, setTimeout, queueMicrotask,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
};
ctx.window.location = ctx.location;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

await new Promise((r) => setTimeout(r, 50)); // let applySnapshot + renderAll settle
// renderAll must COMPLETE — a mid-render throw leaves #out empty and only
// surfaces in #err, which the audit rows alone would never show.
const renderErr = els.get("err")?.textContent ?? "";
const rendered = els.get("out")?.innerHTML ?? "";
if (renderErr || !rendered.length) {
  console.log(`RENDER FAILURE: ${renderErr || "#out never written"}`);
  process.exit(1);
}
vm.runInContext("runAudit(true)", ctx);
await new Promise((r) => setTimeout(r, 3000));
const out = els.get("auditres").innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&middot;/g, "·").replace(/&amp;/g, "&").trim();
console.log(out);
const fails = (out.match(/FAIL/g) || []).length;
console.log(`\n${fails === 0 ? "ALL GREEN" : fails + " FAILURES"} (render ok: ${rendered.length} chars)`);
process.exit(fails === 0 ? 0 : 1);
