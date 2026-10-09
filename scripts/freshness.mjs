#!/usr/bin/env node
// Doc-count freshness: every "503 runs"-style claim in the docs is a
// liability the moment the evidence bundle moves. This script replays
// the offline audit's own count line, then fails if any doc contradicts
// it. Runs offline; wired into verify-all.sh.
//
// Source of truth: scripts/verify.mjs stdout (it decodes the committed
// snapshot discriminators). Anchored phrases only — "64/64"-style scores
// are never matched.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const out = execFileSync(process.execPath, ["scripts/verify.mjs"], { encoding: "utf8" });

const grab = (re) => {
  const m = out.match(re);
  if (!m) throw new Error(`verify.mjs output missing ${re}`);
  return Number(m[1]);
};

// "account decode — 120 banks, 503 runs, ... 31 model records, 292 score logs"
const truth = {
  banks: grab(/(\d+) banks/),
  runs: grab(/(\d+) runs/),
  grants: grab(/(\d+) grants/),
  reveals: grab(/(\d+) reveals/),
  bandDuel: grab(/(\d+) markets/),          // score-band + duel venues
  ladders: grab(/(\d+) ladders(?=,)/),      // total ladder accounts
  darks: grab(/(\d+) dark markets/),
  bounties: grab(/(\d+) bounties/),
  records: grab(/(\d+) model records/),
  scoreLogs: grab(/(\d+) score logs/),
  // resolved-side counts from the per-primitive checks
  resBandDuel: grab(/purity — (\d+) resolved markets/),
  resLadders: grab(/argmax masks — (\d+) ladders/),
  resDarks: grab(/accounting — (\d+) resolved darks/),
  resBounties: grab(/claims — (\d+) claimed bounties/),
};
truth.venues = truth.bandDuel + truth.ladders + truth.darks + truth.bounties;
truth.resolutions = truth.resBandDuel + truth.resLadders + truth.resDarks + truth.resBounties;

// test-suite counts, derived from the files themselves — a doc claiming
// "N/N unit" or "N/N mocha|E2E" goes stale the moment a test lands
const countTests = (f) => (readFileSync(f, "utf8").match(/^\s*(?:it|test)\(/gm) || []).length;
truth.unit = countTests("packages/harness/test/harness.test.ts");
truth.e2e = countTests("tests/sealed.ts");

// page/bundle-derived constants — a doc quoting the tour length, the forge
// lab's attack count, the tamper-exhibit count, or the pinned-file total
// goes stale the moment index.html or docs/evidence moves. Count them from
// the sources, never a hardcoded number.
const page = readFileSync("web/index.html", "utf8");
const stopsBlock = page.match(/const TOUR_STOPS = \[([\s\S]*?)\];/)?.[1] ?? "";
truth.tourStops = (stopsBlock.match(/^\s*\["/gm) || []).length;
const forgeBlock = page.match(/const FORGE_DEFS = \{([\s\S]*?)\n\};/)?.[1] ?? "";
truth.forgeAttacks = (forgeBlock.match(/^\s{2}\w+:/gm) || []).length;
truth.exhibits = readdirSync("docs/evidence/tamper").filter((f) => f !== "index.json").length;
truth.pinned = readFileSync("docs/evidence/SHA256SUMS", "utf8").trim().split("\n").length
  + readFileSync("web/MANIFEST", "utf8").trim().split("\n").length;
truth.catalog = JSON.parse(readFileSync("docs/evidence/artifacts.json", "utf8")).count;
truth.artifacts = truth.catalog + 1; // replayed total = listed artifacts + the catalog itself
if (!truth.tourStops || !truth.forgeAttacks || !truth.exhibits || !truth.pinned || !truth.catalog)
  throw new Error("freshness: a derived constant came back empty — page structure drifted");

// Anchored claims. Each: [regex, expected]. Only numbers written in these
// exact phrasings are checked — everything else is ignored on purpose.
const claims = [
  [/(\d+)\s+banks/g, truth.banks],
  [/(\d+)\s+runs\b/g, truth.runs],
  [/(\d+)\s+(?:venues|markets)\s+(?:across|posted|over)/g, truth.venues],
  [/(\d+)\s+band\/duel/g, truth.bandDuel],
  [/(\d+)\s+ladders?\b/g, truth.ladders],
  [/(\d+)\s+dark\b/g, truth.darks],
  [/(\d+)\s+bount(?:y|ies)\b/g, truth.bounties],
  [/(\d+)\s+(?:persistent\s+)?model(?:\s|-)capability\s+records|(\d+)\s+model\s+records|(\d+)\s+records\b/g, truth.records],
  [/(\d+)\s+score\s+(?:log|receipt)|(\d+)\s+ScoreLog\s+receipts|(\d+)\s+receipts\b/g, truth.scoreLogs],
  [/(\d+)\s+grants\b/g, truth.grants],
  [/(\d+)\s+reveals?\b/g, truth.reveals],
  [/(\d+)\s+resolutions/g, truth.resolutions],
  // artifact replay total (catalog entries + the catalog itself):
  // "all 142 artifacts", "All 142 artifact cards", "142 replayed",
  // "142 committed artifacts" — matched case-insensitively.
  [/all\s+(\d+)\s+(?:committed\s+)?artifact(?:\s+card)?s?\b|(\d+)\s+committed\s+artifacts?\b|(\d+)\s+artifacts?\s+replayed\b|(\d+)\s+replayed\b/gi, truth.artifacts],
  // the catalog's own line: "141 artifact(s)" — excludes itself
  [/(\d+)\s+artifact\(s\)\b/g, truth.catalog],
  // tamper exhibits: "15 tamper exhibits", "15× sealed-tamper/v1"
  [/(\d+)\s+(?:committed\s+)?(?:tamper\s+)?exhibits?\b|(\d+)×\s+sealed-tamper/gi, truth.exhibits],
  // pinned bytes: "359 manifest-pinned files", "all 359 pinned bytes",
  // "359/359 file(s)"
  [/(\d+)\s+(?:manifest-)?pinned\s+(?:files?|bytes)\b|all\s+(\d+)\s+pinned\s+bytes\b|(\d+)\/\3\s+file/gi, truth.pinned],
  // forgery lab: "13 canned forgeries", "13/13 attacks died",
  // "all thirteen attacks", "12 forgery attacks"
  [/(\d+)\s+canned\s+forgeries|forgeries\s+(\d+)\/\4|(\d+)\s+forgery\s+attacks?\b|(\d+)\/(\d+)\s+attacks?\b/gi, truth.forgeAttacks],
  // spelled-out or numeric guided-tour stop count ("twenty-five captioned
  // stops" in the hero; "all twenty-five stops" in judges.md)
  [/(twenty-\w+|thirty-\w+|eleven|twelve|thirteen|fourteen|fifteen|\d+)\s+(?:captioned\s+)?stops\b/gi, truth.tourStops],
  // test-suite tallies: "67/67 unit", "46/46 unit tests", "17/17 mocha",
  // "unit-tested N/N" — N must equal itself AND the counted suite size
  [/(\d+)\/\1\s+(?:harness\s+)?(?:unit|suite)\b/g, truth.unit],
  [/(\d+)\/\1\s+(?:mocha|E2E)\b/g, truth.e2e],
];

const WORDS = {
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  "twenty-one": 21, "twenty-two": 22, "twenty-three": 23, "twenty-four": 24,
  "twenty-five": 25, "twenty-six": 26, "twenty-seven": 27, "twenty-eight": 28,
  "twenty-nine": 29, thirty: 30, "thirty-one": 31, "thirty-two": 32,
};
const files = ["README.md", ...readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
let bad = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const [re, expected] of claims) {
    for (const m of text.matchAll(re)) {
      const raw = m[1] ?? m[2] ?? m[3];
      const n = raw != null && WORDS[raw.toLowerCase()] != null ? WORDS[raw.toLowerCase()] : Number(raw);
      if (Number.isFinite(n) && n !== expected) {
        console.log(`DRIFT ${f}: "${m[0]}" — doc claims ${n}, evidence bundle has ${expected}`);
        bad++;
      }
    }
  }
}
if (bad) { console.log(`\n${bad} stale count(s) — evidence moved, docs didn't.`); process.exit(1); }
console.log(`FRESH — ${files.length} docs vs bundle: ${truth.banks} banks, ${truth.runs} runs, ${truth.venues} venues, ${truth.records} records/${truth.scoreLogs} receipts, ${truth.resolutions} resolutions`);
