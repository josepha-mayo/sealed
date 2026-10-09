#!/usr/bin/env node
// Render the in-page copyable verdict as docs/verified.svg — the shareable
// "EVERYTHING VERIFIED" card. Input is the REAL verdict text dumped by
// audit-browser-test (SEALED_DUMP_VERDICT), so the card can only ever show
// output that was actually recomputed — never a mock-up.
//
//   SEALED_DUMP_VERDICT=/tmp/verdict.txt node scripts/audit-browser-test.mjs
//   node scripts/gen-verified-svg.mjs /tmp/verdict.txt docs/verified.svg
//
import { readFileSync, writeFileSync } from "node:fs";

const [inFile = "/tmp/verdict.txt", outFile = "docs/verified.svg"] = process.argv.slice(2);
const lines = readFileSync(inFile, "utf8").trimEnd().split("\n");
if (!lines[0]?.includes("SEALED — evidence verdict")) {
  console.error("input does not look like the in-page verdict — run the audit with SEALED_DUMP_VERDICT first");
  process.exit(1);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const W = 800, PAD = 28, LH = 26, TOP = 96;
const H = TOP + lines.length * LH + 70;
const MAXV = 80; // ~13px monospace chars that fit between the key column and card edge
const trunc = (s) => {
  // collapse long opaque tokens (sigs, roots) to head…tail so checkable
  // suffixes like "· slot N" stay visible, then cap the line if needed.
  s = s.replace(/\b([1-9A-HJ-NP-Za-km-z0-9]{40,})\b/g, (m) => m.slice(0, 16) + "…" + m.slice(-8));
  return s.length > MAXV ? s.slice(0, MAXV - 1) + "…" : s;
};
const rows = lines.map((l, i) => {
  const y = TOP + i * LH;
  const [key, ...rest] = l.split(/ {2,}/);
  const val = rest.join("  ");
  return i === 0
    ? `<text x="${PAD}" y="${y}" class="hdr">${esc(l)}</text>`
    : `<text x="${PAD}" y="${y}" class="k">${esc(key)}</text><text x="${PAD + 118}" y="${y}" class="v">${esc(trunc(val))}</text>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="9" fill="none" stroke="#30363d"/>
<circle cx="24" cy="24" r="5" fill="#ff5f56"/><circle cx="44" cy="24" r="5" fill="#ffbd2e"/><circle cx="64" cy="24" r="5" fill="#27c93f"/>
<text x="${W - PAD}" y="29" text-anchor="end" class="url">josepha-mayo.github.io/sealed/?mega=1 — click the README image to re-run this live</text>
<rect x="${PAD}" y="44" width="${W - PAD * 2}" height="1" fill="#30363d"/>
<rect x="${PAD}" y="56" width="226" height="26" rx="13" fill="#12351f" stroke="#27c93f" stroke-width="1"/>
<text x="${PAD + 113}" y="74" text-anchor="middle" class="pill">EVERYTHING VERIFIED</text>
${rows}
<text x="${PAD}" y="${H - 24}" class="foot">rendered from the actual in-page audit output — scripts/gen-verified-svg.mjs</text>
<style>
.hdr{fill:#e6edf3;font-size:14px;font-weight:700}
.k{fill:#8b949e;font-size:13px}
.v{fill:#c9d1d9;font-size:13px}
.pill{fill:#27c93f;font-size:13px;font-weight:700}
.url{fill:#58a6ff;font-size:11px}
.foot{fill:#484f58;font-size:10px}
</style>
</svg>
`;
writeFileSync(outFile, svg);
console.log(`${outFile} — ${W}x${H}, ${lines.length} verdict lines`);
