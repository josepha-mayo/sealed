/**
 * Venue board — the keeper + discovery surface made executable.
 *
 * Markets and bounties on this protocol are designed to run with NO
 * operator: resolution is permissionless, expiry sweeps are
 * permissionless, dark tallies are permissionless, bounty claims are
 * permissionless. But permissionless paths are useless without a way to
 * FIND them — this scan answers the two questions every keeper/runner
 * asks:
 *
 *   1. What can I do RIGHT NOW?   (claimable bounties, resolvable venues,
 *      tallyable darks, sweepable expiries)
 *   2. What's still in play?      (filling markets, live bounties,
 *      revealing darks)
 *
 * The classification mirrors the on-chain gates exactly — the same
 * `still_moving` / `proven` / `bounty_qualifies` / `expire_decision`
 * logic in programs/market/src/lib.rs, evaluated purely over fetched
 * accounts. Same verdict off a live RPC or the explorer's committed
 * snapshot.
 */

export interface BoardRun {
  pubkey: string;
  benchmark: string;
  runner: string;
  status: number;         // 0 pending, 1 finalized
  correct: number;
  createdAt: number;      // unix seconds
  firstPendingAt: number; // unix seconds, 0 = never queued
  allQueuedAt: number;    // unix seconds, 0 = never fully committed
  /** u64 bitmask serialized (BN.toString()) — nonzero means ≥1 landed chunk. */
  scoredMask: string | number;
  postReveal?: boolean | number;
}

export interface BoardBounty {
  pubkey: string;
  sponsor: string;
  bank: string;
  status: number;        // 0 open, 1 claimed
  threshold: number;
  amount: number;        // lamports escrowed
  createdAt: number;
  deadline: number;
  winnerRun?: string;
  winningScore?: number;
}

export interface BoardMarket {
  pubkey: string;
  kind: "band" | "duel" | "dark";
  status: number;        // 0 open, 1 resolved, 2 cancelled
  run: string;
  /** Duels only: second leg — both must finalize. Pubkey default on bands. */
  runB?: string;
  resolveBy: number;     // unix seconds, 0 = no expiry path
  /** Darks only: reveal window close — finalize_dark lands after this. */
  revealUntil?: number;
  tallied?: boolean;
}

export interface BoardLadder {
  pubkey: string;
  status: number;
  legs: string[];        // live leg run PDAs (leg_count sliced)
  resolveBy: number;
}

export interface ActionableBounty extends BoardBounty {
  qualifyingRun: string;
  qualifyingScore: number;
}

export interface ExpirableMarket extends BoardMarket {
  /** What `expire_*` will do on-chain: settle on proven (partial) score or
   *  cancel-and-refund — `expire_decision`'s outcome, computed here. */
  expireOutcome: "settles" | "refunds";
}

export interface Board {
  /** Open bounties with a qualifying run already proven — claimable NOW. */
  claimable: ActionableBounty[];
  /** Open bounties still inside their window, no qualifying run yet. */
  liveBounties: BoardBounty[];
  /** Open bounties past deadline — `market bounty expire` sweeps them. */
  expiredBounties: BoardBounty[];
  /** Claimed bounties — permanent evidence, count only. */
  claimedBounties: number;
  /** Open markets whose run(s) finalized — `resolve`/`resolve_dark` lands. */
  resolvable: BoardMarket[];
  /** Open markets past `resolve_by` with nothing still moving — `expire_*`
   *  lands (annotated with settle-vs-refund outcome). */
  expirable: ExpirableMarket[];
  /** Resolved darks past `reveal_until` still untallied — `finalize_dark`
   *  locks the tally (or cancels to gross refunds on zero reveals). */
  tallyable: BoardMarket[];
  /** Open ladders with no leg still moving — `resolve_ladder` lands now
   *  (the gate is `!still_moving` per leg, NOT `resolve_by`). */
  resolvableLadders: BoardLadder[];
  /** Resolved darks inside their reveal window — positions revealing. */
  revealing: number;
  /** Open venues with no permissionless action available yet: inside the
   *  betting window, or past deadline but a run is still inside its
   *  landing window (expire would error `MarketResolvable`). */
  filling: number;
  /** Resolved (non-dark or tallied) + cancelled venues — count only. */
  settled: number;
}

const OPEN = 0;
const RESOLVED = 1;
const FINALIZED = 1;

/** Mirror of `EXPIRE_HARD_CAP_SECS` in programs/market/src/lib.rs. */
export const HARD_CAP_SECS = 24 * 3600;

const hasLanded = (r: BoardRun) => String(r.scoredMask) !== "0";

/** `still_moving` — a run whose score may still legitimately improve:
 *  inside the 24h first-queue window (`first_pending_at`, ungameable), or
 *  fully committed but its post-commit landing window hasn't elapsed. */
export const stillMoving = (r: BoardRun, now: number): boolean =>
  r.status !== FINALIZED &&
  ((r.firstPendingAt !== 0 && now <= r.firstPendingAt + HARD_CAP_SECS) ||
    (r.allQueuedAt !== 0 && now <= r.allQueuedAt + HARD_CAP_SECS));

/** `proven` — finalized, or fully committed a full landing window ago with
 *  at least one landed chunk (a live cluster would have produced the
 *  true score; only a dead one leaves a partial). */
export const proven = (r: BoardRun, now: number): boolean =>
  r.status === FINALIZED ||
  (r.allQueuedAt !== 0 && now > r.allQueuedAt + HARD_CAP_SECS && hasLanded(r));

/** Classify one ledger's venue accounts into the keeper board. Pure — no
 *  chain access; `now` is unix seconds. */
export function classifyBoard(
  rows: {
    bounties: BoardBounty[];
    markets: BoardMarket[];
    ladders: BoardLadder[];
    runs: BoardRun[];
  },
  now: number,
): Board {
  const board: Board = {
    claimable: [], liveBounties: [], expiredBounties: [], claimedBounties: 0,
    resolvable: [], expirable: [], tallyable: [], resolvableLadders: [],
    revealing: 0, filling: 0, settled: 0,
  };

  const runsByPk = new Map(rows.runs.map((r) => [r.pubkey, r]));
  const runsByBank = new Map<string, BoardRun[]>();
  for (const r of rows.runs) {
    if (proven(r, now)) {
      const list = runsByBank.get(r.benchmark) ?? [];
      list.push(r);
      runsByBank.set(r.benchmark, list);
    }
  }

  for (const b of rows.bounties) {
    if (b.status !== OPEN) { board.claimedBounties++; continue; }
    // `claim_bounty` needs now <= deadline; `expire_bounty` needs now >.
    if (now > b.deadline) { board.expiredBounties.push(b); continue; }
    // `bounty_qualifies`: same bank, run postdates the bounty (retroactivity
    // wall), runner ≠ sponsor (no self-dealing), score ≥ threshold,
    // finalized-or-proven, and claim_bounty's own PostRevealRun check.
    const q = (runsByBank.get(b.bank) ?? [])
      .filter((r) => r.correct >= b.threshold && r.createdAt >= b.createdAt &&
        r.runner !== b.sponsor && !r.postReveal)
      .sort((x, y) => y.correct - x.correct)[0];
    if (q) board.claimable.push({ ...b, qualifyingRun: q.pubkey, qualifyingScore: q.correct });
    else board.liveBounties.push(b);
  }

  for (const m of rows.markets) {
    // Resolved darks are not settled yet — an untallied one is a keeper
    // target (`finalize_dark` once now > reveal_until) or a reveal in play.
    if (m.kind === "dark" && m.status === RESOLVED && !m.tallied) {
      if (now > (m.revealUntil ?? 0)) board.tallyable.push(m);
      else board.revealing++;
      continue;
    }
    if (m.status !== OPEN) { board.settled++; continue; }
    const a = runsByPk.get(m.run);
    const b = m.runB ? runsByPk.get(m.runB) : undefined;
    const legsDone = a?.status === FINALIZED &&
      (m.kind !== "duel" || b?.status === FINALIZED);
    if (legsDone) { board.resolvable.push(m); continue; }
    // expire_decision fires only past resolve_by (never for resolve_by=0)
    // and Blocks while any leg is still moving — no keeper action then.
    if (!a || (m.kind === "duel" && !b) ||
        m.resolveBy === 0 || now <= m.resolveBy ||
        stillMoving(a, now) || (b ? stillMoving(b, now) : false)) {
      board.filling++;
      continue;
    }
    const settleable = m.kind === "duel"
      ? proven(a, now) && proven(b as BoardRun, now)
      : proven(a, now);
    board.expirable.push({ ...m, expireOutcome: settleable ? "settles" : "refunds" });
  }

  // Ladders resolve on `!still_moving` per leg — resolve_by is the
  // advertised end for bettors, not the resolution gate (it can land
  // early; never-queued legs forfeit at 0). There is no expire path.
  for (const l of rows.ladders) {
    if (l.status !== OPEN) { board.settled++; continue; }
    const legs = l.legs.map((pk) => runsByPk.get(pk));
    if (legs.some((r) => !r || stillMoving(r, now))) board.filling++;
    else board.resolvableLadders.push(l);
  }
  return board;
}
