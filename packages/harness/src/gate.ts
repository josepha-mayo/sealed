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
 * reported separately, never silently counted — a score minted after the
 * answer fingerprints went public doesn't measure the same thing.
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
  const selected = policy.vouchedOnly ? receipts.filter((r) => !!r.vouchedAtRecord) : receipts;
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
  const pass = checks.every((c) => c.pass);
  return { pass, reason: pass ? "pass" : "policy", ...base, checks };
}
