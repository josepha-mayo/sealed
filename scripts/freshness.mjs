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
  // bundle-wide totals: "138 committed artifacts" / "replay all 138
  // artifacts" / "351 manifest-pinned files" — the catalog's own
  // "137 artifact(s)" count uses the artifact\(s\) phrasing and is
  // intentionally NOT matched (it excludes the catalog itself).
  [/all\s+(\d+)\s+(?:committed\s+)?artifacts?\b|(\d+)\s+committed\s+artifacts?\b/g, 142],
  [/(\d+)\s+(?:manifest-)?pinned\s+files?\b/g, 359],
  // spelled-out guided-tour stop count ("twenty-four captioned stops"
  // in the hero; "all twenty-four stops" in judges.md)
  [/(twenty-\w+|thirty-\w+|\d+)\s+stops\b/g, 24],
  // test-suite tallies: "67/67 unit", "46/46 unit tests", "17/17 mocha",
  // "unit-tested N/N" — N must equal itself AND the counted suite size
  [/(\d+)\/\1\s+(?:harness\s+)?(?:unit|suite)\b/g, truth.unit],
  [/(\d+)\/\1\s+(?:mocha|E2E)\b/g, truth.e2e],
];

const WORDS = {
  "twenty-one": 21, "twenty-two": 22, "twenty-three": 23, "twenty-four": 24,
  "twenty-five": 25, "twenty-six": 26, "twenty-seven": 27, "twenty-eight": 28,
  "twenty-nine": 29,
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
