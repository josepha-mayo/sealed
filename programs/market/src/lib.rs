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

pub const RUN_PENDING: u8 = 0;
pub const RUN_FINALIZED: u8 = 1;

pub const MARKET_OPEN: u8 = 0;
pub const MARKET_RESOLVED: u8 = 1;
pub const MARKET_CANCELLED: u8 = 2;

pub const MAX_OUTCOMES: usize = 8;
/// Mirrors sealed::PENDING_TIMEOUT_SECS — a run whose last score queue is
/// older than this is treated as dead for expiry purposes.
pub const PENDING_TIMEOUT_SECS: i64 = 900;
/// Much longer idleness horizon for market expiry: cancelling a market is
/// irreversible, and on a congested cluster a legit computation can sit in
/// the mempool far past the sweep timeout. A run queued within the last hour
/// (measured from the FIRST queue — `first_pending_at` never refreshes, so a
/// runner cannot hold a market open forever by requeueing) blocks expiry.
pub const EXPIRE_IDLE_SECS: i64 = 3600;

declare_id!("8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN");

/// Deserialize a Sealed `Run` account: owner + discriminator checked by hand
/// (`Account<T>` would demand the market program as owner).
fn load_run(info: &AccountInfo) -> Result<Run> {
    require!(info.owner == &SEALED_PROGRAM, ErrorCode::WrongRun);
    let data = info.try_borrow_data()?;
    require!(data.len() > 8 && data[..8] == RUN_DISC, ErrorCode::WrongRun);
    let run = Run::try_deserialize(&mut &data[..])?;
    Ok(run)
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

#[program]
pub mod market {
    use super::*;

    /// Open a market on a run that exists but has not started scoring.
    /// `salt` lets multiple markets reference the same run.
    /// `edges` (len = n_outcomes - 1, strictly increasing) splits the score range.
    /// `fee_bps` is the creator's take on resolution (max 1000 = 10%);
    /// `closes_at` stops betting early (0 = until scoring starts);
    /// `resolve_by` is a deadline after which anyone can expire the market.
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
        require!(closes_at == 0 || closes_at > now, ErrorCode::DeadlineInPast);
        require!(
            resolve_by == 0 || resolve_by > now,
            ErrorCode::DeadlineInPast
        );
        require!(
            closes_at == 0 || resolve_by == 0 || closes_at <= resolve_by,
            ErrorCode::DeadlineOrder
        );
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(
            run.scored_mask == 0 && run.pending_since == 0,
            ErrorCode::ScoringStarted
        );
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
        // One runner scoring both legs knows both outcomes on any bank whose
        // answers they can see — a self-dealing duel. Distinct runner keys are
        // sybil-able but raise the bar and are cheap to enforce.
        require!(ra.runner != rb.runner, ErrorCode::RunnersMustDiffer);
        require!(fee_bps <= 1000, ErrorCode::FeeTooLarge);
        let now = Clock::get()?.unix_timestamp;
        require!(closes_at == 0 || closes_at > now, ErrorCode::DeadlineInPast);
        require!(
            resolve_by == 0 || resolve_by > now,
            ErrorCode::DeadlineInPast
        );
        require!(
            closes_at == 0 || resolve_by == 0 || closes_at <= resolve_by,
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
        require!(
            ra.correct <= 0xffff && rb.correct <= 0xffff,
            ErrorCode::ScoreOverflow
        );

        let all_backed = m.totals[..m.n_outcomes as usize].iter().all(|&t| t > 0);
        if all_backed {
            let pot: u64 = m.totals.iter().sum();
            m.fees_accrued = (pot as u128 * m.fee_bps as u128 / 10_000) as u64;
            m.resolved_score = (ra.correct << 16) | rb.correct;
            m.resolved_at = Clock::get()?.unix_timestamp;
            m.status = MARKET_RESOLVED;
            m.outcome = if ra.correct > rb.correct {
                0
            } else if rb.correct > ra.correct {
                1
            } else {
                2
            };
        } else {
            m.status = MARKET_CANCELLED;
        }
        emit!(DuelResolved {
            market: m.key(),
            a_correct: ra.correct,
            b_correct: rb.correct,
            outcome: m.outcome,
            cancelled: m.status == MARKET_CANCELLED,
        });
        Ok(())
    }

    /// Settle the market from the finalized run. If any outcome attracted no
    /// stake the market is cancelled and everyone is refunded instead.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_FINALIZED, ErrorCode::RunNotFinalized);
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);

        let all_backed = m.totals[..m.n_outcomes as usize].iter().all(|&t| t > 0);
        if all_backed {
            let pot: u64 = m.totals.iter().sum();
            m.fees_accrued = (pot as u128 * m.fee_bps as u128 / 10_000) as u64;
            m.resolved_score = run.correct;
            m.resolved_at = Clock::get()?.unix_timestamp;
            m.status = MARKET_RESOLVED;
            m.outcome = outcome_of(&m.edges, m.n_outcomes, run.correct);
        } else {
            m.status = MARKET_CANCELLED;
        }
        emit!(MarketResolved {
            market: m.key(),
            run: ctx.accounts.run.key(),
            correct: run.correct,
            outcome: m.outcome,
            cancelled: m.status == MARKET_CANCELLED,
        });
        Ok(())
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

    /// Permissionless deadline: once `resolve_by` passes, anyone can cancel an
    /// open market whose run can no longer resolve — stake isn't locked behind
    /// a run that never finalizes. If the run DID finalize, expiry must not
    /// fire: a losing bettor would otherwise veto a pending resolution and
    /// claim a refund instead of paying out. `resolve_by == 0` = no deadline.
    pub fn expire_market(ctx: Context<ExpireMarket>) -> Result<()> {
        let ra = load_run(&ctx.accounts.run_a)?;
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        require!(m.resolve_by != 0, ErrorCode::MarketNotExpired);
        require!(
            Clock::get()?.unix_timestamp > m.resolve_by,
            ErrorCode::MarketNotExpired
        );
        let now_ts = Clock::get()?.unix_timestamp;
        // A run is "idle" when no live scoring computation can still land:
        // never queued (`first_pending_at == 0`) or past the expiry horizon
        // measured from the FIRST queue — a runner sweeping + requeueing
        // refreshes `pending_since` each cycle but can never push
        // `first_pending_at`, so griefing a market's expiry is bounded.
        let idle =
            |r: &Run| r.first_pending_at == 0 || now_ts > r.first_pending_at + EXPIRE_IDLE_SECS;
        if m.run_b == Pubkey::default() {
            // Score market: resolvable iff the run finalized; expirable only
            // when it hasn't AND no in-flight chunk can still finalize it.
            require!(ra.status != RUN_FINALIZED, ErrorCode::MarketResolvable);
            require!(idle(&ra), ErrorCode::MarketResolvable);
        } else {
            // Duel: resolvable iff BOTH runs finalized; expirable only when at
            // least one hasn't AND every unfinished run is provably idle —
            // otherwise the side that already lost publicly could refund
            // instead of paying while the winner's computation is in flight.
            let rb = load_run(&ctx.accounts.run_b)?;
            require!(
                !(ra.status == RUN_FINALIZED && rb.status == RUN_FINALIZED),
                ErrorCode::MarketResolvable
            );
            require!(
                (ra.status == RUN_FINALIZED || idle(&ra))
                    && (rb.status == RUN_FINALIZED || idle(&rb)),
                ErrorCode::MarketResolvable
            );
        }
        m.status = MARKET_CANCELLED;
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
    /// Optional deadline after which anyone can `expire_market` (0 = none).
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
}
