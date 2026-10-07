#!/usr/bin/env node
// Emits web/standalone.html — the WHOLE explorer + evidence bundle as one
// self-contained file: every MANIFEST-pinned asset (snapshot, all 123
// artifacts, manifests, vendored crypto deps) inlined into window.__FILES,
// with a fetch() override so the page's own verifiers — audit, recursive
// bundle replay, forgery lab, card verifiers — run identically offline.
// The devnet anchor doc is inlined under its canonical URL key.
//
//   node scripts/gen-standalone.mjs          # write web/standalone.html
//   node scripts/gen-standalone.mjs --check  # exit 1 if the committed file is stale
//
// standalone.html is deliberately EXCLUDED from web/MANIFEST (pinning a
// file that embeds the manifest would be circular); its integrity derives
// from the pinned bytes inside it — the page re-hashes the embedded
// index.html/snapshot/artifacts against MANIFEST on every audit.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = resolve(repo, "web");

const checkMode = process.argv.includes("--check");

const man = readFileSync(resolve(WEB, "MANIFEST"), "utf8")
  .trim().split("\n").map((l) => l.slice(l.indexOf("  ") + 2).replace(/^\.\//, ""));

const files = {};
for (const rel of man) {
  files[rel] = readFileSync(resolve(WEB, rel), "utf8");
}
// MANIFEST isn't pinned inside itself — embed it explicitly so the
// in-page integrity re-hash resolves offline too.
files["MANIFEST"] = readFileSync(resolve(WEB, "MANIFEST"), "utf8");
// the anchor doc lives outside the manifests by design (it timestamps the
// root) — inline it under the canonical URL the page fetches.
const anchorPath = resolve(repo, "docs/evidence-anchor.json");
if (existsSync(anchorPath)) {
  files["https://raw.githubusercontent.com/josepha-mayo/sealed/main/docs/evidence-anchor.json"] =
    readFileSync(anchorPath, "utf8");
}

let html = files["index.html"];

// 1. inline the vendored web3 iife bundle
const web3 = readFileSync(resolve(WEB, "vendor/web3.iife.min.js"), "utf8");
if (web3.includes("</script")) throw new Error("web3 bundle contains </script — must escape before inlining");
html = html.replace(
  '<script src="vendor/web3.iife.min.js"></script>',
  () => `<script>\n/* vendored @solana/web3.js@1.95.8 — inlined by gen-standalone.mjs */\n${web3}\n</script>`);

// 2. dynamic imports → data: URLs (offline-safe module loading)
for (const [from, mod] of [
  ['./vendor/noble-ed25519.mjs', 'vendor/noble-ed25519.mjs'],
  ['./vendor/rescue.bundle.mjs', 'vendor/rescue.bundle.mjs'],
]) {
  const src = readFileSync(resolve(WEB, mod), "utf8");
  const dataUrl = `data:text/javascript;base64,${Buffer.from(src, "utf8").toString("base64")}`;
  html = html.replaceAll(`import("${from}")`, `import("${dataUrl}")`);
}

// 3. fetch override + the file map, injected before </head>
const shim = `<script>
/* standalone capsule — every fetch resolves from the embedded file map.
   The page's verifiers run identically; nothing touches the network. */
window.__FILES = ${JSON.stringify(files).replace(/<\//g, "<\\/")};
(() => { const __f = window.fetch?.bind(window);
  window.fetch = (u, o) => { const k = String(u);
    if (k in window.__FILES) return Promise.resolve(new Response(window.__FILES[k], { status: 200 }));
    return __f ? __f(u, o) : Promise.reject(new Error("offline capsule: no " + k)); }; })();
</script>
</head>`;
if (!html.includes("</head>")) throw new Error("index.html has no </head>");
html = html.replace("</head>", () => shim);

const out = resolve(WEB, "standalone.html");
if (checkMode) {
  const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (cur === html) { console.log("standalone.html — in sync"); process.exit(0); }
  console.error("standalone.html — STALE (run scripts/gen-standalone.mjs)");
  process.exit(1);
}
writeFileSync(out, html);
console.log(`standalone.html regenerated: ${(html.length / 1e6).toFixed(1)}MB, ${man.length} embedded files`);
