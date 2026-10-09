#!/usr/bin/env node
// Pre-flight check for docs/submission-fields.md: every field present,
// every body under the per-field character budget, no stray TODO markers
// outside the intentional teamBackground template. Also scans the tracked
// tree for private-bank plaintext leaks (items carrying prompt+answer) —
// only the intentional public calibration specimen is exempt.
// Usage: node scripts/check-submission.mjs   (exit 1 on any violation)
import { readFileSync } from "fs";
import { execSync } from "child_process";

const LIMIT = 1200;
const REQUIRED = [
  "shortDescription",
  "problemStatement",
  "technicalApproach",
  "solanaIntegration",
  "tractionMilestones",
  "targetAudience",
  "businessModel",
  "competitiveLandscape",
  "futureVision",
  "teamBackground",
  "demoVideo",
];

const txt = readFileSync(new URL("../docs/submission-fields.md", import.meta.url), "utf8");
const parts = txt.split(/^## /m).slice(1);
const found = new Map();
for (const p of parts) {
  const head = p.split("\n")[0];
  const name = head.split(" (")[0].split(" /")[0].trim();
  found.set(name, p.split("\n").slice(1).join("\n").trim());
}

let fail = 0;
for (const name of REQUIRED) {
  const body = found.get(name);
  if (body === undefined) {
    console.log(`MISSING  ${name}`);
    fail = 1;
    continue;
  }
  const over = body.length > LIMIT;
  if (over) fail = 1;
  console.log(`${over ? "OVER   " : "ok     "} ${name.padEnd(24)} ${body.length} chars`);
}
let warn = 0;
for (const [name, body] of found) {
  if (/\bTODO\b|\[FILL|<fill/i.test(body)) {
    console.log(`PLACEHOLDER left in ${name}`);
    fail = 1;
  }
}
// teamBackground is the one intentional template — bracketed [Name]/[role]
// markers mean "not yet filled": warn loudly so it can't ship silently.
const tb = found.get("teamBackground") ?? "";
if (/\[[A-Z][^\]]*\]/.test(tb)) {
  console.log(`WARN     teamBackground        still a template — replace [bracketed] markers before submitting`);
  warn = 1;
}
// ── plaintext leak scan ────────────────────────────────────────────────
// Private/authored bank files store items as {prompt, answer, salt, ...} in
// PLAINTEXT — they live under gitignored bank/ and must never be tracked.
// The calibration specimen is public ON PURPOSE (its whole point is that
// judges can recompute the MPC score), so its two copies are allowlisted.
const PLAINTEXT_ALLOW = new Set([
  "docs/evidence/calibration/bank.json",
  "web/calibration/bank.json",
]);
const tracked = execSync("git ls-files", {
  cwd: new URL("..", import.meta.url).pathname,
  encoding: "utf8",
}).split("\n").filter(Boolean);
let leaks = 0;
// recursive object walk — a leaked bank could nest items under any key or
// shape ({bank:{items}}, {exam:{questions}}, a bare array, ...). Any object
// carrying BOTH prompt+answer strings is the plaintext an MPC exam exists
// to keep off the public record.
function* walk(x) {
  if (x && typeof x === "object") {
    yield x;
    for (const v of Object.values(x)) yield* walk(v);
  }
}
const leaksItems = (x) => Array.isArray(x) &&
  x.some((it) => typeof it?.prompt === "string" && typeof it?.answer === "string");
for (const f of tracked) {
  if (!f.endsWith(".json") || PLAINTEXT_ALLOW.has(f)) continue;
  let doc;
  try { doc = JSON.parse(readFileSync(new URL("../" + f, import.meta.url), "utf8")); }
  catch { continue; }
  for (const o of walk(doc)) {
    if (leaksItems(o)) {
      console.log(`LEAK     ${f} — tracked JSON carries plaintext prompt+answer items (private bank material)`);
      leaks++;
      fail = 1;
      break;
    }
  }
}
console.log(`${leaks ? "FAIL   " : "ok     "} plaintext leak scan    ${tracked.length} tracked files, ${leaks} leaks`);

if (warn) console.log("\n(pre-flight passed but the submission is NOT ready — warnings above)");
process.exit(fail);
