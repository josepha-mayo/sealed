import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as AnchorTypes from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const anchor: typeof AnchorTypes = require("@anchor-lang/core");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The IDL is a build artifact (target/ is gitignored) — but the committed
 *  copy under idl/ keeps every snapshot replay working on a cold clone.
 *  target/idl wins when present so a fresh build never reads a stale floor. */
export function loadIdl(section: "sealed" | "market"): any {
  for (const base of [join(ROOT, "target", "idl"), join(ROOT, "idl")]) {
    const p = join(base, `${section}.json`);
    if (existsSync(p)) return require(p);
  }
  throw new Error(`no IDL for ${section} — run 'anchor build' or restore idl/${section}.json`);
}

export interface SnapAccount {
  publicKey: PublicKey;
  account: any;
}
export type SnapMap = Map<string, SnapAccount[]>;

const warnedPaths = new Set<string>();

export function loadSnapshotJson(path: string): any {
  const raw = readFileSync(path);
  // Tamper check: when the file rides the committed web/MANIFEST (the
  // `snapshot.json` next to it), prove the bytes are the ones the repo
  // signed off on. A mismatch is a loud warning, not a refusal — the file
  // may have been legitimately regenerated.
  const manifest = join(dirname(path), "MANIFEST");
  if (basename(path) === "snapshot.json" && existsSync(manifest)) {
    const pinned = readFileSync(manifest, "utf8").split("\n")
      .map((l) => l.trim()).find((l) => l.endsWith("./snapshot.json"))?.split(/\s+/)[0];
    if (pinned && createHash("sha256").update(raw).digest("hex") !== pinned && !warnedPaths.has(path)) {
      warnedPaths.add(path);
      console.error(`!! snapshot.json sha256 differs from web/MANIFEST (${pinned.slice(0, 12)}…) — ` +
        "the bundle was regenerated or tampered with; replay proceeds but do not cite it as committed evidence");
    }
  }
  return JSON.parse(raw.toString("utf8"));
}

/** Decode one snapshot program section (`sealed` or `market`) into
 *  account-name → [{publicKey, account}] via each IDL type's 8-byte
 *  discriminator — the same shape `.all()` returns, so the read commands
 *  replay identically over the committed bundle with no connection.
 *  Entries matching no discriminator, or whose layout predates the current
 *  IDL (the EOF-brick class live fetches tolerate), are skipped. */
export function decodeSnapshotSection(snap: any, section: "sealed" | "market"): SnapMap {
  const idl = loadIdl(section);
  const coder = new anchor.BorshAccountsCoder(idl);
  const discs: Array<[string, Buffer]> = (idl.accounts ?? []).map(
    (a: any) => [a.name, coder.accountDiscriminator(a.name)],
  );
  const out: SnapMap = new Map();
  for (const e of snap[section] ?? []) {
    const buf = Buffer.from(e.data, "base64");
    const hit = discs.find(([, d]) => buf.subarray(0, 8).equals(d));
    if (!hit) continue;
    try {
      const account = decodeAccountTolerant(coder, hit[0], buf);
      if (!account) continue;
      const list = out.get(hit[0]) ?? [];
      list.push({ publicKey: new PublicKey(e.pubkey), account });
      out.set(hit[0], list);
    } catch {
      /* layout predates this IDL — same skip the explorer's parsers make */
    }
  }
  return out;
}

/** Decode raw account bytes for IDL account `name`, tolerating layouts
 *  older than the current IDL: a strict decode fails on accounts minted
 *  before tail fields were appended (live `.fetch` EOF-bricks on these),
 *  so we retry with a zero pad — appended fields decode as zero ("absent").
 *  Only applies to caller-discriminator-matched bytes, so this can never
 *  launder a type. Field names normalize snake_case → camelCase — the
 *  shape `.all()`/`fetch` consumers expect. */
export function decodeAccountTolerant(coder: any, name: string, buf: Buffer): any | null {
  let dec: any = null;
  for (const pad of [0, 32, 64, 128, 256]) {
    try {
      dec = coder.decode(name, pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf);
      break;
    } catch { /* still short — pad more */ }
  }
  if (!dec) return null;
  const account: any = {};
  for (const [k, v] of Object.entries(dec))
    account[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return account;
}

export const snapOf = (m: SnapMap, name: string): SnapAccount[] => m.get(name) ?? [];

/** `.all()`-shaped view over a snapshot program section, plus the RPC
 *  fallback the write paths still need. Returns null when no snapshot is
 *  given so callers keep the live fetch. */
export function snapshotAccounts(
  path: string | undefined,
  section: "sealed" | "market",
): SnapMap | null {
  if (!path) return null;
  return decodeSnapshotSection(loadSnapshotJson(path), section);
}
