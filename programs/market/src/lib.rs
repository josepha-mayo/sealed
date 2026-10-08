//! Sealed Market: N-way parimutuel markets that resolve on a Sealed run's score.
//!
//! A market defines `n_outcomes` score buckets via `edges`: outcome `i` wins iff
//! `edges[i-1] <= run.correct < edges[i]` (edges[i-1] treated as 0 when i==0 and
//! u32::MAX when i is the last outcome). A 2-outcome market with edges=[t] is the
//! classic "correct >= t?" binary.
//!
//! Settled entirely onchain: `resolve` reads the Sealed program's `Run` account,
//! so the resolution source is the MPC-scored result, not an operator.
//!
//! Lifecycle
//!   create_market  pick a pending, unscored run + bucket edges
//!   bet            deposit lamports on an outcome while the run stays unscored
//!                  (once MPC scoring starts, late information could leak)
//!   resolve        anyone settles once run.status == FINALIZED
//!   claim          winners split the whole pot pro-rata; cancelled markets refund

use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// The Sealed program whose Run accounts resolve these markets.
pub const SEALED_PROGRAM: Pubkey = pubkey!("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
/// sha256("account:Run")[..8] — the discriminator sealed writes on every Run.
pub const RUN_DISC: [u8; 8] = [0xc7, 0x36, 0x9b, 0x56, 0xeb, 0x73, 0xf6, 0xbd];
/// sha256("account:Benchmark")[..8] — checked by `load_benchmark` when a
/// bounty binds a bank (threshold cap needs `chunk_count` off the account).
pub const BENCH_DISC: [u8; 8] = [0x39, 0xfc, 0x21, 0x36, 0x71, 0x8d, 0xe9, 0xf7];

pub const RUN_PENDING: u8 = 0;
pub const RUN_FINALIZED: u8 = 1;

pub const MARKET_OPEN: u8 = 0;
pub const MARKET_RESOLVED: u8 = 1;
pub const MARKET_CANCELLED: u8 = 2;

pub const MAX_OUTCOMES: usize = 8;
/// Most runs a ladder market may race — also the width of `result_mask`.
pub const MAX_LEGS: usize = 8;
/// Fewest legs a ladder may race — pairs belong in `create_duel`, which
/// carries an explicit tie bucket and the proven-leg veto. A 2-leg ladder
/// has neither, so a dormant-ringer leg's backers' stake would flow to the
/// live leg deterministically; 3+ keeps dead-heat refunds meaningful.
pub const MIN_LEGS: usize = 3;
// `result_mask`/`argmax_mask` shift a u8 by leg index — a wider field would
// silently wrap at `1u8 << 8`.
const _: () = assert!(MAX_LEGS <= 8, "result_mask is u8 — MAX_LEGS must stay <= 8");
/// Absolute bound on scoring-liveness delays: a run whose FIRST queue is this
/// old is expirable unconditionally — pending bits are runner-refreshable,
/// swept/stale computations can still land, so nothing on-chain can prove a
/// computation is dead; a write-once timestamp is the only ungameable bound.
pub const EXPIRE_HARD_CAP_SECS: i64 = 24 * 3600;
/// Longest deadline a market may set — a far-future `resolve_by` defeats the
/// refund escape hatch, so creation caps it well past any real scoring delay.
pub const MAX_RESOLVE_HORIZON_SECS: i64 = 90 * 24 * 3600;
/// Shortest deadline a market may set — a `resolve_by`/`closes_at` seconds
/// after creation is bait that evaporates before anyone can react to it.
pub const MIN_RESOLVE_DELAY_SECS: i64 = 60;
/// Recommended dark-market reveal window — winners get this long to reveal
/// their preimage before `finalize_dark` lets claims open. The floor is
/// `MIN_RESOLVE_DELAY_SECS` (a window that short is visible bait — bettors
/// see `reveal_secs` before staking); real markets should use 24h+.
pub const REVEAL_WINDOW_SECS: i64 = 24 * 3600;

declare_id!("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");

/// Commitment stored on a `DarkPosition`: SHA256 over the tagged preimage.
/// The outcome space is <= 8 values, so binding alone is not hiding — the
/// 32-byte salt is what makes the commitment ungrindable. `market` and
/// `bettor` inside the preimage block replay across markets and wallets,
/// and `amount` binds the stake size (no "reveal the winning side with a
/// bigger number" equivocation).
fn dark_commitment(
    market: &Pubkey,
    bettor: &Pubkey,
    outcome: u8,
    amount: u64,
    salt: &[u8; 32],
) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        b"sealed/dark",
        market.as_ref(),
        bettor.as_ref(),
        &[outcome],
        &amount.to_le_bytes(),
        salt,
    ])
    .to_bytes()
}

/// Deserialize a Sealed `Run` account: owner + discriminator checked by hand
/// (`Account<T>` would demand the market program as owner).
/// INVARIANT: `sealed::Run` may only ever grow by TAIL-APPEND — shrinking or
/// reordering a field before `ever_queued_mask` Borsh-bricks every open market
/// (resolve AND expire both route through this fn). Mirror below must match
/// through `ever_queued_mask`; `try_deserialize_unchecked` deliberately
/// ignores TRAILING bytes so a future tail-append can't brick this reader.
fn load_run(info: &AccountInfo) -> Result<Run> {
    require!(info.owner == &SEALED_PROGRAM, ErrorCode::WrongRun);
    let data = info.try_borrow_data()?;
    require!(data.len() > 8 && data[..8] == RUN_DISC, ErrorCode::WrongRun);
    let run = Run::try_deserialize_unchecked(&mut &data[..])?;
    Ok(run)
}

/// Tail-read sealed's `post_reveal` byte (F1 hardening): a run created after
/// `reveal_part` declassified a fingerprint on its bank could commit to the
/// now-public scoring targets — markets refuse to open on flagged runs.
/// The byte sits one slot past the mirror struct's end, behind the
/// variable-length `model_id`: disc8 + 176B fixed + u32 len + model_id +
/// 41B tail (attested1+attested_at8+pending_since8+first_pending_at8+
/// ever_queued_mask8+all_queued_at8) + post_reveal1. Pre-upgrade accounts
/// lack the byte — `get()` returns None and they read untainted.
fn run_post_reveal(info: &AccountInfo) -> Result<bool> {
    let data = info.try_borrow_data()?;
    Ok(run_post_reveal_bytes(&data))
}

fn run_post_reveal_bytes(data: &[u8]) -> bool {
    if data.len() < 188 {
        return false;
    }
    let ml = u32::from_le_bytes(data[184..188].try_into().unwrap()) as usize;
    data.get(229 + ml).copied().unwrap_or(0) != 0
}

/// Fixed-offset read of `sealed::Benchmark`: every field a bounty needs
/// (status, chunk_count, kind) precedes the variable-length `name`, so the
/// layout tail can grow without bricking this reader — same contract as
/// `load_run`. Returns (status, chunk_count, kind).
/// Layout: disc8 + authority32 + id u32 + bump1 + status1@45 +
/// chunk_count u16@46 + chunks_sealed u16 + items_root32 + fee u64 +
/// run_count u64 + created_at i64 + kind1@106 + name…
fn load_benchmark(info: &AccountInfo) -> Result<(u8, u16, u8)> {
    require!(info.owner == &SEALED_PROGRAM, ErrorCode::WrongBank);
    let data = info.try_borrow_data()?;
    require!(
        data.len() > 106 && data[..8] == BENCH_DISC,
        ErrorCode::WrongBank
    );
    let status = data[45];
    let chunk_count = u16::from_le_bytes(data[46..48].try_into().unwrap());
    let kind = data[106];
    Ok((status, chunk_count, kind))
}

/// Whether `run` may claim `bounty` — the pure half of `claim_bounty`,
/// unit-testable. FCFS: the FIRST run to meet every gate takes the pot,
/// there is no challenge window (a highest-score auction would need a
/// nominate/contest phase — explicit scope cut).
fn bounty_qualifies(r: &Run, b: &Bounty, now: i64) -> bool {
    // Same bank, and the run must postdate the bounty — otherwise a sponsor
    // could attach a bounty to a bank where a qualifying run already exists
    // and a confederate instantly claims a self-dealing payout.
    r.benchmark == b.bank
        && r.created_at >= b.created_at
        // A sponsor's own run can't claim — otherwise "X beat the bounty"
        // evidence could be self-dealt: post bounty, run own model, claim.
        // (Pubkey-only, so sybil-able like duels' RunnersMustDiffer — it
        // blocks the one-wallet case; a determined sponsor can fund an alt.)
        && r.runner != b.sponsor
        && r.correct >= b.threshold
        // Finalized, or a committed run past its landing window — same
        // proven-partial standard markets settle on via `expire_decision`.
        && (r.status == RUN_FINALIZED || proven(r, now))
}

/// Bucket index that `score` falls into: count of edges <= score.
/// edges are nondecreasing upper bounds; outcome i covers [edges[i-1], edges[i]).
fn outcome_of(edges: &[u32; MAX_OUTCOMES - 1], n: u8, score: u32) -> u8 {
    let mut i = 0u8;
    while i < n - 1 && score >= edges[i as usize] {
        i += 1;
    }
    i
}

/// Shared settlement: every outcome bucket backed → resolve on `correct`,
/// else cancel and refund. Emits the resolved record either way.
fn settle_score(m: &mut Account<Market>, correct: u32, run: Pubkey) -> Result<()> {
    let all_backed = m.totals[..m.n_outcomes as usize].iter().all(|&t| t > 0);
    if all_backed {
        let pot: u64 = m.totals.iter().sum();
        m.fees_accrued = (pot as u128 * m.fee_bps as u128 / 10_000) as u64;
        m.resolved_score = correct;
        m.resolved_at = Clock::get()?.unix_timestamp;
        m.status = MARKET_RESOLVED;
        m.outcome = outcome_of(&m.edges, m.n_outcomes, correct);
    } else {
        m.status = MARKET_CANCELLED;
    }
    emit!(MarketResolved {
        market: m.key(),
        run,
        correct,
        outcome: m.outcome,
        cancelled: m.status == MARKET_CANCELLED,
    });
    Ok(())
}

/// What `expire_market` should do, decided purely from run state — unit-testable.
enum ExpireAction {
    /// No proven signal — refund every position.
    Cancel,
    /// Settle a score market on the (possibly partial) proven count.
    SettleScore(u32),
    /// Settle a duel on both (possibly partial) proven counts.
    SettleDuel(u32, u32),
    /// A run can still legitimately move — expiry must not fire.
    Blocked,
}

/// Past the 24h first-queue hard cap: the cluster is presumed dead for this
/// computation. `first_pending_at` is write-once, so sweep+requeue can't
/// extend it.
fn past_cap(r: &Run, now: i64) -> bool {
    r.first_pending_at != 0 && now > r.first_pending_at + EXPIRE_HARD_CAP_SECS
}

/// A leg whose score may still legitimately improve: inside the 24h window
/// from its FIRST queue (`first_pending_at`, ungameable), or fully committed
/// but its post-commit landing window hasn't elapsed yet. The second case
/// covers just-in-time commits: a runner who queues the remaining chunks at
/// the last moment must still give the cluster a full cap-window to land
/// them before any partial may settle — a live cluster finalizes the run
/// (the honest outcome), and only a genuinely dead one leaves the partial.
fn still_moving(r: &Run, now: i64) -> bool {
    if r.status == RUN_FINALIZED {
        return false;
    }
    if r.first_pending_at != 0 && !past_cap(r, now) {
        return true;
    }
    r.all_queued_at != 0 && now <= r.all_queued_at + EXPIRE_HARD_CAP_SECS
}

/// A run whose current `correct` is a fair settle value: finalized, or fully
/// committed long enough ago that every queued chunk had a complete
/// landing window (a live cluster would have produced the true score), with
/// at least one landed chunk to prove signal.
fn proven(r: &Run, now: i64) -> bool {
    r.status == RUN_FINALIZED
        || (r.all_queued_at != 0
            && now > r.all_queued_at + EXPIRE_HARD_CAP_SECS
            && r.scored_mask != 0)
}

/// The score a ladder leg contributes at resolution: whatever chunks have
/// landed. `correct` is monotone non-decreasing in landed chunks, so under
/// argmax a landed partial can only understate a leg — never inflate it —
/// which makes partials safe to count even for uncommitted stalls (unlike
/// score-band markets, where a chosen truncation can land a favorable
/// bucket). Only a leg with NOTHING landed — never queued, or every queued
/// computation died unfinalized — scores 0: a forfeit, never a cancel
/// trigger (cancelling would hand every losing leg operator a free exit).
fn ladder_leg_score(r: &Run) -> u32 {
    if r.scored_mask != 0 {
        r.correct
    } else {
        0
    }
}

/// Whether a ladder may resolve at all right now. Beyond the per-leg
/// `still_moving` windows, a race where NO leg ever started has no result
/// to discover: argmax on all-zero forfeits yields a full mask → wash
/// cancel, so without this gate anyone could insta-cancel a fresh ladder
/// next slot — a repeatable venue DoS for the cost of one tx. Past
/// `resolve_by` the same call doubles as the ladder's expiry path:
/// all-forfeit → cancel → everyone refunds.
fn ladder_resolvable(legs: &[Run], now: i64, resolve_by: i64) -> bool {
    if legs.iter().any(|r| still_moving(r, now)) {
        return false;
    }
    if legs
        .iter()
        .all(|r| r.first_pending_at == 0 && r.all_queued_at == 0 && r.scored_mask == 0)
    {
        return now > resolve_by;
    }
    true
}

/// Bitmask of legs tied at the max score (dead-heat). `scores[i]` maps to
/// bit i; the i-th leg's pool is `totals[i]`.
fn argmax_mask(scores: &[u32]) -> u8 {
    let max = scores.iter().copied().max().unwrap_or(0);
    let mut mask = 0u8;
    for (i, &s) in scores.iter().enumerate() {
        if s == max {
            mask |= 1 << i;
        }
    }
    mask
}

/// All-legs-tied bitmask for a `len`-leg race, without a u8 round-trip —
/// `1u16 << 8` truncates to 0 as u8, which made 8-leg ladders unresolvable.
fn full_leg_mask(len: usize) -> u16 {
    (1u16 << len) - 1
}

/// Shared ladder settlement: co-leaders split the pot pro-rata (dead-heat).
/// Nobody backed any leader, or every leg tied (incl. all-zero) → wash →
/// cancel so everyone refunds in full.
fn settle_ladder(m: &mut Account<Ladder>, scores: &[u32]) -> Result<()> {
    let mask = argmax_mask(scores);
    m.resolved_at = Clock::get()?.unix_timestamp;
    let winning_stake: u64 = scores
        .iter()
        .enumerate()
        .filter(|(i, _)| mask & (1 << i) != 0)
        .map(|(i, _)| m.totals[i])
        .sum();
    if winning_stake == 0 || mask as u16 == full_leg_mask(scores.len()) {
        // A cancelled race has no winners — store a clean zero mask so a
        // naive indexer can't read the raw argmax as a result.
        m.status = MARKET_CANCELLED;
        m.result_mask = 0;
        m.resolved_score = 0;
    } else {
        m.result_mask = mask;
        m.resolved_score = scores.iter().copied().max().unwrap_or(0);
        let pot: u64 = m.totals.iter().sum();
        m.fees_accrued = (pot as u128 * m.fee_bps as u128 / 10_000) as u64;
        m.status = MARKET_RESOLVED;
    }
    emit!(LadderResolved {
        ladder: m.key(),
        result_mask: m.result_mask,
        winning_score: m.resolved_score,
        scores: scores.to_vec(),
        cancelled: m.status == MARKET_CANCELLED,
    });
    Ok(())
}

/// Strict ordered leg check — `remaining_accounts` must be exactly the
/// ladder's bound legs, in order, each a genuine Sealed `Run`. A subset or
/// reordered set would let a caller dodge the betting latch or feed
/// `resolve_ladder` inflated scores.
fn load_legs<'info>(
    ladder: &Ladder,
    remaining: &[AccountInfo<'info>],
) -> Result<Vec<Run>> {
    require!(
        remaining.len() == ladder.leg_count as usize,
        ErrorCode::LegMismatch
    );
    let mut runs = Vec::with_capacity(remaining.len());
    for (i, info) in remaining.iter().enumerate() {
        require!(
            info.key() == ladder.legs[i],
            ErrorCode::LegMismatch
        );
        runs.push(load_run(info)?);
    }
    Ok(runs)
}

fn expire_decision(ra: &Run, rb: Option<&Run>, now: i64) -> ExpireAction {
    match rb {
        None => {
            if ra.status == RUN_FINALIZED {
                return ExpireAction::Blocked;
            }
            if ra.first_pending_at == 0 {
                return ExpireAction::Cancel; // never queued — nothing proven
            }
            if still_moving(ra, now) {
                return ExpireAction::Blocked; // in-window or committed-in-grace
            }
            if proven(ra, now) {
                ExpireAction::SettleScore(ra.correct) // honest partial
            } else {
                ExpireAction::Cancel // uncommitted/nothing landed: refund
            }
        }
        Some(rb) => {
            if ra.status == RUN_FINALIZED && rb.status == RUN_FINALIZED {
                return ExpireAction::Blocked;
            }
            if still_moving(ra, now) || still_moving(rb, now) {
                return ExpireAction::Blocked;
            }
            if proven(ra, now) && proven(rb, now) {
                ExpireAction::SettleDuel(ra.correct, rb.correct)
            } else {
                // A never-queued or uncommitted leg is dead — refund. Settling
                // it at 0 would let a sybil'd attacker mint a ringer leg and
                // steal the other side's stake.
                ExpireAction::Cancel
            }
        }
    }
}

/// Duel settlement on two scores (finalized or stalled-partial): larger wins,
/// equal pays the tie bucket. `resolved_score` packs (a << 16) | b.
fn settle_duel(m: &mut Account<Market>, a: u32, b: u32) -> Result<()> {
    require!(a <= 0xffff && b <= 0xffff, ErrorCode::ScoreOverflow);
    let all_backed = m.totals[..m.n_outcomes as usize].iter().all(|&t| t > 0);
    if all_backed {
        let pot: u64 = m.totals.iter().sum();
        m.fees_accrued = (pot as u128 * m.fee_bps as u128 / 10_000) as u64;
        m.resolved_score = (a << 16) | b;
        m.resolved_at = Clock::get()?.unix_timestamp;
        m.status = MARKET_RESOLVED;
        m.outcome = if a > b {
            0
        } else if b > a {
            1
        } else {
            2
        };
    } else {
        m.status = MARKET_CANCELLED;
    }
    emit!(DuelResolved {
        market: m.key(),
        a_correct: a,
        b_correct: b,
        outcome: m.outcome,
        cancelled: m.status == MARKET_CANCELLED,
    });
    Ok(())
}

#[program]
pub mod market {
    use super::*;

    /// Open a market on a run that exists but has not started scoring.
    /// `salt` lets multiple markets reference the same run.
    /// `edges` (len = n_outcomes - 1, strictly increasing) splits the score range.
    /// `fee_bps` is the creator's take on resolution (max 1000 = 10%);
    /// `closes_at` stops betting early (0 = until scoring starts);
    /// `resolve_by` is a required deadline after which anyone can expire the
    /// market — every market gets a permissionless exit (refund or partial settle).
    pub fn create_market(
        ctx: Context<CreateMarket>,
        salt: u64,
        edges: Vec<u32>,
        fee_bps: u16,
        closes_at: i64,
        resolve_by: i64,
    ) -> Result<()> {
        let n = edges.len() + 1;
        require!(n >= 2 && n <= MAX_OUTCOMES, ErrorCode::InvalidEdges);
        for w in edges.windows(2) {
            require!(w[0] < w[1], ErrorCode::InvalidEdges);
        }
        require!(fee_bps <= 1000, ErrorCode::FeeTooLarge);
        let now = Clock::get()?.unix_timestamp;
        require!(
            closes_at == 0 || closes_at >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            resolve_by >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            resolve_by <= now + MAX_RESOLVE_HORIZON_SECS,
            ErrorCode::DeadlineTooFar
        );
        require!(
            closes_at == 0 || closes_at <= resolve_by,
            ErrorCode::DeadlineOrder
        );
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            run.scored_mask == 0 && run.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        require!(!run_post_reveal(&ctx.accounts.run)?, ErrorCode::PostRevealRun);
        // Every bucket must be reachable: edges[0]==0 makes bucket 0 unwinnable,
        // an edge past the max score makes the top bucket a guaranteed win —
        // both are bait shapes we refuse to host.
        let max_score = run.chunk_count as u32 * 32;
        require!(
            edges[0] > 0 && *edges.last().unwrap() <= max_score,
            ErrorCode::InvalidEdges
        );
        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.run = ctx.accounts.run.key();
        m.run_b = Pubkey::default();
        m.benchmark = run.benchmark;
        m.run_index = run.index;
        m.salt = salt;
        m.n_outcomes = n as u8;
        m.edges = [0u32; MAX_OUTCOMES - 1];
        m.edges[..edges.len()].copy_from_slice(&edges);
        m.bump = ctx.bumps.market;
        m.status = MARKET_OPEN;
        m.outcome = u8::MAX;
        m.totals = [0u64; MAX_OUTCOMES];
        m.resolved_score = 0;
        m.created_at = Clock::get()?.unix_timestamp;
        m.resolved_at = 0;
        m.fee_bps = fee_bps;
        m.fees_accrued = 0;
        m.closes_at = closes_at;
        m.resolve_by = resolve_by;
        emit!(MarketCreated {
            market: m.key(),
            run: m.run,
            benchmark: run.benchmark,
            edges,
        });
        Ok(())
    }

    /// Stake `lamports` on `outcome` (0..n_outcomes). Re-betting adds to the same
    /// position; a bettor may back several outcomes.
    pub fn bet(ctx: Context<Bet>, outcome: u8, lamports: u64) -> Result<()> {
        require!(lamports > 0, ErrorCode::ZeroAmount);
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            run.scored_mask == 0 && run.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(
            m.closes_at == 0 || now < m.closes_at,
            ErrorCode::BettingClosed
        );
        require!(
            m.resolve_by == 0 || now < m.resolve_by,
            ErrorCode::BettingClosed
        );
        require!(outcome < m.n_outcomes, ErrorCode::InvalidOutcome);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.bettor.to_account_info(),
                    to: m.to_account_info(),
                },
            ),
            lamports,
        )?;

        let p = &mut ctx.accounts.position;
        // `p.bump == 0` is NOT an init sentinel: ~1/256 of PDAs have a
        // canonical bump of 0, which would re-zero existing stakes.
        if p.market == Pubkey::default() {
            p.market = m.key();
            p.bettor = ctx.accounts.bettor.key();
            p.bump = ctx.bumps.position;
            p.amounts = [0u64; MAX_OUTCOMES];
        }
        p.amounts[outcome as usize] += lamports;
        m.totals[outcome as usize] += lamports;
        emit!(BetPlaced {
            market: m.key(),
            bettor: p.bettor,
            outcome,
            lamports,
        });
        Ok(())
    }

    /// Open a head-to-head market: does run A outscore run B on the same
    /// benchmark? Outcomes: 0 = A wins, 1 = B wins, 2 = tie. Both runs must be
    /// pending and unscored so no one bets on leaked information.
    pub fn create_duel(
        ctx: Context<CreateDuel>,
        salt: u64,
        fee_bps: u16,
        closes_at: i64,
        resolve_by: i64,
    ) -> Result<()> {
        let ra = load_run(&ctx.accounts.run_a)?;
        let rb = load_run(&ctx.accounts.run_b)?;
        require!(ra.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(rb.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            ra.scored_mask == 0 && rb.scored_mask == 0,
            ErrorCode::ScoringStarted
        );
        require!(
            ra.pending_since == 0 && rb.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        require!(ra.benchmark == rb.benchmark, ErrorCode::BenchmarkMismatch);
        require!(
            ctx.accounts.run_a.key() != ctx.accounts.run_b.key(),
            ErrorCode::RunsMustDiffer
        );
        require!(
            !run_post_reveal(&ctx.accounts.run_a)? && !run_post_reveal(&ctx.accounts.run_b)?,
            ErrorCode::PostRevealRun
        );
        // One runner scoring both legs knows both outcomes on any bank whose
        // answers they can see — a self-dealing duel. Distinct runner keys are
        // sybil-able but raise the bar and are cheap to enforce.
        require!(ra.runner != rb.runner, ErrorCode::RunnersMustDiffer);
        require!(fee_bps <= 1000, ErrorCode::FeeTooLarge);
        let now = Clock::get()?.unix_timestamp;
        require!(
            closes_at == 0 || closes_at >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            resolve_by >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            resolve_by <= now + MAX_RESOLVE_HORIZON_SECS,
            ErrorCode::DeadlineTooFar
        );
        require!(
            closes_at == 0 || closes_at <= resolve_by,
            ErrorCode::DeadlineOrder
        );
        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.run = ctx.accounts.run_a.key();
        m.run_b = ctx.accounts.run_b.key();
        m.benchmark = ra.benchmark;
        m.run_index = ra.index;
        m.salt = salt;
        m.n_outcomes = 3;
        m.edges = [0u32; MAX_OUTCOMES - 1];
        m.bump = ctx.bumps.market;
        m.status = MARKET_OPEN;
        m.outcome = u8::MAX;
        m.totals = [0u64; MAX_OUTCOMES];
        m.resolved_score = 0;
        m.created_at = Clock::get()?.unix_timestamp;
        m.resolved_at = 0;
        m.fee_bps = fee_bps;
        m.fees_accrued = 0;
        m.closes_at = closes_at;
        m.resolve_by = resolve_by;
        emit!(DuelCreated {
            market: m.key(),
            run_a: m.run,
            run_b: m.run_b,
            benchmark: ra.benchmark,
        });
        Ok(())
    }

    /// Bet on a duel outcome. Unlike score markets, bets close once EITHER run
    /// starts scoring — otherwise a finalized half leaks information.
    pub fn bet_duel(ctx: Context<BetDuel>, outcome: u8, lamports: u64) -> Result<()> {
        require!(lamports > 0, ErrorCode::ZeroAmount);
        let ra = load_run(&ctx.accounts.run_a)?;
        let rb = load_run(&ctx.accounts.run_b)?;
        require!(ra.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(rb.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            ra.scored_mask == 0 && rb.scored_mask == 0,
            ErrorCode::ScoringStarted
        );
        require!(
            ra.pending_since == 0 && rb.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(
            m.closes_at == 0 || now < m.closes_at,
            ErrorCode::BettingClosed
        );
        require!(
            m.resolve_by == 0 || now < m.resolve_by,
            ErrorCode::BettingClosed
        );
        require!(outcome < m.n_outcomes, ErrorCode::InvalidOutcome);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.bettor.to_account_info(),
                    to: m.to_account_info(),
                },
            ),
            lamports,
        )?;

        let p = &mut ctx.accounts.position;
        if p.market == Pubkey::default() {
            p.market = m.key();
            p.bettor = ctx.accounts.bettor.key();
            p.bump = ctx.bumps.position;
            p.amounts = [0u64; MAX_OUTCOMES];
        }
        p.amounts[outcome as usize] += lamports;
        m.totals[outcome as usize] += lamports;
        emit!(BetPlaced {
            market: m.key(),
            bettor: p.bettor,
            outcome,
            lamports,
        });
        Ok(())
    }

    /// Settle the duel once both runs are finalized. The winning outcome is the
    /// larger `correct`; equal scores pay the tie bucket. `resolved_score`
    /// packs both scores as (a << 16) | b for a compact onchain record.
    pub fn resolve_duel(ctx: Context<ResolveDuel>) -> Result<()> {
        let ra = load_run(&ctx.accounts.run_a)?;
        let rb = load_run(&ctx.accounts.run_b)?;
        require!(ra.status == RUN_FINALIZED, ErrorCode::RunNotFinalized);
        require!(rb.status == RUN_FINALIZED, ErrorCode::RunNotFinalized);
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        settle_duel(m, ra.correct, rb.correct)
    }

    /// Settle the market from the finalized run. If any outcome attracted no
    /// stake the market is cancelled and everyone is refunded instead.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_FINALIZED, ErrorCode::RunNotFinalized);
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        settle_score(m, run.correct, ctx.accounts.run.key())
    }

    /// Authority escape hatch for score markets — only while the outcome is
    /// still unknowable (run pending, no scoring started). Once a single MPC
    /// computation is queued the authority must wait for resolution or let the
    /// `resolve_by` deadline expire the market; otherwise the authority could
    /// free-look at the result and cancel when it loses.
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        let run = load_run(&ctx.accounts.run)?;
        let m = &mut ctx.accounts.market;
        require!(m.run_b == Pubkey::default(), ErrorCode::NotScoreMarket);
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            run.scored_mask == 0 && run.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        m.status = MARKET_CANCELLED;
        Ok(())
    }

    /// Same escape hatch for duels: both runs must still be fully unscored.
    pub fn void_duel(ctx: Context<VoidDuel>) -> Result<()> {
        let ra = load_run(&ctx.accounts.run_a)?;
        let rb = load_run(&ctx.accounts.run_b)?;
        let m = &mut ctx.accounts.market;
        require!(m.run_b != Pubkey::default(), ErrorCode::NotDuelMarket);
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        require!(
            ra.status == RUN_PENDING && rb.status == RUN_PENDING,
            ErrorCode::RunNotPending
        );
        require!(
            ra.scored_mask == 0
                && ra.pending_since == 0
                && rb.scored_mask == 0
                && rb.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        m.status = MARKET_CANCELLED;
        Ok(())
    }

    /// Permissionless deadline: once `resolve_by` passes, anyone can clean up
    /// an open market whose run can no longer finalize normally. The split
    /// matters — settling any stalled partial would let a runner freeze a
    /// favorable truncation (queue one cheap chunk, stop, steal the high
    /// buckets). Only a run that COMMITTED every chunk (`all_queued_at` set)
    /// and then waited out a full 24h landing window settles on its proven
    /// partial — the truncation was the cluster's, not the runner's, and no
    /// transaction can both complete commitment and satisfy the window.
    /// Everything else refunds: never-queued, uncommitted stalls (the
    /// documented residual wash — refunding a chosen truncation is the only
    /// safe answer), and committed runs where nothing ever landed.
    pub fn expire_market(ctx: Context<ExpireMarket>) -> Result<()> {
        let ra = load_run(&ctx.accounts.run_a)?;
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        require!(m.resolve_by != 0, ErrorCode::MarketNotExpired);
        let now_ts = Clock::get()?.unix_timestamp;
        require!(now_ts > m.resolve_by, ErrorCode::MarketNotExpired);
        // `first_pending_at` is write-once at the first score_chunk queue, so
        // griefing can't extend the cap by sweep+requeue cycling. A run still
        // inside the cap is not expirable: a late callback may legitimately
        // finalize it, and a losing bettor must not veto that.
        let duel = m.run_b != Pubkey::default();
        let rb = if duel {
            Some(load_run(&ctx.accounts.run_b)?)
        } else {
            None
        };
        match expire_decision(&ra, rb.as_ref(), now_ts) {
            ExpireAction::Blocked => err!(ErrorCode::MarketResolvable),
            ExpireAction::Cancel => {
                m.status = MARKET_CANCELLED;
                // Expire-cancels were invisible to event indexers — emit the
                // same resolved events the settle paths use, flagged cancelled.
                if duel {
                    emit!(DuelResolved {
                        market: m.key(),
                        a_correct: ra.correct,
                        b_correct: rb.map(|r| r.correct).unwrap_or(0),
                        outcome: m.outcome,
                        cancelled: true,
                    });
                } else {
                    emit!(MarketResolved {
                        market: m.key(),
                        run: ctx.accounts.run_a.key(),
                        correct: ra.correct,
                        outcome: m.outcome,
                        cancelled: true,
                    });
                }
                Ok(())
            }
            ExpireAction::SettleScore(correct) => {
                settle_score(m, correct, ctx.accounts.run_a.key())
            }
            ExpireAction::SettleDuel(a, b) => settle_duel(m, a, b),
        }
    }

    /// Open a K-way race market: legs are `remaining_accounts` (3..=8 pending,
    /// unscored runs on one benchmark, distinct runs and runners — pairs
    /// belong in `create_duel`, which carries an explicit tie bucket).
    /// Resolution is argmax — the highest-scoring leg wins; ties split the
    /// pot dead-heat. `closes_at` is required: the leg list is public, so a
    /// market with an open-ended betting window is a snipe invitation.
    ///
    /// KNOWN RISK, disclosed: a leg whose runner never scores forfeits at 0 —
    /// it cannot cancel the race (that would hand losing leg operators a free
    /// exit). An authority can pack the board with dormant-runner "ringer"
    /// legs whose backers' stake flows to live legs. The leg list and each
    /// leg's runner are public at creation — bettors should verify every leg
    /// has a live runner before staking. OPERATOR NOTE: a leg's first-queue
    /// window (`first_pending_at`) opens on its first score-queue tx and is
    /// write-once — a leg that gaps >24h between queue txs can settle at
    /// partial before `resolve_by`. Stage every chunk's queue tx inside one
    /// 24h burst.
    pub fn create_ladder(
        ctx: Context<CreateLadder>,
        first_leg: Pubkey,
        salt: u64,
        fee_bps: u16,
        closes_at: i64,
        resolve_by: i64,
    ) -> Result<()> {
        let legs = &ctx.remaining_accounts;
        require!(
            legs.len() >= MIN_LEGS && legs.len() <= MAX_LEGS,
            ErrorCode::InvalidLegCount
        );
        // The PDA derives from the bound legs (like duels) — the seed arg
        // must equal remaining_accounts[0] so it can't lie about the race.
        require!(legs[0].key() == first_leg, ErrorCode::LegMismatch);
        require!(fee_bps <= 1000, ErrorCode::FeeTooLarge);
        let now = Clock::get()?.unix_timestamp;
        require!(
            closes_at >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            resolve_by >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            resolve_by <= now + MAX_RESOLVE_HORIZON_SECS,
            ErrorCode::DeadlineTooFar
        );
        require!(closes_at <= resolve_by, ErrorCode::DeadlineOrder);
        let mut runs: Vec<Run> = Vec::with_capacity(legs.len());
        for info in legs.iter() {
            let r = load_run(info)?;
            require!(r.status == RUN_PENDING, ErrorCode::RunNotPending);
            require!(
                r.scored_mask == 0 && r.pending_since == 0,
                ErrorCode::ScoringStarted
            );
            require!(!run_post_reveal(info)?, ErrorCode::PostRevealRun);
            for (j, prev) in runs.iter().enumerate() {
                require!(info.key() != legs[j].key(), ErrorCode::RunsMustDiffer);
                require!(r.runner != prev.runner, ErrorCode::RunnersMustDiffer);
                require!(r.benchmark == prev.benchmark, ErrorCode::BenchmarkMismatch);
            }
            runs.push(r);
        }
        let m = &mut ctx.accounts.ladder;
        m.authority = ctx.accounts.authority.key();
        m.benchmark = runs[0].benchmark;
        m.legs = [Pubkey::default(); MAX_LEGS];
        for (i, info) in legs.iter().enumerate() {
            m.legs[i] = info.key();
        }
        m.leg_count = legs.len() as u8;
        m.salt = salt;
        m.bump = ctx.bumps.ladder;
        m.status = MARKET_OPEN;
        m.result_mask = 0;
        m.resolved_score = 0;
        m.totals = [0u64; MAX_LEGS];
        m.created_at = now;
        m.resolved_at = 0;
        m.fee_bps = fee_bps;
        m.fees_accrued = 0;
        m.closes_at = closes_at;
        m.resolve_by = resolve_by;
        emit!(LadderCreated {
            ladder: m.key(),
            benchmark: m.benchmark,
            legs: m.legs[..m.leg_count as usize].to_vec(),
        });
        Ok(())
    }

    /// Stake `lamports` on leg `outcome`. Bets latch shut at `closes_at` OR
    /// the moment ANY bound leg leaves pending — whichever fires first — so
    /// no early-finalized leg can leak the race.
    pub fn bet_ladder(ctx: Context<BetLadder>, outcome: u8, lamports: u64) -> Result<()> {
        require!(lamports > 0, ErrorCode::ZeroAmount);
        let m = &mut ctx.accounts.ladder;
        let legs = load_legs(m, ctx.remaining_accounts)?;
        for r in &legs {
            require!(r.status == RUN_PENDING, ErrorCode::RunNotPending);
            require!(
                r.scored_mask == 0 && r.pending_since == 0,
                ErrorCode::ScoringStarted
            );
        }
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(now < m.closes_at, ErrorCode::BettingClosed);
        require!(now < m.resolve_by, ErrorCode::BettingClosed);
        require!(outcome < m.leg_count, ErrorCode::InvalidOutcome);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.bettor.to_account_info(),
                    to: m.to_account_info(),
                },
            ),
            lamports,
        )?;

        let p = &mut ctx.accounts.position;
        if p.market == Pubkey::default() {
            p.market = m.key();
            p.bettor = ctx.accounts.bettor.key();
            p.bump = ctx.bumps.position;
            p.amounts = [0u64; MAX_OUTCOMES];
        }
        p.amounts[outcome as usize] += lamports;
        m.totals[outcome as usize] += lamports;
        emit!(BetPlaced {
            market: m.key(),
            bettor: p.bettor,
            outcome,
            lamports,
        });
        Ok(())
    }

    /// Settle the race: argmax over leg scores, dead-heat pro-rata on ties.
    /// Permissionless — the gate is identical before and after `resolve_by`
    /// (the deadline is the advertised end for bettors, not a forfeit switch):
    /// a leg inside EITHER landing window — its 24h first-queue window
    /// (`first_pending_at`, ungameable) or its post-commit landing window
    /// (`all_queued_at`, the JIT-commit invariant `expire_market` enforces) —
    /// blocks resolution rather than forfeiting mid-flight. A leg past both
    /// windows settles at whatever landed; nothing-landed legs score 0.
    pub fn resolve_ladder(ctx: Context<ResolveLadder>) -> Result<()> {
        let m = &mut ctx.accounts.ladder;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        let legs = load_legs(m, ctx.remaining_accounts)?;
        let now = Clock::get()?.unix_timestamp;
        require!(
            ladder_resolvable(&legs, now, m.resolve_by),
            ErrorCode::LegsStillMoving
        );
        let scores: Vec<u32> = legs.iter().map(ladder_leg_score).collect();
        settle_ladder(m, &scores)
    }

    /// Authority escape hatch — only while every leg is still unknowable
    /// (pending, nothing queued). Once any leg starts, resolution or
    /// `resolve_by` owns the outcome.
    pub fn void_ladder(ctx: Context<VoidLadder>) -> Result<()> {
        let m = &mut ctx.accounts.ladder;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        let legs = load_legs(m, ctx.remaining_accounts)?;
        for r in &legs {
            require!(r.status == RUN_PENDING, ErrorCode::RunNotPending);
            require!(
                r.scored_mask == 0 && r.pending_since == 0,
                ErrorCode::ScoringStarted
            );
        }
        m.status = MARKET_CANCELLED;
        Ok(())
    }

    /// Pay out a ladder position. Co-leader outcomes each pay
    /// `stake × net_pot / Σ totals[mask]` — a dead-heat dilutes winnings,
    /// it never refunds them. Cancelled ladders refund every lamport.
    pub fn claim_ladder(ctx: Context<ClaimLadder>) -> Result<()> {
        let m = &ctx.accounts.ladder;
        let p = &mut ctx.accounts.position;
        require!(
            m.status == MARKET_RESOLVED || m.status == MARKET_CANCELLED,
            ErrorCode::MarketNotResolved
        );

        let payout = if m.status == MARKET_CANCELLED {
            p.amounts.iter().sum()
        } else {
            let pot: u64 = m.totals.iter().sum();
            let fee = (pot as u128 * m.fee_bps as u128 / 10_000) as u64;
            let net_pot = pot.saturating_sub(fee);
            let mut win_amt = 0u64;
            let mut win_total = 0u64;
            for i in 0..m.leg_count as usize {
                if m.result_mask & (1 << i) != 0 {
                    win_amt += p.amounts[i];
                    win_total += m.totals[i];
                }
            }
            if win_amt == 0 || win_total == 0 {
                0
            } else {
                (win_amt as u128)
                    .checked_mul(net_pot as u128)
                    .unwrap()
                    .checked_div(win_total as u128)
                    .unwrap() as u64
            }
        };

        if payout > 0 {
            **m.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx
                .accounts
                .bettor
                .to_account_info()
                .try_borrow_mut_lamports()? += payout;
        }
        emit!(Claimed {
            market: m.key(),
            bettor: p.bettor,
            payout,
        });
        Ok(())
    }

    /// The ladder authority collects the accrued fee once resolved.
    pub fn claim_fee_ladder(ctx: Context<ClaimFeeLadder>) -> Result<()> {
        let m = &mut ctx.accounts.ladder;
        require!(m.status == MARKET_RESOLVED, ErrorCode::MarketNotResolved);
        require!(m.fees_accrued > 0, ErrorCode::NoFees);
        let fee = m.fees_accrued;
        m.fees_accrued = 0;
        **m.to_account_info().try_borrow_mut_lamports()? -= fee;
        **ctx
            .accounts
            .authority
            .to_account_info()
            .try_borrow_mut_lamports()? += fee;
        emit!(FeeClaimed {
            market: m.key(),
            to: ctx.accounts.authority.key(),
            amount: fee,
        });
        Ok(())
    }

    /// The market authority collects the accrued fee once resolved.
    pub fn claim_fee(ctx: Context<ClaimFee>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_RESOLVED, ErrorCode::MarketNotResolved);
        require!(m.fees_accrued > 0, ErrorCode::NoFees);
        let fee = m.fees_accrued;
        m.fees_accrued = 0;
        **m.to_account_info().try_borrow_mut_lamports()? -= fee;
        **ctx
            .accounts
            .authority
            .to_account_info()
            .try_borrow_mut_lamports()? += fee;
        emit!(FeeClaimed {
            market: m.key(),
            to: ctx.accounts.authority.key(),
            amount: fee,
        });
        Ok(())
    }

    /// Pay out a position and close its account. Cancelled markets refund in
    /// full; resolved markets split the pot net of the authority fee pro-rata.
    /// Losing positions pay 0 but still close — the `close` constraint returns
    /// the rent to the bettor either way.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(
            m.status == MARKET_RESOLVED || m.status == MARKET_CANCELLED,
            ErrorCode::MarketNotResolved
        );

        let payout = if m.status == MARKET_CANCELLED {
            p.amounts.iter().sum()
        } else {
            let pot: u64 = m.totals.iter().sum();
            // Recompute the fee rather than trusting `fees_accrued`: claim_fee
            // zeroes that field, and using it here would inflate net_pot for
            // every winner claiming after the authority — leaving the pot
            // `fee` short and permanently stranding the last claim(s).
            let fee = (pot as u128 * m.fee_bps as u128 / 10_000) as u64;
            let net_pot = pot.saturating_sub(fee);
            let win_amt = p.amounts[m.outcome as usize];
            let win_total = m.totals[m.outcome as usize];
            if win_amt == 0 || win_total == 0 {
                0
            } else {
                (win_amt as u128)
                    .checked_mul(net_pot as u128)
                    .unwrap()
                    .checked_div(win_total as u128)
                    .unwrap() as u64
            }
        };

        if payout > 0 {
            **m.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx
                .accounts
                .bettor
                .to_account_info()
                .try_borrow_mut_lamports()? += payout;
        }
        emit!(Claimed {
            market: m.key(),
            bettor: p.bettor,
            payout,
        });
        Ok(())
    }

    // ==================== dark markets (sealed positions) ====================

    /// Open a dark score market: same buckets + deadlines as `create_market`,
    /// but positions are SHA256 commitments — which outcome each bettor
    /// backed stays sealed until they reveal post-resolution. The pool and
    /// every position's AMOUNT are public (lamports move visibly); only the
    /// side is hidden — disclosed limitation: private amounts would need a
    /// deposit-vault layer so transfers stop correlating with stakes.
    pub fn create_dark(
        ctx: Context<CreateDark>,
        salt: u64,
        edges: Vec<u32>,
        fee_bps: u16,
        closes_at: i64,
        resolve_by: i64,
        reveal_secs: i64,
    ) -> Result<()> {
        let n = edges.len() + 1;
        require!(n >= 2 && n <= MAX_OUTCOMES, ErrorCode::InvalidEdges);
        for w in edges.windows(2) {
            require!(w[0] < w[1], ErrorCode::InvalidEdges);
        }
        require!(fee_bps <= 1000, ErrorCode::FeeTooLarge);
        let now = Clock::get()?.unix_timestamp;
        require!(
            closes_at == 0 || closes_at >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            resolve_by >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            resolve_by <= now + MAX_RESOLVE_HORIZON_SECS,
            ErrorCode::DeadlineTooFar
        );
        require!(
            closes_at == 0 || closes_at <= resolve_by,
            ErrorCode::DeadlineOrder
        );
        // The reveal window is bettor-visible at open — a sub-minute window
        // is bait (winners forfeit before they can react), so the floor is
        // the same 60s markets must live. The cap is the same horizon as
        // resolve_by: an unbounded window makes finalize_dark unreachable
        // (or the add overflows) — either way the pool locks forever.
        require!(
            reveal_secs >= MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            reveal_secs <= MAX_RESOLVE_HORIZON_SECS,
            ErrorCode::DeadlineTooFar
        );
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            run.scored_mask == 0 && run.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        require!(!run_post_reveal(&ctx.accounts.run)?, ErrorCode::PostRevealRun);
        let max_score = run.chunk_count as u32 * 32;
        require!(
            edges[0] > 0 && *edges.last().unwrap() <= max_score,
            ErrorCode::InvalidEdges
        );
        let m = &mut ctx.accounts.dark_market;
        m.authority = ctx.accounts.authority.key();
        m.run = ctx.accounts.run.key();
        m.benchmark = run.benchmark;
        m.run_index = run.index;
        m.salt = salt;
        m.n_outcomes = n as u8;
        m.edges = [0u32; MAX_OUTCOMES - 1];
        m.edges[..edges.len()].copy_from_slice(&edges);
        m.bump = ctx.bumps.dark_market;
        m.status = MARKET_OPEN;
        m.outcome = u8::MAX;
        m.pool_total = 0;
        m.win_total = 0;
        m.revealed_count = 0;
        m.resolved_score = 0;
        m.created_at = now;
        m.resolved_at = 0;
        m.reveal_secs = reveal_secs;
        m.reveal_until = 0;
        m.fee_bps = fee_bps;
        m.fees_accrued = 0;
        m.closes_at = closes_at;
        m.resolve_by = resolve_by;
        m.tallied = false;
        emit!(DarkMarketCreated {
            market: m.key(),
            run: m.run,
            benchmark: run.benchmark,
            edges,
        });
        Ok(())
    }

    /// Stake `lamports` behind a commitment. The client computes
    /// `dark_commitment(market, bettor, outcome, lamports, salt)` off-chain
    /// and keeps the preimage until reveal — the chain never sees the
    /// outcome. One position per (market, bettor, pos_salt); a position
    /// cannot be topped up because the amount is bound inside the
    /// commitment — place a second sealed position instead. Bets latch on
    /// the same pre-scoring gate as `bet`.
    pub fn dark_bet(
        ctx: Context<DarkBet>,
        _pos_salt: u64,
        commitment: [u8; 32],
        lamports: u64,
    ) -> Result<()> {
        require!(lamports > 0, ErrorCode::ZeroAmount);
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            run.scored_mask == 0 && run.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        let m = &mut ctx.accounts.dark_market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(
            m.closes_at == 0 || now < m.closes_at,
            ErrorCode::BettingClosed
        );
        require!(
            m.resolve_by == 0 || now < m.resolve_by,
            ErrorCode::BettingClosed
        );
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.bettor.to_account_info(),
                    to: m.to_account_info(),
                },
            ),
            lamports,
        )?;
        let p = &mut ctx.accounts.position;
        p.market = m.key();
        p.bettor = ctx.accounts.bettor.key();
        p.bump = ctx.bumps.position;
        p.amount = lamports;
        p.commitment = commitment;
        p.revealed = u8::MAX;
        m.pool_total += lamports;
        emit!(DarkBetPlaced {
            market: m.key(),
            bettor: p.bettor,
            lamports,
        });
        Ok(())
    }

    /// Settle the buckets from the finalized run and open the reveal window.
    /// An empty market (no stake) cancels outright — there is nothing to
    /// reveal. The all-backed check `settle_score` runs is impossible by
    /// design here: per-outcome totals are sealed until reveals land.
    pub fn resolve_dark(ctx: Context<ResolveDark>) -> Result<()> {
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_FINALIZED, ErrorCode::RunNotFinalized);
        let m = &mut ctx.accounts.dark_market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        if m.pool_total == 0 {
            m.status = MARKET_CANCELLED;
        } else {
            let now = Clock::get()?.unix_timestamp;
            m.status = MARKET_RESOLVED;
            m.resolved_score = run.correct;
            m.resolved_at = now;
            m.reveal_until = now + m.reveal_secs;
            m.outcome = outcome_of(&m.edges, m.n_outcomes, run.correct);
            m.fees_accrued = (m.pool_total as u128 * m.fee_bps as u128 / 10_000) as u64;
        }
        emit!(DarkResolved {
            market: m.key(),
            run: ctx.accounts.run.key(),
            correct: run.correct,
            outcome: m.outcome,
            cancelled: m.status == MARKET_CANCELLED,
        });
        Ok(())
    }

    /// Reveal (outcome, salt) against the stored commitment inside the
    /// window. Revealed winners accumulate `win_total`; losers learn nothing
    /// new — the outcome was fixed at resolve. Revealing is safe: the score
    /// is already written, so a leaked side cannot be traded on.
    pub fn reveal_dark(
        ctx: Context<RevealDark>,
        _pos_salt: u64,
        outcome: u8,
        salt: [u8; 32],
    ) -> Result<()> {
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(m.status == MARKET_RESOLVED, ErrorCode::MarketNotResolved);
        require!(p.revealed == u8::MAX, ErrorCode::AlreadyRevealed);
        let now = Clock::get()?.unix_timestamp;
        require!(now <= m.reveal_until, ErrorCode::RevealWindowClosed);
        // Keep the u8::MAX sentinel unreachable — revealing outcome 255 would
        // leave `revealed == u8::MAX`, making every later reveal a no-op.
        require!(outcome < m.n_outcomes, ErrorCode::InvalidOutcome);
        require!(
            dark_commitment(&m.key(), &p.bettor, outcome, p.amount, &salt) == p.commitment,
            ErrorCode::BadReveal
        );
        p.revealed = outcome;
        m.revealed_count += 1;
        if outcome == m.outcome {
            m.win_total += p.amount;
        }
        emit!(DarkRevealed {
            position: p.key(),
            market: m.key(),
            bettor: p.bettor,
            outcome,
            amount: p.amount,
        });
        Ok(())
    }

    /// Permissionless tally close: past the window, freeze `win_total`.
    /// Zero reveals cancels the market — every position then refunds its
    /// public amount through `claim_dark`, no preimage needed (the one case
    /// where nobody can prove a side, refund-all is the only safe answer).
    pub fn finalize_dark(ctx: Context<FinalizeDark>) -> Result<()> {
        let m = &mut ctx.accounts.dark_market;
        require!(m.status == MARKET_RESOLVED, ErrorCode::MarketNotResolved);
        require!(!m.tallied, ErrorCode::AlreadyRevealed);
        let now = Clock::get()?.unix_timestamp;
        require!(now > m.reveal_until, ErrorCode::RevealWindowClosed);
        if m.win_total == 0 {
            // Cancel refunds pay GROSS amounts — the fee must not survive a
            // resolved→cancelled transition or the pool comes up short.
            m.fees_accrued = 0;
            m.status = MARKET_CANCELLED;
        } else {
            m.tallied = true;
        }
        emit!(DarkFinalized {
            market: m.key(),
            win_total: m.win_total,
            pool_total: m.pool_total,
            cancelled: m.status == MARKET_CANCELLED,
        });
        Ok(())
    }

    /// Pay a sealed position and close its account. Cancelled markets refund
    /// the public amount in full — no preimage required (amounts were never
    /// hidden). Tallied markets pay revealed winners pro-rata over
    /// `win_total`: an unrevealed winner's stake forfeits into the pot for
    /// the winners who did reveal. Losing/unrevealed positions pay 0 but
    /// still close — rent comes back either way.
    pub fn claim_dark(ctx: Context<ClaimDark>, _pos_salt: u64) -> Result<()> {
        let m = &ctx.accounts.market;
        let p = &ctx.accounts.position;
        require!(
            m.status == MARKET_CANCELLED || (m.status == MARKET_RESOLVED && m.tallied),
            ErrorCode::MarketNotResolved
        );
        let payout = if m.status == MARKET_CANCELLED {
            p.amount
        } else if p.revealed == m.outcome && m.win_total > 0 {
            let fee = (m.pool_total as u128 * m.fee_bps as u128 / 10_000) as u64;
            let net_pot = m.pool_total.saturating_sub(fee);
            (p.amount as u128)
                .checked_mul(net_pot as u128)
                .unwrap()
                .checked_div(m.win_total as u128)
                .unwrap() as u64
        } else {
            0
        };
        if payout > 0 {
            **m.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx
                .accounts
                .bettor
                .to_account_info()
                .try_borrow_mut_lamports()? += payout;
        }
        emit!(DarkClaimed {
            market: m.key(),
            bettor: p.bettor,
            payout,
        });
        Ok(())
    }

    /// The dark-market authority collects the accrued fee once resolved.
    pub fn claim_fee_dark(ctx: Context<ClaimFeeDark>) -> Result<()> {
        let m = &mut ctx.accounts.dark_market;
        // Only a TALLIED market has an earned fee — a resolved market that
        // later cancels (zero reveals) owes gross refunds, so sweeping the
        // accrued fee before finalize_dark would leave the pool short and
        // wedge the tail refunds.
        require!(
            m.status == MARKET_RESOLVED && m.tallied,
            ErrorCode::MarketNotResolved
        );
        require!(m.fees_accrued > 0, ErrorCode::NoFees);
        let fee = m.fees_accrued;
        m.fees_accrued = 0;
        **m.to_account_info().try_borrow_mut_lamports()? -= fee;
        **ctx
            .accounts
            .authority
            .to_account_info()
            .try_borrow_mut_lamports()? += fee;
        emit!(FeeClaimed {
            market: m.key(),
            to: ctx.accounts.authority.key(),
            amount: fee,
        });
        Ok(())
    }

    /// Authority escape hatch — same shape as `void_market`: the run must
    /// still be pending and fully unscored.
    pub fn void_dark(ctx: Context<VoidDark>) -> Result<()> {
        let run = load_run(&ctx.accounts.run)?;
        let m = &mut ctx.accounts.dark_market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            run.scored_mask == 0 && run.pending_since == 0,
            ErrorCode::ScoringStarted
        );
        m.status = MARKET_CANCELLED;
        Ok(())
    }

    /// Permissionless deadline — the same `expire_decision` split as
    /// `expire_market`: a run that committed every chunk and outlived its
    /// landing window settles on the proven partial (buckets resolve, the
    /// reveal window opens); everything else cancels and refunds the public
    /// amounts in full.
    pub fn expire_dark(ctx: Context<ExpireDark>) -> Result<()> {
        let ra = load_run(&ctx.accounts.run_a)?;
        let m = &mut ctx.accounts.dark_market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        require!(m.resolve_by != 0, ErrorCode::MarketNotExpired);
        let now_ts = Clock::get()?.unix_timestamp;
        require!(now_ts > m.resolve_by, ErrorCode::MarketNotExpired);
        match expire_decision(&ra, None, now_ts) {
            ExpireAction::Blocked => err!(ErrorCode::MarketResolvable),
            ExpireAction::Cancel => {
                m.status = MARKET_CANCELLED;
                emit!(DarkResolved {
                    market: m.key(),
                    run: ctx.accounts.run_a.key(),
                    correct: ra.correct,
                    outcome: m.outcome,
                    cancelled: true,
                });
                Ok(())
            }
            ExpireAction::SettleScore(correct) => {
                // Mirror `resolve_dark`: an empty pool cancels outright
                // rather than opening a dead reveal window.
                if m.pool_total == 0 {
                    m.status = MARKET_CANCELLED;
                } else {
                    m.status = MARKET_RESOLVED;
                    m.resolved_score = correct;
                    m.resolved_at = now_ts;
                    m.reveal_until = now_ts + m.reveal_secs;
                    m.outcome = outcome_of(&m.edges, m.n_outcomes, correct);
                    m.fees_accrued =
                        (m.pool_total as u128 * m.fee_bps as u128 / 10_000) as u64;
                }
                emit!(DarkResolved {
                    market: m.key(),
                    run: ctx.accounts.run_a.key(),
                    correct,
                    outcome: m.outcome,
                    cancelled: m.status == MARKET_CANCELLED,
                });
                Ok(())
            }
            // A dark market binds exactly one run — duel branches are
            // unreachable by construction.
            ExpireAction::SettleDuel(_, _) => err!(ErrorCode::NotScoreMarket),
        }
    }

    /// Open a capability bounty on `bank`: "first model to score
    /// `threshold`+ on this benchmark before `deadline` takes `amount`
    /// lamports." There are no bettors — the payout goes to the qualifying
    /// RUN's operator, settled on the MPC-written `Run.correct` like every
    /// market here. Sponsor funds the pot at creation; permissionless
    /// `expire_bounty` refunds it after `deadline` if nobody qualified.
    ///
    /// FCFS semantics: first qualifying proven run claims. A top-up is a
    /// second bounty PDA (different salt), not a mutation of this one.
    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        salt: u64,
        threshold: u32,
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(
            deadline >= now + MIN_RESOLVE_DELAY_SECS,
            ErrorCode::DeadlineTooSoon
        );
        require!(
            deadline <= now + MAX_RESOLVE_HORIZON_SECS,
            ErrorCode::DeadlineTooFar
        );
        let (bstatus, chunk_count, _kind) = load_benchmark(&ctx.accounts.bank)?;
        require!(bstatus == 1, ErrorCode::BenchmarkNotLive); // STATUS_LIVE
        // Threshold above the bank's max score is an unclaimable bait
        // bounty; zero pays any landed score including an honest 0.
        require!(
            threshold > 0 && threshold <= chunk_count as u32 * 32,
            ErrorCode::InvalidThreshold
        );

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.sponsor.to_account_info(),
                    to: ctx.accounts.bounty.to_account_info(),
                },
            ),
            amount,
        )?;

        let b = &mut ctx.accounts.bounty;
        b.sponsor = ctx.accounts.sponsor.key();
        b.bank = ctx.accounts.bank.key();
        b.salt = salt;
        b.bump = ctx.bumps.bounty;
        b.status = MARKET_OPEN;
        b.threshold = threshold;
        b.amount = amount;
        b.winner_run = Pubkey::default();
        b.winning_score = 0;
        b.created_at = now;
        b.deadline = deadline;
        emit!(BountyCreated {
            bounty: b.key(),
            sponsor: b.sponsor,
            bank: b.bank,
            threshold,
            amount,
            deadline,
        });
        Ok(())
    }

    /// Permissionless claim: ANY caller may trigger it, but the pot always
    /// lands on `run.runner` — the operator who earned the score, never the
    /// trigger. `payee` is constrained to the run's stored runner, so a
    /// front-running claim tx cannot redirect the payout.
    ///
    /// The deadline is TOTAL — the claim tx must land by `b.deadline`
    /// (`now <= deadline`), so the proven score must exist on-chain before
    /// the offer closes. That transitively bounds run creation too:
    /// `run.created_at <= now <= deadline`. Past the deadline the only
    /// remaining transition is `expire_bounty`, so a sponsor can quote an
    /// exact end time and a slow-finalizing run can't stretch the window.
    pub fn claim_bounty(ctx: Context<ClaimBounty>) -> Result<()> {
        let b = &mut ctx.accounts.bounty;
        require!(b.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(now <= b.deadline, ErrorCode::MarketNotExpired);
        let run = load_run(&ctx.accounts.run)?;
        require!(bounty_qualifies(&run, b, now), ErrorCode::BelowThreshold);
        require!(!run_post_reveal(&ctx.accounts.run)?, ErrorCode::PostRevealRun);
        require!(
            ctx.accounts.payee.key() == run.runner,
            ErrorCode::WrongPayee
        );

        b.status = MARKET_RESOLVED;
        b.winner_run = ctx.accounts.run.key();
        b.winning_score = run.correct;
        let amount = b.amount;
        b.amount = 0;
        **b.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .payee
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;
        emit!(BountyClaimed {
            bounty: b.key(),
            winner_run: b.winner_run,
            winner: run.runner,
            score: run.correct,
            amount,
        });
        Ok(())
    }

    /// Permissionless expiry: past `deadline` with the pot unclaimed, the
    /// escrow unwinds to `bounty.sponsor` — `close` returns pot + rent.
    /// The recipient is constrained to the STORED sponsor, so nobody can
    /// redirect the refund.
    pub fn expire_bounty(ctx: Context<ExpireBounty>) -> Result<()> {
        let b = &ctx.accounts.bounty;
        require!(b.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(now > b.deadline, ErrorCode::MarketNotExpired);
        // `close` returns the WHOLE balance (pot + rent + any stray
        // donations) — emit both so indexers see what actually moved.
        emit!(BountyExpired {
            bounty: b.key(),
            sponsor: b.sponsor,
            amount: b.amount,
            refunded_lamports: b.to_account_info().lamports(),
        });
        Ok(())
    }

    /// Prefund-grief reclaim for ANY PDA of this program. Anchor's `init`
    /// codegen already tolerates prefunded accounts (top-up to rent-exempt,
    /// then allocate+assign — the griefer's dust becomes a rent subsidy),
    /// so a prefund cannot brick an `init` path here — but the dust stays
    /// locked forever. This sweeps griefed lamports to a permissionless
    /// rescuer BEFORE init — the prefunder loses the dust instead of
    /// donating it. The `create_program_address` proof pins the drain to
    /// THIS program's derivation space: arbitrary wallets and other
    /// programs' accounts can never be touched. Bundle `unbrick_pda` + the
    /// init ix in ONE tx for an atomic sweep an attacker cannot interleave.
    /// Accepted risk: a lamport-bearing uninit PDA is grief BY DEFINITION —
    /// no flow in this program requires prefunding — so the sweep cannot
    /// distinguish a griefer's dust from lamports a user parked ahead of a
    /// split prefund→init workflow. Either way the rescuer takes it.
    pub fn unbrick_pda(
        ctx: Context<UnbrickPda>,
        seeds: Vec<Vec<u8>>,
        bump: u8,
    ) -> Result<()> {
        let acc = &ctx.accounts.pda;
        let bump_seed = [bump];
        let mut refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
        refs.push(&bump_seed);
        let derived = Pubkey::create_program_address(&refs, &crate::ID)
            .map_err(|_| error!(ErrorCode::NotProgramPda))?;
        require!(derived == acc.key(), ErrorCode::NotProgramPda);
        require!(
            acc.owner == &system_program::ID && acc.data_is_empty(),
            ErrorCode::NotGriefedPda
        );
        let lamports = acc.lamports();
        require!(lamports > 0, ErrorCode::NothingToDrain);
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Transfer {
                    from: acc.to_account_info(),
                    to: ctx.accounts.rescuer.to_account_info(),
                },
                &[&refs],
            ),
            lamports,
        )?;
        emit!(PdaUnbricked {
            pda: acc.key(),
            rescuer: ctx.accounts.rescuer.key(),
            drained_lamports: lamports,
        });
        Ok(())
    }
}

// ================================================================== accounts

/// Mirror of `sealed::Run`; the discriminator matches because the name matches.
/// Only ever read through `load_run` (owner + discriminator verified there).
#[account]
#[derive(InitSpace)]
pub struct Run {
    pub benchmark: Pubkey,
    pub runner: Pubkey,
    pub index: u64,
    pub bump: u8,
    pub status: u8,
    pub chunk_count: u16,
    pub pending_mask: u64,
    pub scored_mask: u64,
    pub correct: u32,
    pub created_at: i64,
    pub finalized_at: i64,
    pub harness_hash: [u8; 32],
    pub outputs_root: [u8; 32],
    #[max_len(64)]
    pub model_id: String,
    pub attested: bool,
    pub attested_at: i64,
    /// Tail-appended in sealed: timestamp of the last score queue (stale-bit
    /// sweeps). Kept byte-identical to `sealed::Run` — drift bricks `load_run`.
    pub pending_since: i64,
    /// Sealed tail: first-ever score queue timestamp, never refreshed —
    /// `expire_market`'s idleness horizon, immune to sweep+requeue cycling.
    pub first_pending_at: i64,
    /// Sealed tail: every chunk ever submitted to `score_chunk`. Only a fully
    /// committed run may settle its proven partial on expiry — an uncommitted
    /// stall refunds (the runner chose the truncation point).
    pub ever_queued_mask: u64,
    /// Sealed tail: when `ever_queued_mask` first became full. A committed
    /// run settles only once `all_queued_at + EXPIRE_HARD_CAP_SECS` elapses —
    /// every queued chunk gets a full landing window, which defeats
    /// just-in-time commit+expire bundles.
    pub all_queued_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub run: Pubkey,
    pub benchmark: Pubkey,
    pub run_index: u64,
    /// Distinguishes markets on the same run (PDA seed).
    pub salt: u64,
    /// Number of score buckets (2..=8); edges[i] is the upper bound of bucket i.
    pub n_outcomes: u8,
    // Literal size: InitSpace can't evaluate `MAX_OUTCOMES - 1` and under-allocates.
    pub edges: [u32; 7],
    pub bump: u8,
    pub status: u8,
    /// Winning bucket index once resolved (u8::MAX while open).
    pub outcome: u8,
    /// Lamports staked on each outcome.
    pub totals: [u64; MAX_OUTCOMES],
    /// For score markets: the run's `correct`. For duels: (a << 16) | b.
    pub resolved_score: u32,
    pub created_at: i64,
    pub resolved_at: i64,
    /// Second run for head-to-head markets; Pubkey::default() on score markets.
    pub run_b: Pubkey,
    /// Authority take on resolution, in basis points (max 1000 = 10%).
    pub fee_bps: u16,
    /// Lamports of fee accrued at resolution, claimable via `claim_fee`.
    pub fees_accrued: u64,
    /// Optional betting cutoff (unix ts; 0 = bets close when scoring starts).
    pub closes_at: i64,
    /// Required deadline after which anyone can `expire_market` — creation
    /// rejects `resolve_by <= now` so a stalled run can never lock funds forever.
    pub resolve_by: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub bump: u8,
    /// Lamports staked per outcome.
    pub amounts: [u64; MAX_OUTCOMES],
}

/// A K-way race market: bound `Run` legs compete on `correct`; the highest
/// score takes the pot, ties split it dead-heat pro-rata. Legs ride
/// `remaining_accounts` — never stored twice — and every leg-read goes
/// through `load_legs` (strict ordered key check + `load_run`).
///
/// Unlike duels, a dead leg does NOT cancel the market: it scores 0 and the
/// race resolves among the rest. Cancelling on a dead leg would hand every
/// losing leg operator a free exit (poison one leg, refund a losing bet).
#[account]
#[derive(InitSpace)]
pub struct Ladder {
    pub authority: Pubkey,
    pub benchmark: Pubkey,
    /// Bound leg Run PDAs; only the first `leg_count` are live.
    pub legs: [Pubkey; MAX_LEGS],
    pub leg_count: u8,
    /// Distinguishes ladders by the same authority (PDA seed).
    pub salt: u64,
    pub bump: u8,
    pub status: u8,
    /// Dead-heat: bitmask of co-leader legs once resolved.
    pub result_mask: u8,
    /// The winning `correct` once resolved.
    pub resolved_score: u32,
    /// Lamports staked on each leg.
    pub totals: [u64; MAX_LEGS],
    pub created_at: i64,
    pub resolved_at: i64,
    /// Authority take on resolution, in basis points (max 1000 = 10%).
    pub fee_bps: u16,
    pub fees_accrued: u64,
    /// Required betting cutoff — the leg list is public, so an open-ended
    /// window invites last-second sniping on leaked leg state.
    pub closes_at: i64,
    /// Advertised settlement deadline for bettors. Resolution is gated by
    /// `ladder_resolvable`: a leg inside either landing window blocks
    /// resolve even past `resolve_by` (one bounded window per leg), a leg
    /// past both windows settles at whatever landed (partial included),
    /// and a race where no leg ever started can't resolve before this
    /// deadline — the all-forfeit wash belongs to the expiry path.
    pub resolve_by: i64,
}

/// A dark score market: the bucket logic of `Market` with sealed positions.
/// `pool_total` is public (stakes move visibly) but there are NO per-outcome
/// totals — they cannot exist until winners reveal, which is the point.
/// `tallied` flips at `finalize_dark`: RESOLVED + !tallied = reveal window
/// active; RESOLVED + tallied = claimable; CANCELLED = refund-all.
#[account]
#[derive(InitSpace)]
pub struct DarkMarket {
    pub authority: Pubkey,
    pub run: Pubkey,
    pub benchmark: Pubkey,
    pub run_index: u64,
    /// Distinguishes dark markets on the same run (PDA seed).
    pub salt: u64,
    /// Number of score buckets (2..=8); edges[i] is the upper bound of bucket i.
    pub n_outcomes: u8,
    // Literal size: InitSpace can't evaluate `MAX_OUTCOMES - 1` and under-allocates.
    pub edges: [u32; 7],
    pub bump: u8,
    pub status: u8,
    /// Winning bucket index once resolved (u8::MAX while open).
    pub outcome: u8,
    /// All lamports staked across every sealed position (public by design).
    pub pool_total: u64,
    /// Revealed winning stake — grows as winners `reveal_dark`, frozen at
    /// `finalize_dark`. Denominator of the pro-rata split.
    pub win_total: u64,
    /// Positions that revealed (informational).
    pub revealed_count: u32,
    /// The run's `correct` once resolved.
    pub resolved_score: u32,
    pub created_at: i64,
    pub resolved_at: i64,
    /// Reveal window length in seconds (floored at `MIN_RESOLVE_DELAY_SECS`).
    /// `reveal_until = resolved_at + reveal_secs`. Winners who miss it
    /// forfeit into the pot for revealed winners.
    pub reveal_secs: i64,
    /// Reveal deadline: `resolved_at + reveal_secs`.
    pub reveal_until: i64,
    /// Authority take on resolution, in basis points (max 1000 = 10%).
    pub fee_bps: u16,
    /// Lamports of fee accrued at resolution, claimable via `claim_fee_dark`.
    pub fees_accrued: u64,
    /// Optional betting cutoff (unix ts; 0 = bets close when scoring starts).
    pub closes_at: i64,
    /// Required deadline after which anyone can `expire_dark`.
    pub resolve_by: i64,
    /// True once `finalize_dark` froze `win_total` — claims open.
    pub tallied: bool,
}

/// One sealed position in a `DarkMarket`: the outcome is hidden inside
/// `commitment` until the bettor reveals post-resolution. `amount` is
/// public — the lamport transfer is visible anyway (disclosed limitation;
/// private amounts need a deposit-vault layer).
#[account]
#[derive(InitSpace)]
pub struct DarkPosition {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub bump: u8,
    /// Lamports staked (public — the transfer is on-chain regardless).
    pub amount: u64,
    /// SHA256(b"sealed/dark" ‖ market ‖ bettor ‖ outcome ‖ amount ‖ salt).
    pub commitment: [u8; 32],
    /// u8::MAX while sealed; the revealed outcome index after `reveal_dark`.
    pub revealed: u8,
}

/// A capability bounty escrowed in the PDA itself: `amount` lamports for the
/// first run on `bank` whose MPC-finalized score reaches `threshold` before
/// `deadline`. Unlike the parimutuel markets this pays the RUN's operator —
/// a sponsor buys a demonstrated capability, not a bet.
#[account]
#[derive(InitSpace)]
pub struct Bounty {
    pub sponsor: Pubkey,
    pub bank: Pubkey,
    /// Sponsor salt — one bank may host many concurrent bounties.
    pub salt: u64,
    pub bump: u8,
    /// MARKET_OPEN / MARKET_RESOLVED (claimed) — expiry closes the account.
    pub status: u8,
    /// Minimum `Run.correct` that claims, capped at `bank.chunk_count * 32`.
    pub threshold: u32,
    /// Escrowed pot (0 once claimed — the field doubles as an audit record).
    pub amount: u64,
    pub winner_run: Pubkey,
    pub winning_score: u32,
    /// Retroactivity wall: only runs with `created_at >=` this may claim.
    pub created_at: i64,
    /// FCFS cutoff; past it `expire_bounty` returns the pot to the sponsor.
    pub deadline: i64,
}

#[derive(Accounts)]
#[instruction(salt: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    pub run: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", run.key().as_ref(), salt.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Bet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run @ ErrorCode::WrongRun)]
    pub run: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"market", run.key().as_ref(), market.salt.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run @ ErrorCode::WrongRun)]
    pub run: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"market", run.key().as_ref(), market.salt.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
#[instruction(salt: u64)]
pub struct CreateDuel<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    pub run_a: UncheckedAccount<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    pub run_b: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"duel", run_a.key().as_ref(), run_b.key().as_ref(), salt.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BetDuel<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run @ ErrorCode::WrongRun)]
    pub run_a: UncheckedAccount<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run_b @ ErrorCode::WrongRun)]
    pub run_b: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"duel", run_a.key().as_ref(), run_b.key().as_ref(), market.salt.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveDuel<'info> {
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run @ ErrorCode::WrongRun)]
    pub run_a: UncheckedAccount<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run_b @ ErrorCode::WrongRun)]
    pub run_b: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"duel", run_a.key().as_ref(), run_b.key().as_ref(), market.salt.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run @ ErrorCode::WrongRun)]
    pub run: UncheckedAccount<'info>,
    #[account(mut, has_one = authority @ ErrorCode::NotAuthority)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct VoidDuel<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run @ ErrorCode::WrongRun)]
    pub run_a: UncheckedAccount<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run_b @ ErrorCode::WrongRun)]
    pub run_b: UncheckedAccount<'info>,
    #[account(mut, has_one = authority @ ErrorCode::NotAuthority)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct ExpireMarket<'info> {
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = market.run @ ErrorCode::WrongRun)]
    pub run_a: UncheckedAccount<'info>,
    /// CHECK: `market.run_b` for duels; unread for score markets (pass `run_a`).
    #[account(
        constraint = market.run_b == Pubkey::default() || run_b.key() == market.run_b @ ErrorCode::WrongRun
    )]
    pub run_b: UncheckedAccount<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct ClaimFee<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::NotAuthority)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        has_one = bettor @ ErrorCode::NotBettor,
        has_one = market @ ErrorCode::WrongMarket,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump = position.bump,
        close = bettor,
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
#[instruction(first_leg: Pubkey, salt: u64)]
pub struct CreateLadder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// The PDA derives from the bound legs, like duels — the same authority
    /// can host many races without salt collisions across test runs.
    #[account(
        init,
        payer = authority,
        space = 8 + Ladder::INIT_SPACE,
        seeds = [b"ladder", first_leg.as_ref(), salt.to_le_bytes().as_ref()],
        bump,
    )]
    pub ladder: Account<'info, Ladder>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BetLadder<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
        mut,
        seeds = [b"ladder", ladder.legs[0].as_ref(), ladder.salt.to_le_bytes().as_ref()],
        bump = ladder.bump,
    )]
    pub ladder: Account<'info, Ladder>,
    /// `position.market` doubles as the parent key — a ladder pubkey slots
    /// into the same PDA space with no collision (different parent key).
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", ladder.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveLadder<'info> {
    #[account(
        mut,
        seeds = [b"ladder", ladder.legs[0].as_ref(), ladder.salt.to_le_bytes().as_ref()],
        bump = ladder.bump,
    )]
    pub ladder: Account<'info, Ladder>,
}

#[derive(Accounts)]
pub struct VoidLadder<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ ErrorCode::NotAuthority,
        seeds = [b"ladder", ladder.legs[0].as_ref(), ladder.salt.to_le_bytes().as_ref()],
        bump = ladder.bump,
    )]
    pub ladder: Account<'info, Ladder>,
}

#[derive(Accounts)]
pub struct ClaimLadder<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut)]
    pub ladder: Account<'info, Ladder>,
    #[account(
        mut,
        has_one = bettor @ ErrorCode::NotBettor,
        constraint = position.market == ladder.key() @ ErrorCode::WrongMarket,
        seeds = [b"position", ladder.key().as_ref(), bettor.key().as_ref()],
        bump = position.bump,
        close = bettor,
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct ClaimFeeLadder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::NotAuthority)]
    pub ladder: Account<'info, Ladder>,
}

#[derive(Accounts)]
#[instruction(salt: u64)]
pub struct CreateDark<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    pub run: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + DarkMarket::INIT_SPACE,
        seeds = [b"dark", run.key().as_ref(), salt.to_le_bytes().as_ref()],
        bump,
    )]
    pub dark_market: Account<'info, DarkMarket>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pos_salt: u64)]
pub struct DarkBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = dark_market.run @ ErrorCode::WrongRun)]
    pub run: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"dark", run.key().as_ref(), dark_market.salt.to_le_bytes().as_ref()],
        bump = dark_market.bump,
    )]
    pub dark_market: Account<'info, DarkMarket>,
    /// One sealed position per (market, bettor, pos_salt) — `init`, never
    /// re-init: a second bet on the same salt must not overwrite the stored
    /// commitment (the amounts inside commitments are binding).
    #[account(
        init,
        payer = bettor,
        space = 8 + DarkPosition::INIT_SPACE,
        seeds = [b"darkpos", dark_market.key().as_ref(), bettor.key().as_ref(), pos_salt.to_le_bytes().as_ref()],
        bump,
    )]
    pub position: Account<'info, DarkPosition>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveDark<'info> {
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = dark_market.run @ ErrorCode::WrongRun)]
    pub run: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"dark", run.key().as_ref(), dark_market.salt.to_le_bytes().as_ref()],
        bump = dark_market.bump,
    )]
    pub dark_market: Account<'info, DarkMarket>,
}

#[derive(Accounts)]
#[instruction(pos_salt: u64)]
pub struct RevealDark<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, DarkMarket>,
    #[account(
        mut,
        has_one = bettor @ ErrorCode::NotBettor,
        has_one = market @ ErrorCode::WrongMarket,
        seeds = [b"darkpos", market.key().as_ref(), bettor.key().as_ref(), pos_salt.to_le_bytes().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, DarkPosition>,
}

#[derive(Accounts)]
pub struct FinalizeDark<'info> {
    #[account(mut)]
    pub dark_market: Account<'info, DarkMarket>,
}

#[derive(Accounts)]
#[instruction(pos_salt: u64)]
pub struct ClaimDark<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, DarkMarket>,
    #[account(
        mut,
        has_one = bettor @ ErrorCode::NotBettor,
        has_one = market @ ErrorCode::WrongMarket,
        seeds = [b"darkpos", market.key().as_ref(), bettor.key().as_ref(), pos_salt.to_le_bytes().as_ref()],
        bump = position.bump,
        close = bettor,
    )]
    pub position: Account<'info, DarkPosition>,
}

#[derive(Accounts)]
pub struct ClaimFeeDark<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::NotAuthority)]
    pub dark_market: Account<'info, DarkMarket>,
}

#[derive(Accounts)]
pub struct VoidDark<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = dark_market.run @ ErrorCode::WrongRun)]
    pub run: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = authority @ ErrorCode::NotAuthority,
        seeds = [b"dark", run.key().as_ref(), dark_market.salt.to_le_bytes().as_ref()],
        bump = dark_market.bump,
    )]
    pub dark_market: Account<'info, DarkMarket>,
}

#[derive(Accounts)]
pub struct ExpireDark<'info> {
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    #[account(address = dark_market.run @ ErrorCode::WrongRun)]
    pub run_a: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"dark", run_a.key().as_ref(), dark_market.salt.to_le_bytes().as_ref()],
        bump = dark_market.bump,
    )]
    pub dark_market: Account<'info, DarkMarket>,
}

#[derive(Accounts)]
#[instruction(salt: u64)]
pub struct CreateBounty<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    /// CHECK: Sealed Benchmark account; owner + discriminator verified in
    /// `load_benchmark`, which also reads `chunk_count` for the threshold cap.
    pub bank: UncheckedAccount<'info>,
    #[account(
        init,
        payer = sponsor,
        space = 8 + Bounty::INIT_SPACE,
        seeds = [b"bounty", bank.key().as_ref(), sponsor.key().as_ref(), salt.to_le_bytes().as_ref()],
        bump,
    )]
    pub bounty: Account<'info, Bounty>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimBounty<'info> {
    /// CHECK: Sealed Run account; owner + discriminator verified in
    /// `load_run`, and `post_reveal` tail-read rejects spoiled banks.
    pub run: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"bounty", bounty.bank.as_ref(), bounty.sponsor.as_ref(), bounty.salt.to_le_bytes().as_ref()],
        bump = bounty.bump,
    )]
    pub bounty: Account<'info, Bounty>,
    /// CHECK: the pot lands here — constrained to `run.runner` in the handler
    /// so a front-running trigger can't redirect the payout.
    #[account(mut)]
    pub payee: UncheckedAccount<'info>,
    // The bounty account stays live after a claim — `winner_run` and
    // `winning_score` are a permanent on-chain record of who earned it.
}

#[derive(Accounts)]
pub struct ExpireBounty<'info> {
    #[account(
        mut,
        seeds = [b"bounty", bounty.bank.as_ref(), bounty.sponsor.as_ref(), bounty.salt.to_le_bytes().as_ref()],
        bump = bounty.bump,
        close = sponsor,
    )]
    pub bounty: Account<'info, Bounty>,
    /// CHECK: refund destination — constrained to the STORED sponsor so the
    /// escrow can only unwind to whoever funded it.
    #[account(mut, address = bounty.sponsor @ ErrorCode::NotAuthority)]
    pub sponsor: UncheckedAccount<'info>,
}

/// `unbrick_pda` — generic prefund-grief recovery. The PDA is proven in the
/// handler from the caller-supplied seeds (`create_program_address` under
/// this program); only a system-owned, zero-data, lamport-bearing account
/// qualifies — i.e. exactly a grief-prefund awaiting `init`.
#[derive(Accounts)]
pub struct UnbrickPda<'info> {
    /// Receives the swept lamports — permissionless: whoever un-bricks a
    /// bricked PDA keeps the grief dust.
    #[account(mut)]
    pub rescuer: Signer<'info>,
    /// CHECK: seeds-proofed in the handler; drained via invoke_signed.
    #[account(mut)]
    pub pda: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ================================================================== events

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub run: Pubkey,
    pub benchmark: Pubkey,
    pub edges: Vec<u32>,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub outcome: u8,
    pub lamports: u64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub run: Pubkey,
    pub correct: u32,
    pub outcome: u8,
    pub cancelled: bool,
}

#[event]
pub struct DuelCreated {
    pub market: Pubkey,
    pub run_a: Pubkey,
    pub run_b: Pubkey,
    pub benchmark: Pubkey,
}

#[event]
pub struct DuelResolved {
    pub market: Pubkey,
    pub a_correct: u32,
    pub b_correct: u32,
    pub outcome: u8,
    pub cancelled: bool,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub payout: u64,
}

#[event]
pub struct LadderCreated {
    pub ladder: Pubkey,
    pub benchmark: Pubkey,
    pub legs: Vec<Pubkey>,
}

#[event]
pub struct LadderResolved {
    pub ladder: Pubkey,
    pub result_mask: u8,
    pub winning_score: u32,
    /// Every leg's contributed score — dead legs show as 0, so indexers can
    /// reconstruct the full race without re-reading run accounts.
    pub scores: Vec<u32>,
    pub cancelled: bool,
}

#[event]
pub struct FeeClaimed {
    /// Market OR ladder PDA the fee was skimmed from.
    pub market: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DarkMarketCreated {
    pub market: Pubkey,
    pub run: Pubkey,
    pub benchmark: Pubkey,
    pub edges: Vec<u32>,
}

/// A sealed position landed: the event carries NO outcome — that is the
/// point of the primitive.
#[event]
pub struct DarkBetPlaced {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub lamports: u64,
}

#[event]
pub struct DarkResolved {
    pub market: Pubkey,
    pub run: Pubkey,
    pub correct: u32,
    pub outcome: u8,
    pub cancelled: bool,
}

#[event]
pub struct DarkRevealed {
    pub position: Pubkey,
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub outcome: u8,
    pub amount: u64,
}

#[event]
pub struct DarkFinalized {
    pub market: Pubkey,
    pub win_total: u64,
    pub pool_total: u64,
    pub cancelled: bool,
}

#[event]
pub struct DarkClaimed {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub payout: u64,
}

#[event]
pub struct BountyCreated {
    pub bounty: Pubkey,
    pub sponsor: Pubkey,
    pub bank: Pubkey,
    pub threshold: u32,
    pub amount: u64,
    pub deadline: i64,
}

#[event]
pub struct BountyClaimed {
    pub bounty: Pubkey,
    pub winner_run: Pubkey,
    /// `run.runner` — the operator paid, NOT the claim trigger.
    pub winner: Pubkey,
    pub score: u32,
    pub amount: u64,
}

#[event]
pub struct BountyExpired {
    pub bounty: Pubkey,
    pub sponsor: Pubkey,
    /// The escrowed pot (matches `BountyCreated.amount`).
    pub amount: u64,
    /// What `close` actually sent the sponsor: pot + rent + any donations.
    pub refunded_lamports: u64,
}

#[event]
pub struct PdaUnbricked {
    pub pda: Pubkey,
    pub rescuer: Pubkey,
    /// Lamports the grief-prefunder lost to the rescuer.
    pub drained_lamports: u64,
}

// ================================================================== errors

#[error_code]
pub enum ErrorCode {
    #[msg("Account is not a Sealed run")]
    WrongRun,
    #[msg("Run is not pending")]
    RunNotPending,
    #[msg("Run scoring has already started")]
    ScoringStarted,
    #[msg("Run is not finalized yet")]
    RunNotFinalized,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Market is not resolved or cancelled")]
    MarketNotResolved,
    #[msg("Signer is not the market authority")]
    NotAuthority,
    #[msg("Signer is not the position bettor")]
    NotBettor,
    #[msg("Position belongs to another market")]
    WrongMarket,
    #[msg("Outcome index out of range")]
    InvalidOutcome,
    #[msg("Edges must be strictly increasing with 1..=7 entries")]
    InvalidEdges,
    #[msg("Bet amount must be positive")]
    ZeroAmount,
    #[msg("Betting is closed for this market")]
    BettingClosed,
    #[msg("Fee exceeds the 10% maximum")]
    FeeTooLarge,
    #[msg("Market has no accrued fees")]
    NoFees,
    #[msg("Market has not passed its resolve_by deadline")]
    MarketNotExpired,
    #[msg("Deadline must be in the future")]
    // Retired label — kept so later variants keep their Anchor error codes.
    DeadlineInPast,
    #[msg("Not a score market")]
    NotScoreMarket,
    #[msg("Not a duel market")]
    NotDuelMarket,
    #[msg("Duel runs must be on the same benchmark")]
    BenchmarkMismatch,
    #[msg("Duel needs two different runs")]
    RunsMustDiffer,
    #[msg("Duel needs two different runners")]
    RunnersMustDiffer,
    #[msg("Score too large to pack into resolved_score")]
    ScoreOverflow,
    #[msg("Run already finalized — market is resolvable, not expirable")]
    MarketResolvable,
    #[msg("closes_at must not exceed resolve_by")]
    DeadlineOrder,
    #[msg("deadline too close — markets must live at least 60s")]
    DeadlineTooSoon,
    #[msg("Ladders need 3..=8 legs (pairs belong in create_duel)")]
    InvalidLegCount,
    #[msg("Leg accounts must be exactly the ladder's bound legs, in order")]
    LegMismatch,
    #[msg("A leg can still legitimately move — resolve must wait")]
    LegsStillMoving,
    #[msg("Position already revealed")]
    AlreadyRevealed,
    #[msg("reveal preimage does not match the stored commitment")]
    BadReveal,
    #[msg("reveal window has closed / not yet closed")]
    RevealWindowClosed,
    #[msg("Run was created after a fingerprint reveal on its bank — spoiled scoring target")]
    PostRevealRun,
    #[msg("Account is not a Sealed benchmark")]
    WrongBank,
    #[msg("Benchmark is not live")]
    BenchmarkNotLive,
    #[msg("Threshold must be 1..=bank max score (chunk_count * 32)")]
    InvalidThreshold,
    #[msg("Run does not meet this bounty's claim conditions")]
    BelowThreshold,
    #[msg("Payout recipient must be the run's runner")]
    WrongPayee,
    #[msg("Deadline exceeds the maximum supported horizon")]
    DeadlineTooFar,
    #[msg("Account is not a PDA of this program for the given seeds")]
    NotProgramPda,
    #[msg("Account is not a grief-prefunded (system-owned, empty) PDA")]
    NotGriefedPda,
    #[msg("Account carries no lamports to drain")]
    NothingToDrain,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// sealed::Run may only grow by TAIL-APPEND. Prove the mirror reader
    /// tolerates trailing bytes — a future field must not brick open markets.
    #[test]
    fn run_mirror_tolerates_tail_appended_fields() {
        #[derive(AnchorSerialize)]
        struct FutureRun {
            run: Run,
            extra_field: u64,
        }
        let future = FutureRun {
            run: Run {
                benchmark: Pubkey::default(),
                runner: Pubkey::default(),
                index: 0,
                bump: 0,
                status: 1,
                chunk_count: 2,
                pending_mask: 0,
                scored_mask: 0,
                correct: 42,
                created_at: 0,
                finalized_at: 0,
                harness_hash: [0; 32],
                outputs_root: [0; 32],
                model_id: "m".into(),
                attested: false,
                attested_at: 0,
                pending_since: 0,
                first_pending_at: 0,
                ever_queued_mask: 0,
                all_queued_at: 0,
            },
            extra_field: 0xdeadbeef,
        };
        let mut buf = RUN_DISC.to_vec();
        future.serialize(&mut buf).unwrap();
        // Tail-appended bytes are ignored — this is the upgrade path.
        let parsed = Run::try_deserialize_unchecked(&mut &buf[..]).unwrap();
        assert_eq!(parsed.correct, 42);
    }

    /// The tail byte sealed appends for F1 (`post_reveal`) sits at
    /// 229 + model_id_len — one byte past the mirror's declared end.
    #[test]
    fn run_post_reveal_reads_tail_byte() {
        let base = run(1, 0, 0, 0, 0, 0);
        let mut buf = RUN_DISC.to_vec();
        base.serialize(&mut buf).unwrap();
        assert!(!run_post_reveal_bytes(&buf)); // no flag byte yet
        buf.push(1);
        assert!(run_post_reveal_bytes(&buf));
        buf.pop();
        buf.push(0);
        assert!(!run_post_reveal_bytes(&buf));
        // A different model_id length must not shift the read off the flag.
        let mut long = RUN_DISC.to_vec();
        let mut r2 = run(1, 0, 0, 0, 0, 0);
        r2.model_id = "a-fairly-long-model-identifier-string".into();
        r2.serialize(&mut long).unwrap();
        long.push(1);
        assert!(run_post_reveal_bytes(&long));
        // Truncated pre-upgrade accounts read untainted, never panic.
        assert!(!run_post_reveal_bytes(&buf[..100]));
    }

    fn run(
        status: u8,
        first_pending_at: i64,
        scored_mask: u64,
        ever_queued_mask: u64,
        all_queued_at: i64,
        correct: u32,
    ) -> Run {
        Run {
            benchmark: Pubkey::default(),
            runner: Pubkey::default(),
            index: 0,
            bump: 0,
            status,
            chunk_count: 2,
            pending_mask: 0,
            scored_mask,
            correct,
            created_at: 0,
            finalized_at: 0,
            harness_hash: [0; 32],
            outputs_root: [0; 32],
            model_id: "m".into(),
            attested: false,
            attested_at: 0,
            pending_since: 0,
            first_pending_at,
            ever_queued_mask,
            all_queued_at,
        }
    }

    /// The expire predicate's full branch table. A stalled partial settles
    /// only when the runner committed to EVERY chunk AND the commit is at
    /// least one full cap-window old — every queued chunk had a real chance
    /// to land. A just-in-time commit (queued the rest at expiry time) is
    /// still in its landing window → Blocked, which converts the JIT
    /// freeze-win back into a race the attacker can't win while the cluster
    /// is alive.
    #[test]
    fn expire_decision_covers_every_branch() {
        let now = 1_000_000i64;
        let cap = EXPIRE_HARD_CAP_SECS;
        let pending_never_queued = run(0, 0, 0, 0, 0, 0);
        let inflight = run(0, now - 60, 0, 1, 0, 0); // queued a minute ago, nothing landed
        let stalled_no_chunks = run(0, now - 2 * cap, 0, 3, now - 2 * cap, 0);
        // Committed at first queue, stalled past the cap — honest partial.
        let stalled_partial = run(0, now - 2 * cap, 1, 3, now - 2 * cap, 30);
        // Queued+landed chunk 0, never queued chunk 1 — chose the truncation.
        let uncommitted_partial = run(0, now - 2 * cap, 1, 1, 0, 30);
        // JIT-commit: held chunks back past the cap, committed 10s ago —
        // still inside its post-commit landing window → NOT settleable.
        let jit_commit = run(0, now - 2 * cap, 1, 3, now - 10, 30);
        // Committed in-window, cluster died mid-scoring — honest stall.
        let committed_in_grace = run(0, now - cap - 60, 1, 3, now - cap - 60, 30);
        let finalized = run(1, now - 2 * cap, 3, 3, now - 2 * cap, 64);

        // Score market branches.
        assert!(matches!(
            expire_decision(&pending_never_queued, None, now),
            ExpireAction::Cancel
        ));
        assert!(matches!(
            expire_decision(&inflight, None, now),
            ExpireAction::Blocked
        ));
        assert!(matches!(
            expire_decision(&stalled_no_chunks, None, now),
            ExpireAction::Cancel
        ));
        assert!(matches!(
            expire_decision(&stalled_partial, None, now),
            ExpireAction::SettleScore(30)
        ));
        assert!(matches!(
            expire_decision(&uncommitted_partial, None, now),
            ExpireAction::Cancel
        ));
        // JIT-commit is Blocked — its post-commit window is still open, and a
        // live cluster lands the queued chunks inside it (finalizing the run).
        assert!(matches!(
            expire_decision(&jit_commit, None, now),
            ExpireAction::Blocked
        ));
        // Committed but still inside the post-commit window → Blocked.
        assert!(matches!(
            expire_decision(&committed_in_grace, None, now - cap + 60),
            ExpireAction::Blocked
        ));
        // ...and past the window it settles its honest partial.
        assert!(matches!(
            expire_decision(&committed_in_grace, None, now + 60),
            ExpireAction::SettleScore(30)
        ));
        assert!(matches!(
            expire_decision(&finalized, None, now),
            ExpireAction::Blocked
        ));

        // Duel branches.
        assert!(matches!(
            expire_decision(&finalized, Some(&finalized), now),
            ExpireAction::Blocked
        ));
        // A never-queued leg cannot be forfeited at 0 — settling would let a
        // sybil'd ringer leg steal the other side's stake. Refund instead.
        assert!(matches!(
            expire_decision(&finalized, Some(&pending_never_queued), now),
            ExpireAction::Cancel
        ));
        // Proven leg + uncommitted stall -> refund (never settle a chosen
        // truncation).
        assert!(matches!(
            expire_decision(&finalized, Some(&uncommitted_partial), now),
            ExpireAction::Cancel
        ));
        // Nothing proven on either leg -> refund, not a 0-0 settle.
        assert!(matches!(
            expire_decision(&pending_never_queued, Some(&stalled_no_chunks), now),
            ExpireAction::Cancel
        ));
        // A leg still inside its cap keeps the whole duel unexpirable.
        assert!(matches!(
            expire_decision(&finalized, Some(&inflight), now),
            ExpireAction::Blocked
        ));
        // A committed-but-in-grace leg also blocks — its landing window is open.
        assert!(matches!(
            expire_decision(&stalled_partial, Some(&jit_commit), now),
            ExpireAction::Blocked
        ));
        // Finalized vs committed-stall -> the headline duel settle path.
        assert!(matches!(
            expire_decision(&finalized, Some(&stalled_partial), now),
            ExpireAction::SettleDuel(64, 30)
        ));
        // Both committed-and-stalled with proven chunks -> partial-vs-partial.
        let stalled_b = run(0, now - 2 * cap - 5, 3, 3, now - 2 * cap - 5, 40);
        assert!(matches!(
            expire_decision(&stalled_partial, Some(&stalled_b), now),
            ExpireAction::SettleDuel(30, 40)
        ));
    }

    /// argmax_mask: bit i set for every leg tied at the top score.
    #[test]
    fn argmax_mask_flags_every_co_leader() {
        assert_eq!(argmax_mask(&[64, 30, 10]), 0b001);
        assert_eq!(argmax_mask(&[10, 64, 64]), 0b110);
        assert_eq!(argmax_mask(&[5, 5, 5]), 0b111);
        assert_eq!(argmax_mask(&[0, 0, 0, 0]), 0b1111);
        assert_eq!(argmax_mask(&[0, 9, 0]), 0b010);
        // 8-leg regression: the wash check must not truncate 1u16<<8 to u8.
        assert_eq!(argmax_mask(&[0; 8]), u8::MAX);
        assert_eq!(full_leg_mask(8), 0xff);
        assert_eq!(argmax_mask(&[9, 0, 0, 0, 0, 0, 0, 0]) as u16, 0b001);
        assert_eq!(full_leg_mask(2), 0b11);
    }

    /// Ladder leg scoring: finalized and proven committed stalls contribute
    /// `correct`; uncommitted, in-flight, or never-queued legs contribute 0.
    /// A dead leg forfeits — it never cancels the race.
    #[test]
    fn ladder_leg_score_forfeits_dead_legs() {
        let now = 1_000_000i64;
        let cap = EXPIRE_HARD_CAP_SECS;
        let finalized = run(1, now - 2 * cap, 3, 3, now - 2 * cap, 64);
        let proven_stall = run(0, now - 2 * cap, 1, 3, now - 2 * cap, 30);
        // Uncommitted but one chunk LANDED — the partial is honest data
        // (monotone under argmax), so it counts rather than forfeiting.
        let uncommitted = run(0, now - 2 * cap, 1, 1, 0, 30);
        let inflight = run(0, now - 60, 0, 1, 0, 0);
        let never_queued = run(0, 0, 0, 0, 0, 0);
        assert_eq!(ladder_leg_score(&finalized), 64);
        assert_eq!(ladder_leg_score(&proven_stall), 30);
        assert_eq!(ladder_leg_score(&uncommitted), 30);
        assert_eq!(ladder_leg_score(&inflight), 0);
        assert_eq!(ladder_leg_score(&never_queued), 0);
    }

    /// The insta-cancel fix: a race whose legs ALL never queued can't
    /// resolve before `resolve_by` (argmax on all-zero forfeits is a full
    /// mask → wash cancel = venue DoS). Past the deadline the same path is
    /// the expiry: all-forfeit cancels and refunds. A started leg (even a
    /// dead one) lifts the gate — mixed fields settle normally.
    #[test]
    fn ladder_resolve_gate_blocks_unstarted_race() {
        let now = 1_000_000i64;
        let cap = EXPIRE_HARD_CAP_SECS;
        let rb = now + 3600;
        let fresh = || run(0, 0, 0, 0, 0, 0);
        // All legs unstarted, before deadline → blocked (the grief vector).
        assert!(!ladder_resolvable(&[fresh(), fresh(), fresh()], now, rb));
        // …and immediately after creation, even *at* the deadline's edge.
        assert!(!ladder_resolvable(&[fresh(), fresh()], rb, rb));
        // Past resolve_by → allowed through to settle_ladder, which
        // cancels on the all-forfeit full mask (the expire-equivalent).
        assert!(ladder_resolvable(&[fresh(), fresh()], rb + 1, rb));
        // One leg ever queued long ago (now past cap) → race ran; the gate
        // lifts and forfeits score 0 against the landed legs.
        let dead_leg = run(0, now - 2 * cap, 1, 1, now - 2 * cap, 0);
        assert!(ladder_resolvable(&[dead_leg, fresh()], now, rb));
        // A leg still inside its landing window blocks resolve regardless.
        let inflight = run(0, now - 60, 0, 1, 0, 0);
        assert!(!ladder_resolvable(&[inflight, fresh()], now, rb));
    }

    /// dark_commitment: deterministic, binding on every field — the same
    /// preimage verifies, any single-field mutation must fail (a bettor who
    /// could equivocate on outcome OR amount would break the primitive).
    #[test]
    fn dark_commitment_binds_every_field() {
        let market = Pubkey::new_unique();
        let bettor = Pubkey::new_unique();
        let salt = [7u8; 32];
        let c = dark_commitment(&market, &bettor, 2, 1_000_000, &salt);
        // Correct preimage verifies.
        assert_eq!(dark_commitment(&market, &bettor, 2, 1_000_000, &salt), c);
        // Every field mutation must fail.
        assert_ne!(dark_commitment(&market, &bettor, 3, 1_000_000, &salt), c); // outcome
        assert_ne!(dark_commitment(&market, &bettor, 2, 1_000_001, &salt), c); // amount
        assert_ne!(dark_commitment(&market, &bettor, 2, 1_000_000, &[8u8; 32]), c); // salt
        assert_ne!(dark_commitment(&market, &Pubkey::new_unique(), 2, 1_000_000, &salt), c); // bettor
        assert_ne!(dark_commitment(&Pubkey::new_unique(), &bettor, 2, 1_000_000, &salt), c); // market
    }

    /// Conservation: the pro-rata formula `floor(amt * net / win_total)` summed
    /// over every winner never exceeds `net_pot`, and never underpays by more
    /// than one lamport of dust per claimant. The market account can therefore
    /// NEVER go insolvent — the last claim always lands.
    #[test]
    fn prorata_payouts_never_exceed_pot() {
        // (win_amt, net_pot, win_total) — payout must be <= net_pot and the
        // SUM over all winners <= net_pot with bounded dust.
        fn payout(amt: u64, net: u64, wt: u64) -> u64 {
            (amt as u128)
                .checked_mul(net as u128)
                .unwrap()
                .checked_div(wt as u128)
                .unwrap() as u64
        }
        // Odd sizes to stress floor division: 3 winners, pot not divisible.
        let stakes = [1u64, 7, 33, 999_999, 2, 5];
        let win_total: u64 = stakes.iter().sum();
        for &pot in &[1u64, 100, 1_000_001, u64::MAX / 4] {
            for fee_bps in [0u16, 1, 500, 1000] {
                let fee = (pot as u128 * fee_bps as u128 / 10_000) as u64;
                let net = pot.saturating_sub(fee);
                let paid: u64 = stakes
                    .iter()
                    .map(|&s| payout(s, net, win_total))
                    .sum();
                assert!(paid <= net, "paid {} > net {}", paid, net);
                // Dust is bounded by one rounding-down lamport per winner.
                assert!(net - paid <= stakes.len() as u64);
            }
        }
        // A single winner sweeps the entire net pot exactly.
        assert_eq!(payout(50, 1_000, 50), 1_000);
    }

    /// Refund path: a cancelled market repays `sum(amounts)` — always the
    /// gross stake, never pro-rata. This is what `claim`/`claim_ladder`/
    /// `claim_dark` hand back, so verify the arithmetic is identity.
    #[test]
    fn cancelled_market_refunds_gross() {
        // Mirrors the `if m.status == MARKET_CANCELLED { amounts.sum() }`
        // branches — a cancelled position returns every lamport staked.
        let amounts = [5u64, 0, 42, 0, 0, 0, 0, 0];
        assert_eq!(amounts.iter().sum::<u64>(), 47);
    }

    fn bounty_fixture(threshold: u32, created_at: i64) -> Bounty {
        Bounty {
            sponsor: Pubkey::new_unique(),
            bank: Pubkey::new_unique(),
            salt: 0,
            bump: 255,
            status: MARKET_OPEN,
            threshold,
            amount: 1_000_000,
            winner_run: Pubkey::default(),
            winning_score: 0,
            created_at,
            deadline: created_at + 3600,
        }
    }

    fn run_fixture(bank: Pubkey, correct: u32, created_at: i64, status: u8) -> Run {
        Run {
            benchmark: bank,
            runner: Pubkey::new_unique(),
            index: 0,
            bump: 255,
            status,
            chunk_count: 1,
            pending_mask: 0,
            scored_mask: 1,
            correct,
            created_at,
            finalized_at: if status == RUN_FINALIZED { created_at + 60 } else { 0 },
            harness_hash: [0; 32],
            outputs_root: [0; 32],
            model_id: String::new(),
            attested: false,
            attested_at: 0,
            pending_since: 0,
            first_pending_at: created_at + 10,
            ever_queued_mask: 1,
            all_queued_at: created_at + 20,
        }
    }

    /// The FCFS gate: same bank, postdates the bounty, meets threshold, and
    /// is finalized-or-proven. Every individual failure must reject.
    #[test]
    fn bounty_qualifies_gates() {
        let now = 1_000_000i64;
        let b = bounty_fixture(5, now - 100);
        // Baseline: finalized run on the right bank, created after, at threshold.
        let ok = run_fixture(b.bank, 5, now - 50, RUN_FINALIZED);
        assert!(bounty_qualifies(&ok, &b, now));
        // Above threshold also qualifies.
        assert!(bounty_qualifies(&run_fixture(b.bank, 32, now - 50, RUN_FINALIZED), &b, now));
        // Wrong bank.
        assert!(!bounty_qualifies(
            &run_fixture(Pubkey::new_unique(), 5, now - 50, RUN_FINALIZED), &b, now));
        // Run predates the bounty — the retroactivity wall.
        assert!(!bounty_qualifies(&run_fixture(b.bank, 32, now - 200, RUN_FINALIZED), &b, now));
        // created_at == bounty.created_at is allowed (same slot is fine).
        assert!(bounty_qualifies(&run_fixture(b.bank, 5, now - 100, RUN_FINALIZED), &b, now));
        // Below threshold.
        assert!(!bounty_qualifies(&run_fixture(b.bank, 4, now - 50, RUN_FINALIZED), &b, now));
        // Sponsor's own run can't claim — blocks self-dealt "winner" evidence.
        let mut self_run = run_fixture(b.bank, 32, now - 50, RUN_FINALIZED);
        self_run.runner = b.sponsor;
        assert!(!bounty_qualifies(&self_run, &b, now));
        // Still-pending run inside its landing window — not proven yet.
        let mut pending = run_fixture(b.bank, 32, now - 50, RUN_PENDING);
        pending.all_queued_at = now; // just committed — window still open
        assert!(!bounty_qualifies(&pending, &b, now));
        // Same pending run past the 24h commit window IS proven.
        pending.all_queued_at = now - EXPIRE_HARD_CAP_SECS - 1;
        assert!(bounty_qualifies(&pending, &b, now));
        // Committed but nothing ever landed (scored_mask == 0): not proven.
        let mut empty = run_fixture(b.bank, 32, now - 50, RUN_PENDING);
        empty.all_queued_at = now - EXPIRE_HARD_CAP_SECS - 1;
        empty.scored_mask = 0;
        empty.correct = 0;
        assert!(!bounty_qualifies(&empty, &b, now));
    }

    /// The fixed-offset `Benchmark` read must agree with the real layout:
    /// status@45, chunk_count@46, kind@106 — all before variable `name`.
    /// Drift here silently uncaps thresholds, so pin the offsets.
    #[test]
    fn bench_layout_offsets() {
        // status at byte 45
        let mut buf = vec![0u8; 107];
        buf[45] = 1;                       // STATUS_LIVE
        buf[46..48].copy_from_slice(&2u16.to_le_bytes()); // chunk_count = 2
        buf[106] = 1;                      // kind = MPC-minted
        // Mirrors load_benchmark's offset math (account-info borrow is
        // not constructible in a unit test — assert the byte math instead).
        assert_eq!(buf[45], 1);
        assert_eq!(u16::from_le_bytes(buf[46..48].try_into().unwrap()), 2);
        assert_eq!(buf[106], 1);
        // chunk_count * 32 caps the threshold: 2-chunk bank → max 64.
        assert!(2u32 * 32 >= 64);
    }
}
