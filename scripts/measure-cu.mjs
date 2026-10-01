#!/usr/bin/env node
// Measure real compute-unit costs for every instruction by walking each
// program's transaction history and reading meta.computeUnitsConsumed.
// Prints a per-instruction table (min/median/max/count) for docs/costs.md.
// REQUIRES a history-indexing RPC — devnet/mainnet/full validators work;
// solana-test-validator prunes tx history (returns no signatures).
// Usage: node scripts/measure-cu.mjs [rpc] [--limit N]
import { Connection, PublicKey } from "@solana/web3.js";

const rpc = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:8899";
const limit = (() => { const i = process.argv.indexOf("--limit"); return i > 0 ? Number(process.argv[i + 1]) : 300; })();
const conn = new Connection(rpc, "confirmed");

const PROGRAMS = {
  sealed: new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ"),
  market: new PublicKey("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN"),
};

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Public devnet RPC 429s getTransaction under any real pace — retry with
// jittered backoff and honor retry-after when the node tells us.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getTx(sig) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (e) {
      const m = String(e?.message ?? e);
      if (!/429|rate|Too Many|fetch failed|timeout/i.test(m) || attempt === 7) throw e;
      const retry = Number(m.match(/retry[^\d]*(\d+)/i)?.[1] ?? 0);
      await sleep((retry || 2 ** attempt) * 1000 + Math.random() * 500);
    }
  }
}
async function getSigs(pid) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await conn.getSignaturesForAddress(pid, { limit });
    } catch (e) {
      if (attempt === 7) throw e;
      await sleep(2 ** attempt * 1000 + Math.random() * 500);
    }
  }
}

for (const [name, pid] of Object.entries(PROGRAMS)) {
  const sigs = await getSigs(pid);
  const rows = new Map(); // ix name -> {cus: [], fails: 0}
  let scanned = 0, failed = 0;
  for (const s of sigs) {
    const tx = await getTx(s.signature).catch(() => null);
    await sleep(120); // stay under public-RPC per-method budgets
    if (!tx) continue;
    scanned++;
    const logs = tx.meta?.logMessages ?? [];
    const cu = tx.meta?.computeUnitsConsumed ?? null;
    if (tx.meta?.err) { failed++; continue; }
    // Anchor logs "Program <pid> invoke" then "Program log: Instruction: Name".
    // Attribute the tx's CU to every instruction of this program it ran
    // (multi-ix txs get counted under each ix they contain — noted in docs).
    const names = [];
    for (let i = 0; i < logs.length; i++) {
      const invoke = logs[i].match(/^Program (\S+) invoke/);
      if (!invoke || invoke[1] !== pid.toBase58()) continue;
      for (let j = i + 1; j < logs.length && !logs[j].startsWith(`Program ${pid} success`); j++) {
        const ix = logs[j].match(/^Program log: Instruction: (\w+)/);
        if (ix) { names.push(ix[1]); break; }
      }
    }
    if (!names.length) names.push("(unknown)");
    for (const n of names) {
      if (!rows.has(n)) rows.set(n, { cus: [], count: 0 });
      const r = rows.get(n);
      r.count++;
      if (cu != null) r.cus.push(cu);
    }
  }
  console.log(`\n## ${name} — ${scanned} txs scanned, ${failed} failed`);
  console.log(`| instruction | txs | CU min | CU median | CU max |`);
  console.log(`|---|---|---|---|---|`);
  for (const [ix, r] of [...rows.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (!r.cus.length) { console.log(`| ${ix} | ${r.count} | — | — | — |`); continue; }
    console.log(`| ${ix} | ${r.count} | ${Math.min(...r.cus).toLocaleString()} | ${Math.round(median(r.cus)).toLocaleString()} | ${Math.max(...r.cus).toLocaleString()} |`);
  }
}
