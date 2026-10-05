// Headless test of the explorer's in-browser audit: stubs DOM + web3.js,
// feeds web/snapshot.json through the real page code, then runs runAudit()
// and prints the rendered verdicts. Usage: node scripts/audit-browser-test.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
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
  if (!els.has(id)) els.set(id, { id, innerHTML: "", textContent: "", value: "", scrollIntoView() {}, click() {}, addEventListener() {}, files: [] });
  return els.get(id);
};
const documentStub = { getElementById: mkEl };
const snapText = readFileSync(join(ROOT, "web", "snapshot.json"), "utf8");

const ctx = {
  window: { solanaWeb3: web3 },
  document: documentStub,
  location: { search: "?snapshot=bundled" },
  URLSearchParams,
  fetch: async (u) => {
    const s = String(u);
    const file = s.startsWith("https://raw.githubusercontent.com") ? null // repo cross-check unreachable in test
      : s === "MANIFEST" ? "web/MANIFEST"
      : s.includes("calibration/bank") ? "web/calibration/bank.json"
      : s.includes("calibration/run-artifact-15b") ? "web/calibration/run-artifact-15b.json"
      : s.includes("calibration/run-artifact") ? "web/calibration/run-artifact.json"
      : s === "snapshot.json" ? "web/snapshot.json"
      : existsSync(join(ROOT, "web", s)) ? join("web", s)  // manifest-listed asset
      : "web/snapshot.json";
    if (file === null) return { ok: false, json: async () => { throw new Error("no net"); }, text: async () => { throw new Error("no net"); } };
    try {
      const buf = readFileSync(join(ROOT, file));
      return { ok: true, json: async () => JSON.parse(buf.toString("utf8")), text: async () => buf.toString("utf8"), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    } catch {
      return { ok: false, json: async () => { throw new Error("404"); }, text: async () => { throw new Error("404"); }, arrayBuffer: async () => { throw new Error("404"); } };
    }
  },
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
let fails = (out.match(/FAIL/g) || []).length;
// the calibration specimen viewer must render the full 32-item exam with the
// browser-side recount agreeing with the MPC-written score.
const calspec = els.get("calspec")?.innerHTML ?? "";
const calRows = (calspec.match(/<tr>/g) || []).length - 1;
const calOk = calRows === 32 && /MPC arithmetic reproduced/.test(calspec) && /7\/32/.test(calspec);
console.log(`calibration specimen viewer — ${calRows} item rows, recount-vs-MPC ${calOk ? "PASS" : "FAIL"}`);
if (!calOk) fails++;
// two-model discrimination matrix must be computed from the artifacts:
// both=2, only-3b=5, only-1.5b=0, neither=25 (qwen ordering is strict).
const discTxt = calspec.replace(/<[^>]+>/g, " ");
const discOk = /both right:\s*2\b/.test(discTxt)
  && /5 only-qwen2\.5-3b/.test(discTxt)
  && /0 only-qwen2\.5-1\.5b/.test(discTxt)
  && /neither:\s*25\b/.test(discTxt)
  && /2\/32/.test(discTxt);
console.log(`item discrimination matrix — two-model counts ${discOk ? "PASS" : "FAIL"}`);
if (!discOk) fails++;
console.log(`\n${fails === 0 ? "ALL GREEN" : fails + " FAILURES"} (render ok: ${rendered.length} chars)`);
process.exit(fails === 0 ? 0 : 1);
