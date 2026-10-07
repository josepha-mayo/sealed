// Headless test of the explorer's in-browser audit: stubs DOM + web3.js,
// feeds web/snapshot.json through the real page code, then runs runAudit()
// and prints the rendered verdicts. Usage: node scripts/audit-browser-test.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAGE = process.env.SEALED_PAGE ?? "index.html";
const html = readFileSync(join(ROOT, "web", PAGE), "utf8");
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).join("\n");

// --- minimal DOM ---
const els = new Map();
const mkEl = (id) => {
  if (!els.has(id)) els.set(id, { id, innerHTML: "", textContent: "", value: "", style: {}, scrollIntoView() {}, click() {}, addEventListener() {}, files: [] });
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
    const file = s.includes("raw.githubusercontent.com") && s.includes("evidence-anchor") ? "docs/evidence-anchor.json"
      : s.startsWith("https://raw.githubusercontent.com") ? null // repo cross-check unreachable in test
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
  TextEncoder, TextDecoder, DataView, Uint8Array, BigInt, JSON, Math, Number, Date, Response,
  crypto, console, setInterval: () => 0, setTimeout, clearTimeout, clearInterval: () => {}, queueMicrotask,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
};
ctx.window.location = ctx.location;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

// capsule self-containment — standalone.html must carry every pinned
// asset in window.__FILES and resolve fetches from it (no network).
if (PAGE === "standalone.html") {
  const files = ctx.window.__FILES ?? {};
  const keys = Object.keys(files).length;
  let snapOk = false, anchorOk = false;
  try { snapOk = (await ctx.window.fetch("snapshot.json")).ok; } catch {}
  try { anchorOk = (await ctx.window.fetch("https://raw.githubusercontent.com/josepha-mayo/sealed/main/docs/evidence-anchor.json")).ok; } catch {}
  const capOk = keys >= 139 && !!files["MANIFEST"] && snapOk && anchorOk;
  console.log(`capsule self-containment — ${keys} embedded files, snapshot + anchor fetch resolve offline ${capOk ? "PASS" : "FAIL"}`);
  if (!capOk) process.exit(1);
}

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
// in-page claim-card verifier: load the committed card through the page's
// fetch path and run verifyClaim() — the same sealed-claim/v1 checks as the
// CLI. A tampered aggregate must flip the verdict to FAILED.
await vm.runInContext("loadExampleClaim()", ctx);
await new Promise((r) => setTimeout(r, 50));
vm.runInContext("verifyClaim()", ctx);
await new Promise((r) => setTimeout(r, 50));
const claimTxt = (els.get("claimres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const claimOk = /CLAIM VERIFIED/.test(claimTxt) && (claimTxt.match(/pill cancelled/g) ?? "").length === 0;
console.log(`in-page claim-card verifier — committed qwen2.5-3b card ${claimOk ? "PASS" : "FAIL"}`);
if (!claimOk) fails++;
// tamper case: mutating the stored aggregate must flip the verdict.
els.get("claimjson").value = els.get("claimjson").value.replace('"totalCorrect": 23', '"totalCorrect": 24');
vm.runInContext("verifyClaim()", ctx);
await new Promise((r) => setTimeout(r, 50));
const tamperTxt = (els.get("claimres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const tamperOk = /CLAIM FAILED/.test(tamperTxt) && /FAIL record aggregate|record aggregate/.test(tamperTxt);
console.log(`in-page claim-card tamper case — mutated aggregate ${tamperOk ? "rejected PASS" : "MISSED FAIL"}`);
if (!tamperOk) fails++;
// caller-policy overlay on the claim verifier: --min-pct 20 passes, 50 fails
els.get("claimjson").value = els.get("claimjson").value.replace('"totalCorrect": 24', '"totalCorrect": 23');
els.get("claimPct").value = "20";
vm.runInContext("verifyClaim()", ctx);
await new Promise((r) => setTimeout(r, 50));
let polyTxt = (els.get("claimres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const polyOk = /policy verdict/.test(polyTxt) && /PASS/.test(polyTxt);
els.get("claimPct").value = "50";
vm.runInContext("verifyClaim()", ctx);
await new Promise((r) => setTimeout(r, 50));
polyTxt = (els.get("claimres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const polyFail = /policy verdict/.test(polyTxt) && /MISS accuracy/.test(polyTxt);
els.get("claimPct").value = "";
console.log(`in-page claim policy overlay — pct20 ${polyOk ? "passes" : "FAIL"}, pct50 ${polyFail ? "rejected PASS" : "MISSED FAIL"}`);
if (!polyOk || !polyFail) fails++;
// in-page policy-certificate verifier: load the committed cert through the
// page's fetch path and run verifyCert() — every record PDA re-derives and
// all 31 verdicts replay bit-exact. A flipped verdict must fail.
await vm.runInContext("loadCert()", ctx);
await new Promise((r) => setTimeout(r, 50));
vm.runInContext("verifyCert()", ctx);
await new Promise((r) => setTimeout(r, 50));
const certTxt = (els.get("certres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const certOk = /CERT VERIFIED/.test(certTxt) && /31\/31/.test(certTxt);
console.log(`in-page policy-cert verifier — committed min60-3runs cert ${certOk ? "PASS" : "FAIL"}`);
if (!certOk) fails++;
els.get("certjson").value = els.get("certjson").value.replace('"pass": true', '"pass": false');
vm.runInContext("verifyCert()", ctx);
await new Promise((r) => setTimeout(r, 50));
const certTamperTxt = (els.get("certres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const certTamperOk = /CERT FAILED/.test(certTamperTxt) && /verdict replay/.test(certTamperTxt);
console.log(`in-page policy-cert tamper case — flipped verdict ${certTamperOk ? "rejected PASS" : "MISSED FAIL"}`);
if (!certTamperOk) fails++;
// in-page match-card verifier: load the committed card through the page's
// fetch path and run verifyMatch() — every PDA re-derives and the qwen
// head-to-head replays. A tampered bank-win count must fail.
await vm.runInContext("loadMatch()", ctx);
await new Promise((r) => setTimeout(r, 50));
vm.runInContext("verifyMatch()", ctx);
await new Promise((r) => setTimeout(r, 50));
const matchTxt = (els.get("matchres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const matchOk = /MATCH VERIFIED/.test(matchTxt) && /2-0-0/.test(matchTxt) && /14\/64 vs 4\/64/.test(matchTxt);
console.log(`in-page match-card verifier — committed qwen-3b-vs-1.5b card ${matchOk ? "PASS" : "FAIL"}`);
if (!matchOk) fails++;
els.get("matchjson").value = els.get("matchjson").value.replace('"a": 2,', '"a": 1,');
vm.runInContext("verifyMatch()", ctx);
await new Promise((r) => setTimeout(r, 50));
const matchTamperTxt = (els.get("matchres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const matchTamperOk = /MATCH FAILED/.test(matchTamperTxt) && /bank wins/.test(matchTamperTxt);
console.log(`in-page match-card tamper case — mutated bank-wins ${matchTamperOk ? "rejected PASS" : "MISSED FAIL"}`);
if (!matchTamperOk) fails++;
// in-page trail-card verifier: the qwen3b ladder-leg card — 6/32 settled a
// dark market AND the 4-model ladder dead-heat. A mutated pool must fail.
await vm.runInContext("loadTrail()", ctx);
await new Promise((r) => setTimeout(r, 50));
vm.runInContext("verifyTrail()", ctx);
await new Promise((r) => setTimeout(r, 50));
const trailTxt = (els.get("trailres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const trailOk = /TRAIL VERIFIED/.test(trailTxt) && /2 venue/.test(trailTxt) &&
  /ladder legs \+ argmax/.test(trailTxt) && /settlements from Run\.correct/.test(trailTxt);
console.log(`in-page trail-card verifier — committed qwen3b ladder-deadheat card ${trailOk ? "PASS" : "FAIL"}`);
if (!trailOk) fails++;
els.get("trailjson").value = els.get("trailjson").value.replace(/("poolsLamports": )(\d+)/, (m, p, n) => p + (Number(n) + 1));
vm.runInContext("verifyTrail()", ctx);
await new Promise((r) => setTimeout(r, 50));
const trailTamperTxt = (els.get("trailres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const trailTamperOk = /TRAIL FAILED/.test(trailTamperTxt) && /pool accounting/.test(trailTamperTxt);
console.log(`in-page trail-card tamper case — mutated pool ${trailTamperOk ? "rejected PASS" : "MISSED FAIL"}`);
if (!trailTamperOk) fails++;
// universal artifact router: a match card pasted into the drop zone must be
// detected, routed to the match textarea, and verified in place.
els.get("matchjson").value = els.get("matchjson").value.replace('"a": 1,', '"a": 2,');
documentStub.getElementById("artifactjson").value = els.get("matchjson").value;
vm.runInContext("verifyAnyArtifact()", ctx);
await new Promise((r) => setTimeout(r, 50));
const anyTxt = (els.get("matchres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const noteTxt = els.get("artifactnote")?.innerHTML ?? "";
const anyOk = /MATCH VERIFIED/.test(anyTxt) && /detected/.test(noteTxt) && /sealed-match\/v1/.test(noteTxt);
console.log(`in-page universal verifier — match card routed + verified ${anyOk ? "PASS" : "FAIL"}`);
if (!anyOk) fails++;
// in-page report verifier: the qwen2.5-3b report binds to its committed
// claim card by canonical sha256 — rehash byte-for-byte, record PDA
// re-derives. A mutated printed hash must fail.
await vm.runInContext("loadReport()", ctx);
await new Promise((r) => setTimeout(r, 100));
await vm.runInContext("verifyReport()", ctx);
await new Promise((r) => setTimeout(r, 100));
const reportTxt = (els.get("reportres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const reportOk = /REPORT VERIFIED/.test(reportTxt) && /card digest binding/.test(reportTxt) && /record PDA/.test(reportTxt);
console.log(`in-page report verifier — committed qwen2.5-3b report ${reportOk ? "PASS" : "FAIL"}`);
if (!reportOk) fails++;
els.get("reportjson").value = els.get("reportjson").value.replace(/sha256 `([0-9a-f]{64})`/, "sha256 `f00ba5f00ba5f00ba5f00ba5f00ba5f00ba5f00ba5f00ba5f00ba5f00ba5f00b`");
await vm.runInContext("verifyReport()", ctx);
await new Promise((r) => setTimeout(r, 100));
const reportTamperTxt = (els.get("reportres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const reportTamperOk = /REPORT FAILED/.test(reportTamperTxt) && /card digest binding/.test(reportTamperTxt);
console.log(`in-page report tamper case — mutated printed hash ${reportTamperOk ? "rejected PASS" : "MISSED FAIL"}`);
if (!reportTamperOk) fails++;
// the universal router must route a report (non-JSON markdown) too
await vm.runInContext("loadReport()", ctx);
await new Promise((r) => setTimeout(r, 100));
els.get("artifactjson").value = els.get("reportjson").value;
vm.runInContext("verifyAnyArtifact()", ctx);
await new Promise((r) => setTimeout(r, 150));
const anyReportTxt = (els.get("reportres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const anyReportOk = /REPORT VERIFIED/.test(anyReportTxt) && /sealed-report\/v1/.test(els.get("artifactnote")?.innerHTML ?? "");
console.log(`in-page universal verifier — markdown report routed + verified ${anyReportOk ? "PASS" : "FAIL"}`);
if (!anyReportOk) fails++;
// the committed ledger digest — snapshot-hash binding + every ledger row
// field-compared against the decoded accounts; a mutated count must fail.
await vm.runInContext("loadDigest()", ctx);
await new Promise((r) => setTimeout(r, 60));
await vm.runInContext("verifyDigest()", ctx);
await new Promise((r) => setTimeout(r, 60));
const digestTxt = (els.get("digestres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const digestOk = /DIGEST VERIFIED/.test(digestTxt) && /snapshot binding/.test(digestTxt) && /bank ledger/.test(digestTxt) && /record ledger/.test(digestTxt);
console.log(`in-page digest verifier — committed sealed-evidence-digest ${digestOk ? "PASS" : "FAIL"}`);
if (!digestOk) fails++;
els.get("digestjson").value = els.get("digestjson").value.replace(/"runs": (\d+)/, (_m, n) => `"runs": ${Number(n) + 1}`);
await vm.runInContext("verifyDigest()", ctx);
await new Promise((r) => setTimeout(r, 60));
const digestTamperTxt = (els.get("digestres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const digestTamperOk = /DIGEST FAILED/.test(digestTamperTxt) && /counts/.test(digestTamperTxt);
console.log(`in-page digest tamper case — mutated run count ${digestTamperOk ? "rejected PASS" : "MISSED FAIL"}`);
if (!digestTamperOk) fails++;
// the leaderboard card — PDAs, aggregates, pairwise join, Wilson order,
// and the receipt→account binding all replay in-page; a flipped rank must fail.
await vm.runInContext("loadBoard()", ctx);
await new Promise((r) => setTimeout(r, 60));
await vm.runInContext("verifyBoard()", ctx);
await new Promise((r) => setTimeout(r, 150));
const boardTxt = (els.get("boardres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const boardOk = /BOARD VERIFIED/.test(boardTxt) && /record identity/.test(boardTxt) &&
  /pairwise verdicts/.test(boardTxt) && /snapshot binding/.test(boardTxt) && /31 models/.test(boardTxt);
console.log(`in-page board verifier — committed sealed-board card ${boardOk ? "PASS" : "FAIL"}`);
if (!boardOk) console.log(`  boardres: ${boardTxt.slice(0, 900)}`);
if (!boardOk) fails++;
els.get("boardjson").value = els.get("boardjson").value.replace(/"correct": (\d+)/, (_m, n) => `"correct": ${Number(n) + 1}`);
await vm.runInContext("verifyBoard()", ctx);
await new Promise((r) => setTimeout(r, 150));
const boardTamperTxt = (els.get("boardres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const boardTamperOk = /BOARD FAILED/.test(boardTamperTxt);
console.log(`in-page board tamper case — swapped rank rejected ${boardTamperOk ? "PASS" : "MISSED FAIL"}`);
if (!boardTamperOk) fails++;
// the exam card — bank PDA, the items_root fold replayed in landing order
// from decoded chunk bytes, and the full run/receipt/disclosure surface.
await vm.runInContext("loadBank('sealed-gen.json')", ctx);
await new Promise((r) => setTimeout(r, 60));
await vm.runInContext("verifyBank()", ctx);
await new Promise((r) => setTimeout(r, 150));
const bankTxt = (els.get("bankres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const bankOk = /BANK VERIFIED/.test(bankTxt) && /bank PDA/.test(bankTxt) &&
  /items_root fold/.test(bankTxt) && /run surface/.test(bankTxt) && /snapshot binding/.test(bankTxt);
console.log(`in-page bank verifier — committed sealed-bank card ${bankOk ? "PASS" : "FAIL"}`);
if (!bankOk) console.log(`  bankres: ${bankTxt.slice(0, 900)}`);
if (!bankOk) fails++;
// the PRIVATE bank's ciphertext fold replays too — no key needed
await vm.runInContext("loadBank('sealed-priv.json')", ctx);
await new Promise((r) => setTimeout(r, 60));
await vm.runInContext("verifyBank()", ctx);
await new Promise((r) => setTimeout(r, 150));
const bankPrivTxt = (els.get("bankres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const bankPrivOk = /BANK VERIFIED/.test(bankPrivTxt) && /re-folded in landing order/.test(bankPrivTxt);
console.log(`in-page bank verifier — private-bank ciphertext fold ${bankPrivOk ? "PASS" : "FAIL"}`);
if (!bankPrivOk) console.log(`  bankres: ${bankPrivTxt.slice(0, 900)}`);
if (!bankPrivOk) fails++;
// the bettor's card — both position PDAs re-derive (dark adds pos_salt),
// stake + venue fields bind to decoded accounts, the verdict replays.
await vm.runInContext("loadPos('positions/winning-band.json')", ctx);
await new Promise((r) => setTimeout(r, 60));
await vm.runInContext("verifyPosition()", ctx);
await new Promise((r) => setTimeout(r, 150));
const posTxt = (els.get("posres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const posOk = /POSITION VERIFIED/.test(posTxt) && /position PDA/.test(posTxt) &&
  /verdict replay/.test(posTxt) && /payable/.test(posTxt);
console.log(`in-page position verifier — committed payable bettor card ${posOk ? "PASS" : "FAIL"}`);
if (!posOk) console.log(`  posres: ${posTxt.slice(0, 900)}`);
if (!posOk) fails++;
await vm.runInContext("loadPos('positions/sealed-dark.json')", ctx);
await new Promise((r) => setTimeout(r, 60));
await vm.runInContext("verifyPosition()", ctx);
await new Promise((r) => setTimeout(r, 150));
const posDarkTxt = (els.get("posres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const posDarkOk = /POSITION VERIFIED/.test(posDarkTxt) && /pos_salt/.test(posDarkTxt);
console.log(`in-page position verifier — sealed dark card (pos_salt seed) ${posDarkOk ? "PASS" : "FAIL"}`);
if (!posDarkOk) fails++;
// the forgery lab — every canned attack must die at a named check.
for (const k of ["score", "rank", "vouch", "verdict", "phantom", "pool", "counts", "phanrun", "toc", "payout"]) {
  await vm.runInContext(`forge(${JSON.stringify(k)})`, ctx);
  await new Promise((r) => setTimeout(r, 400));
  const r = await vm.runInContext(`__forgeOut[${JSON.stringify(k)}]`, ctx);
  const ok = r?.state === "caught" && typeof r.check === "string" && r.check.length > 0;
  console.log(`forgery lab — ${k}: ${ok ? `caught by "${r.check}" PASS` : `NOT CAUGHT (${r?.state ?? "no state"}) FAIL`}`);
  if (!ok) fails++;
}
// the bundle replay: every committed artifact through its own verifier —
// the in-page mirror of `chain artifact docs/evidence --recursive`.
await vm.runInContext("replayBundle()", ctx);
await new Promise((r) => setTimeout(r, 100));
const bundleTxt = (els.get("bundleres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const bundleOk = /BUNDLE VERIFIED/.test(bundleTxt) && /123\/123 artifacts replayed in-page/.test(bundleTxt) &&
  /sealed-claim\/v1 — 31\/31/.test(bundleTxt) && /sealed-match\/v1 — 73\/73/.test(bundleTxt) &&
  /sealed-evidence-digest\/v1 — 1\/1/.test(bundleTxt) && /sealed-board\/v1 — 1\/1/.test(bundleTxt) &&
  /sealed-bank\/v1 — 3\/3/.test(bundleTxt) && /sealed-catalog\/v1 — 1\/1/.test(bundleTxt) &&
  /sealed-position\/v1 — 2\/2/.test(bundleTxt);
console.log(`in-page bundle replay — 123 committed artifacts through their verifiers ${bundleOk ? "PASS" : "FAIL"}`);
if (!bundleOk) fails++;
// the hero stat: SOL settled by MPC-written scores — must render a real
// lamports total, not a blank cell.
const statM = /<b class="score">([\d.]+)<\/b> SOL settled by MPC/.exec(rendered);
const statOk = !!statM && Number(statM[1]) > 0;
console.log(`hero stat — "SOL settled by MPC, no referee" renders ${statOk ? "PASS" : "FAIL"}`);
if (!statOk) fails++;
// cross-surface agreement: the in-page bundle root must equal the recipe
// `chain fingerprint` computes — sha256(SHA256SUMS) || sha256(MANIFEST).
{
  const sh = (b) => createHash("sha256").update(b).digest("hex");
  const evRoot = sh(readFileSync(join(ROOT, "web", "SHA256SUMS"), "utf8"));
  const webRoot = sh(readFileSync(join(ROOT, "web", "MANIFEST"), "utf8"));
  const want = sh(`sealed-fingerprint/v1\n${evRoot}\n${webRoot}\n`);
  const auditTxt = (els.get("auditres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
  const fpOk = new RegExp(`bundle root\\s+${want}`).test(bundleTxt) &&
    new RegExp(`bundle root\\s+${want}`).test(auditTxt);
  console.log(`in-page bundle fingerprint — root ${want.slice(0, 16)}… ${fpOk ? "PASS" : "FAIL"}`);
  if (!fpOk) fails++;
  // the committed anchor doc (fetched repo-side, served raw) claims the
  // recomputed root — the audit card must render ANCHOR VERIFIED.
  const anchOk = /ANCHOR VERIFIED/.test(auditTxt) && /notarized on Solana devnet/.test(auditTxt);
  console.log(`in-page anchor check — committed devnet memo carries this root ${anchOk ? "PASS" : "FAIL"}`);
  if (!anchOk) fails++;
  // the ?root= link claim — the URL carries the asserted bundle root and
  // the page re-checks it on load. Re-run the audit under a matching link
  // (VERIFIED) and a forged one (FAILED).
  ctx.location.search = `?root=${want}`;
  await vm.runInContext("runAudit(true)", ctx);
  await new Promise((r) => setTimeout(r, 400));
  const okTxt = (els.get("auditres")?.innerHTML ?? "");
  const linkOk = /LINK CLAIM VERIFIED/.test(okTxt) && !/LINK CLAIM FAILED/.test(okTxt);
  ctx.location.search = `?root=${"0".repeat(64)}`;
  await vm.runInContext("runAudit(true)", ctx);
  await new Promise((r) => setTimeout(r, 400));
  const badTxt = (els.get("auditres")?.innerHTML ?? "");
  const linkBad = /LINK CLAIM FAILED/.test(badTxt) && !/LINK CLAIM VERIFIED/.test(badTxt);
  ctx.location.search = "?snapshot=bundled";
  await vm.runInContext("runAudit(true)", ctx);
  console.log(`in-page link claims — ?root= match ${linkOk ? "VERIFIED" : "MISSED"} · forged root ${linkBad ? "rejected" : "MISSED"} ${linkOk && linkBad ? "PASS" : "FAIL"}`);
  if (!(linkOk && linkBad)) fails++;
}
// the ?card= deep link — every committed artifact is a shareable URL:
// fetch, route through the universal verifier, land on the verdict.
{
  ctx.location.search = "?card=banks/sealed-gen.json";
  await vm.runInContext("maybeAudit.__proto__ ? 0 : 0; window.__auditKey=''; maybeAudit()", ctx);
  await new Promise((r) => setTimeout(r, 400));
  const noteTxt = els.get("artifactnote")?.innerHTML ?? "";
  const bankTxt = (els.get("bankres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
  const cardOk = /sealed-bank\/v1/.test(noteTxt) && /BANK VERIFIED/.test(bankTxt);
  console.log(`in-page ?card= deep link — artifact fetched, routed, verified ${cardOk ? "PASS" : "FAIL"}`);
  if (!cardOk) fails++;
  ctx.location.search = "?snapshot=bundled";
}
// the evidence catalog — all 120 artifacts listed as ?card= links, plus the
// index's own self-verifying link (121 total).
{
  const catTxt = (els.get("catalog")?.innerHTML ?? "");
  const catLinks = (catTxt.match(/\?card=/g) || []).length;
  const catOk = /122 artifacts/.test(catTxt) && catLinks === 123 && /sealed-position\/v1/.test(catTxt);
  console.log(`in-page evidence catalog — ${catLinks} ?card= links across 8 kinds ${catOk ? "PASS" : "FAIL"}`);
  if (!catOk) fails++;
}
// the 60-second judge path — the three hero buttons must actually work:
// board verify, a caught forgery, and the bundle replay (pinned separately).
{
  await vm.runInContext("quickVerify()", ctx);
  await new Promise((r) => setTimeout(r, 400));
  const boardTxt = (els.get("boardres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
  await vm.runInContext("quickForge()", ctx);
  await new Promise((r) => setTimeout(r, 400));
  const fq = await vm.runInContext("__forgeOut['score']", ctx);
  const quickOk = /BOARD VERIFIED/.test(boardTxt) && fq?.state === "caught";
  console.log(`in-page judge quick path — board verifies, forgery caught ${quickOk ? "PASS" : "FAIL"}`);
  if (!quickOk) fails++;
}
// the catalog verifies ITSELF — sealed-catalog/v1 replayed in-page against the
// per-dir indexes + SHA256SUMS (completeness, kind honesty, hash pinning).
{
  els.get("catalogjson").value = readFileSync(join(ROOT, "web", "artifacts.json"), "utf8");
  await vm.runInContext("verifyCatalog()", ctx);
  const cv = (els.get("catres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
  const cvOk = /CATALOG VERIFIED/.test(cv) && /122 listed \/ 122 found/.test(cv) && /122\/122 paths pinned/.test(cv);
  console.log(`in-page catalog verifier — the index proves itself ${cvOk ? "PASS" : "FAIL — " + cv.slice(0, 300)}`);
  if (!cvOk) fails++;
}
// the ?forge= deep link — a URL that runs the attack itself.
{
  ctx.location.search = "?forge=phanrun";
  await vm.runInContext("window.__auditKey=''; maybeAudit()", ctx);
  await new Promise((r) => setTimeout(r, 500));
  const fr = await vm.runInContext("__forgeOut['phanrun']", ctx);
  const forgeLinkOk = fr?.state === "caught" && /run surface/.test(fr.check ?? "");
  console.log(`in-page ?forge= deep link — attack ran and died at a named check ${forgeLinkOk ? "PASS" : "FAIL"}`);
  if (!forgeLinkOk) fails++;
  ctx.location.search = "?snapshot=bundled";
}
// guided tour — the bar opens on the first stop with its caption, and
// next() advances through the section walk.
vm.runInContext("startTour()", ctx);
const tourCap = els.get("tourcap")?.innerHTML ?? "";
const tourShown = els.get("tourbar")?.style?.display === "block";
vm.runInContext("tourNext()", ctx);
const tourStep2 = els.get("tourstep")?.textContent ?? "";
vm.runInContext("tourEnd()", ctx);
const tourOk = tourShown && /paired evidence/.test(tourCap) && /2\/20/.test(tourStep2) &&
  els.get("tourbar")?.style?.display === "none";
console.log(`in-page guided tour — caption + advance + dismiss ${tourOk ? "PASS" : "FAIL"}`);
if (!tourOk) fails++;
// policy sweep — the frontier grid renders all records; test/sweep-run's
// perfect record must survive the strictest line.
vm.runInContext("runSweep()", ctx);
const sweepTxt = (els.get("sweepOut")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const sweepRows = (els.get("sweepOut")?.innerHTML.match(/<tr>/g) || []).length - 1;
const sweepOk = sweepRows === 31 && /test\/sweep-run[\s\S]{0,80}≥90%/.test(sweepTxt) &&
  /never passes/.test(sweepTxt) && /≥80%/.test(sweepTxt);
console.log(`in-page policy sweep — ${sweepRows} model rows, frontiers ${sweepOk ? "PASS" : "FAIL"}`);
if (!sweepOk) fails++;

// policy autopsy — the --why envelope renders per-scope ceilings
vm.runInContext("runWhy()", ctx);
const whyTxt = (els.get("whyOut")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const whyOk = /policy envelope/.test(whyTxt) && /all receipts/.test(whyTxt) &&
  /vouched-only/.test(whyTxt) && /pre-reveal only/.test(whyTxt) &&
  /passes any minPct|nothing/.test(whyTxt) && /binding:/.test(whyTxt);
console.log(`in-page policy autopsy — envelope + binding constraint ${whyOk ? "PASS" : "FAIL"}`);
if (!whyOk) fails++;
// skeptic's checklist — all twelve findings render with honest severities:
// the disclosed post-reveal runs + collapsible records are the two warns,
// dead money stays zero.
vm.runInContext("renderAnomalies()", ctx);
const anomTxt = (els.get("anomres")?.innerHTML ?? "").replace(/<[^>]+>/g, " ");
const anomOk = /2 warn/.test(anomTxt) && /post-reveal evidence/.test(anomTxt) &&
  /collapse under --no-post-reveal/.test(anomTxt) && /test\/post-reveal/.test(anomTxt) &&
  /dead money/.test(anomTxt) && /duplicate bank names/.test(anomTxt) &&
  /clean/.test(anomTxt);
console.log(`in-page skeptic's checklist — 12 findings, severities ${anomOk ? "PASS" : "FAIL"}`);
if (!anomOk) fails++;
// bundle diff — the same file must read identical; one account dropped
// must count as a removal in its type row.
ctx.__snapText = snapText;
await vm.runInContext('diffSnapshot({ name: "self.json", text: async () => __snapText })', ctx);
await new Promise((r) => setTimeout(r, 50));
const diffSelf = els.get("diffres")?.innerHTML ?? "";
const diffOk1 = /identical — every account byte-for-byte the same/.test(diffSelf);
const smaller = JSON.parse(snapText); smaller.sealed = smaller.sealed.slice(1);
ctx.__smallerText = JSON.stringify(smaller);
await vm.runInContext('diffSnapshot({ name: "smaller.json", text: async () => __smallerText })', ctx);
await new Promise((r) => setTimeout(r, 50));
const diffMut = els.get("diffres")?.innerHTML ?? "";
const diffOk2 = /−1<\/td>/.test(diffMut) && /removed/.test(diffMut);
console.log(`in-page bundle diff — self-diff ${diffOk1 ? "identical" : "FAIL"}, removal case ${diffOk2 ? "counts −1 PASS" : "MISSED FAIL"}`);
if (!diffOk1 || !diffOk2) fails++;
// activity feed — filterable stream renders events; a type filter must
// narrow the count (resolutions alone < all events).
const feedAll = (els.get("feedrows")?.innerHTML.match(/<div class="proof">/g) || []).length;
els.get("feedType").value = "resolution";
vm.runInContext("runFeedFilter()", ctx);
const feedHtml = els.get("feedrows")?.innerHTML ?? "";
const feedRes = (feedHtml.match(/>resolution<\/span>/g) || []).length;
const feedOther = (feedHtml.match(/>(bank|run|score|receipt|reveal|grant|venue)<\/span>/g) || []).length;
const feedOk = feedAll === 40 && feedRes > 0 && feedOther === 0 && /matches/.test(feedHtml);
els.get("feedType").value = "";
vm.runInContext("runFeedFilter()", ctx);
console.log(`in-page activity feed — ${feedAll} events shown, resolution filter ${feedOk ? "narrows PASS" : "FAIL"}`);
if (!feedOk) fails++;
// runs substrate — the `chain runs` index renders + every filter narrows
// honestly (post-reveal isolates a strict subset, attested a strict subset).
const runsRows = els.get("runsrows")?.innerHTML ?? "";
const runsAll = Number((runsRows.match(/(\d+) run\(s\) match/) ?? [])[1]);
els.get("runsPR").value = "1";
vm.runInContext("runRunsFilter()", ctx);
const prHtml = els.get("runsrows")?.innerHTML ?? "";
const prN = Number((prHtml.match(/(\d+) run\(s\) match/) ?? [])[1]);
const prPills = (prHtml.match(/>post-reveal<\/span>/g) || []).length;
els.get("runsPR").value = "";
els.get("runsAttested").checked = true;
vm.runInContext("runRunsFilter()", ctx);
const attHtml = els.get("runsrows")?.innerHTML ?? "";
const attN = Number((attHtml.match(/(\d+) run\(s\) match/) ?? [])[1]);
const attPills = (attHtml.match(/>attested<\/span>/g) || []).length;
els.get("runsAttested").checked = false;
vm.runInContext("runRunsFilter()", ctx);
const runsOk = runsAll === 503 && prN > 0 && prN < runsAll && prPills >= prN &&
  attN > 0 && attN < runsAll && attPills >= attN;
console.log(`in-page runs index — ${runsAll} runs, post-reveal filter ${prN} rows, attested filter ${attN} rows ${runsOk ? "PASS" : "FAIL"}`);
if (!runsOk) fails++;
// disclosure trail — the `chain grants` surface renders grants + counts;
// the viewer filter isolates exactly one pubkey's disclosures.
const grantsHtml = els.get("grantsrows")?.innerHTML ?? "";
const grantsAll = Number((grantsHtml.match(/(\d+) grant\(s\) match/) ?? [])[1]);
const grantLinks = (grantsHtml.match(/<td class="mono"><a href="\?pk=/g) || []).length;
const oneViewer = (grantsHtml.match(/<a href="\?pk=([1-9A-HJ-NP-Za-km-z]+)">[1-9A-HJ-NP-Za-km-z…]+<\/a><\/td><td class="kv">/) ?? [])[1];
els.get("grantsViewer").value = oneViewer || "";
vm.runInContext("runGrantsFilter()", ctx);
const vfHtml = els.get("grantsrows")?.innerHTML ?? "";
const vfN = Number((vfHtml.match(/(\d+) grant\(s\) match/) ?? [])[1]);
els.get("grantsViewer").value = "";
vm.runInContext("runGrantsFilter()", ctx);
const grantsSec = /disclosure trail — who can see the questions/.test(rendered) &&
  grantsAll === 145 && grantLinks >= 55 && !!oneViewer && vfN > 0 && vfN < grantsAll;
console.log(`in-page disclosure trail — ${grantsAll} grants, viewer filter ${vfN} rows ${grantsSec ? "PASS" : "FAIL"}`);
if (!grantsSec) fails++;
// tournament grid — top-12 table renders with signed cells + dead-heat zeros
vm.runInContext("runH2HGrid(true)", ctx);
const gridHtml = els.get("h2hGridOut")?.innerHTML ?? "";
const gridRows = (gridHtml.match(/<tr>/g) || []).length - 1;
const gridOk = gridRows === 12 && /qwen2\.5-3b-instruct/.test(gridHtml) &&
  (gridHtml.match(/>\+\d+<\/td>/) ?? []).length > 0 && /—/.test(gridHtml);
console.log(`in-page tournament grid — ${gridRows}×12 cells, signed deltas ${gridOk ? "PASS" : "FAIL"}`);
if (!gridOk) fails++;
console.log(`\n${fails === 0 ? "ALL GREEN" : fails + " FAILURES"} (render ok: ${rendered.length} chars)`);
process.exit(fails === 0 ? 0 : 1);
