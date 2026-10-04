import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as AnchorTypes from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const anchor: typeof AnchorTypes = require("@anchor-lang/core");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface SnapAccount {
  publicKey: PublicKey;
  account: any;
}
export type SnapMap = Map<string, SnapAccount[]>;

export function loadSnapshotJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Decode one snapshot program section (`sealed` or `market`) into
 *  account-name → [{publicKey, account}] via each IDL type's 8-byte
 *  discriminator — the same shape `.all()` returns, so the read commands
 *  replay identically over the committed bundle with no connection.
 *  Entries matching no discriminator, or whose layout predates the current
 *  IDL (the EOF-brick class live fetches tolerate), are skipped. */
export function decodeSnapshotSection(snap: any, section: "sealed" | "market"): SnapMap {
  const idl = require(join(ROOT, "target", "idl", `${section}.json`));
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
      const list = out.get(hit[0]) ?? [];
      const account: any = {};
      // This fork's coder returns snake_case field names; `.all()` consumers
      // expect camelCase — normalize so live and replay paths share one shape.
      for (const [k, v] of Object.entries(coder.decode(hit[0], buf)))
        account[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
      list.push({ publicKey: new PublicKey(e.pubkey), account });
      out.set(hit[0], list);
    } catch {
      /* layout predates this IDL — same skip the explorer's parsers make */
    }
  }
  return out;
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
