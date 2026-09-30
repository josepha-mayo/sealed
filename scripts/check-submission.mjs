#!/usr/bin/env node
// Pre-flight check for docs/submission-fields.md: every field present,
// every body under the per-field character budget, no stray TODO markers
// outside the intentional teamBackground template.
// Usage: node scripts/check-submission.mjs   (exit 1 on any violation)
import { readFileSync } from "fs";

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
for (const [name, body] of found) {
  if (name !== "teamBackground" && /\bTODO\b|\[FILL|<fill/i.test(body)) {
    console.log(`PLACEHOLDER left in ${name}`);
    fail = 1;
  }
}
process.exit(fail);
