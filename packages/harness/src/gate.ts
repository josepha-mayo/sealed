/**
 * Capability gates — the registry as a composable policy surface.
 *
 * A gate evaluates a `ModelRecord`'s `ScoreLog` receipts against a caller's
 * policy and answers PASS/FAIL with evidence — this is the "insurers and
 * DAOs pricing capability risk" surface made executable: a script, CI job,
 * or lending contract can gate on MPC-scored proof rather than a
 * leaderboard's word. The evaluation is pure over the fetched accounts —
 * the same function backs `chain gate` and can run in a browser against
 * the explorer's snapshot.
 *
 * Honesty contract (same flags a resolver must respect — see
 * docs/integrate.md): `vouchedOnly` restricts evidence to receipts whose
 * runs were venue-attested at record time; `post_reveal` receipts are
 * always reported separately and `noPostReveal` drops them from the
 * evidence pool — a score minted after the answer fingerprints went
 * public doesn't measure the same thing. `minWilsonPct` applies the
 * Wilson 95% lower confidence bound so a thin perfect sample can't
 * flatter a strict gate.
 */

export interface ScoreReceipt {
  correct: number;
  items: number;
  vouchedAtRecord: boolean | number;
  postReveal?: boolean | number;
}

export interface GatePolicy {
  /** Accuracy floor in percent (0..100) over the selected receipts. */
  minPct?: number;
  /** Minimum number of scoring receipts (runs enrolled). */
  minRuns?: number;
  /** Minimum aggregate items answered — the sample-size floor. */
  minItems?: number;
  /** Restrict evidence to venue-attested runs (vouched_at_record). */
  vouchedOnly?: boolean;
  /** Drop receipts minted after the bank's fingerprints were revealed —
   *  a post-reveal score doesn't measure the same thing. */
  noPostReveal?: boolean;
  /** Wilson 95% lower-confidence-bound floor in percent — the point
   *  estimate can't pass on a thin sample: 3/3 (100%) has LCB ≈ 44%. */
  minWilsonPct?: number;
}

/** Wilson score interval lower bound for a binomial proportion, as a
 *  percent. `z = 1.96` is the usual 95% bound. */
export function wilsonLowerBoundPct(correct: number, items: number, z = 1.96): number {
  if (items <= 0) return 0;
  const p = correct / items;
  const z2 = z * z;
  const denom = 1 + z2 / items;
  const centre = p + z2 / (2 * items);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * items)) / items);
  return (100 * (centre - margin)) / denom;
}

export interface GateCheck {
  name: string;
  pass: boolean;
  actual: string;
  needed: string;
}

export interface GateVerdict {
  pass: boolean;
  /** "pass" | "no-record" | "no-evidence" | "policy" — no-evidence states
   *  are distinct from a failed policy: absent proof ≠ disproof. */
  reason: "pass" | "no-record" | "no-evidence" | "policy";
  modelId: string | null;
  scope: "all" | "vouched";
  /** Selected-receipt aggregate — what the policy measured. */
  runs: number;
  items: number;
  correct: number;
  pct: number;
  /** Unfiltered receipt count, always reported for context. */
  totalRuns: number;
  /** Receipts minted after a fingerprint reveal — flagged, not hidden. */
  postRevealRuns: number;
  checks: GateCheck[];
}

/** Evaluate `policy` over `receipts` (ScoreLog rows for one ModelRecord).
 *  `recordExists` distinguishes "no ModelRecord PDA" from "record exists
 *  but no receipts survive the filter". Pure — no chain access. */
export function evalGate(
  receipts: ScoreReceipt[],
  policy: GatePolicy,
  recordExists = true,
): GateVerdict {
  const totalRuns = receipts.length;
  const postRevealRuns = receipts.filter((r) => !!r.postReveal).length;
  let selected = policy.vouchedOnly ? receipts.filter((r) => !!r.vouchedAtRecord) : receipts;
  if (policy.noPostReveal) selected = selected.filter((r) => !r.postReveal);
  const runs = selected.length;
  const correct = selected.reduce((s, r) => s + r.correct, 0);
  const items = selected.reduce((s, r) => s + r.items, 0);
  const pct = items > 0 ? (100 * correct) / items : 0;

  const base = {
    modelId: null as string | null,
    scope: (policy.vouchedOnly ? "vouched" : "all") as "all" | "vouched",
    runs, items, correct, pct, totalRuns, postRevealRuns,
  };

  if (!recordExists) {
    return { pass: false, reason: "no-record", ...base, checks: [] };
  }
  if (runs === 0) {
    return { pass: false, reason: "no-evidence", ...base, checks: [] };
  }

  const checks: GateCheck[] = [];
  if (policy.minPct !== undefined) {
    checks.push({
      name: "accuracy",
      pass: pct >= policy.minPct,
      actual: `${pct.toFixed(1)}% (${correct}/${items})`,
      needed: `>= ${policy.minPct}%`,
    });
  }
  if (policy.minRuns !== undefined) {
    checks.push({
      name: "runs",
      pass: runs >= policy.minRuns,
      actual: `${runs} receipt${runs === 1 ? "" : "s"}`,
      needed: `>= ${policy.minRuns}`,
    });
  }
  if (policy.minItems !== undefined) {
    checks.push({
      name: "items",
      pass: items >= policy.minItems,
      actual: `${items} scored items`,
      needed: `>= ${policy.minItems}`,
    });
  }
  if (policy.minWilsonPct !== undefined) {
    const lcb = wilsonLowerBoundPct(correct, items);
    checks.push({
      name: "wilson-95",
      pass: lcb >= policy.minWilsonPct,
      actual: `${lcb.toFixed(1)}% LCB (${correct}/${items})`,
      needed: `>= ${policy.minWilsonPct}%`,
    });
  }
  const pass = checks.every((c) => c.pass);
  return { pass, reason: pass ? "pass" : "policy", ...base, checks };
}
