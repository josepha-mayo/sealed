//! Sealed Market: parimutuel YES/NO markets that resolve on a Sealed run's score.
//!
//! A market asks "will run.correct >= threshold once the run finalizes?" and is
//! settled entirely onchain: `resolve` reads the Sealed program's `Run` account,
//! so the resolution source is the MPC-scored result, not an operator.
//!
//! Lifecycle
//!   create_market  pick a pending, unscored run + a threshold
//!   bet            deposit lamports on YES or NO while the run stays unscored
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

pub const SIDE_YES: u8 = 1;
pub const SIDE_NO: u8 = 2;

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

#[program]
pub mod market {
    use super::*;

    /// Open a market on a run that exists but has not started scoring.
    pub fn create_market(ctx: Context<CreateMarket>, threshold: u32) -> Result<()> {
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(run.scored_mask == 0, ErrorCode::ScoringStarted);
        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.run = ctx.accounts.run.key();
        m.benchmark = run.benchmark;
        m.run_index = run.index;
        m.threshold = threshold;
        m.bump = ctx.bumps.market;
        m.status = MARKET_OPEN;
        m.outcome = 0;
        m.yes_total = 0;
        m.no_total = 0;
        m.resolved_score = 0;
        m.created_at = Clock::get()?.unix_timestamp;
        m.resolved_at = 0;
        emit!(MarketCreated {
            market: m.key(),
            run: m.run,
            benchmark: run.benchmark,
            threshold,
        });
        Ok(())
    }

    /// Stake `lamports` on `side` (1 = YES, 2 = NO). Re-betting adds to the same
    /// position; a bettor may hold both sides.
    pub fn bet(ctx: Context<Bet>, side: u8, lamports: u64) -> Result<()> {
        require!(side == SIDE_YES || side == SIDE_NO, ErrorCode::InvalidSide);
        require!(lamports > 0, ErrorCode::ZeroAmount);
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_PENDING, ErrorCode::RunNotPending);
        require!(run.scored_mask == 0, ErrorCode::ScoringStarted);
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);

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
        if side == SIDE_YES {
            p.yes += lamports;
            m.yes_total += lamports;
        } else {
            p.no += lamports;
            m.no_total += lamports;
        }
        emit!(BetPlaced {
            market: m.key(),
            bettor: p.bettor,
            side,
            lamports,
        });
        Ok(())
    }

    /// Settle the market from the finalized run. If one side attracted no stake,
    /// the market is cancelled and everyone is refunded instead.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        let run = load_run(&ctx.accounts.run)?;
        require!(run.status == RUN_FINALIZED, ErrorCode::RunNotFinalized);
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);

        m.resolved_score = run.correct;
        m.resolved_at = Clock::get()?.unix_timestamp;
        if m.yes_total == 0 || m.no_total == 0 {
            m.status = MARKET_CANCELLED;
        } else {
            m.status = MARKET_RESOLVED;
            m.outcome = if run.correct >= m.threshold { SIDE_YES } else { SIDE_NO };
        }
        emit!(MarketResolved {
            market: m.key(),
            run: ctx.accounts.run.key(),
            correct: run.correct,
            threshold: m.threshold,
            outcome: m.outcome,
            cancelled: m.status == MARKET_CANCELLED,
        });
        Ok(())
    }

    /// Authority escape hatch for runs that never finalize.
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MARKET_OPEN, ErrorCode::MarketNotOpen);
        m.status = MARKET_CANCELLED;
        Ok(())
    }

    /// Pay out a winning position (or refund both sides after a cancellation) and
    /// close the position account.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(
            m.status == MARKET_RESOLVED || m.status == MARKET_CANCELLED,
            ErrorCode::MarketNotResolved
        );
        require!(!p.claimed, ErrorCode::AlreadyClaimed);

        let payout = if m.status == MARKET_CANCELLED {
            p.yes + p.no
        } else {
            let (win_amt, win_total) = if m.outcome == SIDE_YES {
                (p.yes, m.yes_total)
            } else {
                (p.no, m.no_total)
            };
            (win_amt as u128)
                .checked_mul((m.yes_total + m.no_total) as u128)
                .unwrap()
                .checked_div(win_total as u128)
                .unwrap() as u64
        };
        require!(payout > 0, ErrorCode::NothingToClaim);
        p.claimed = true;

        **m.to_account_info().try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.bettor.to_account_info().try_borrow_mut_lamports()? += payout;
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
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub run: Pubkey,
    pub benchmark: Pubkey,
    pub run_index: u64,
    pub threshold: u32,
    pub bump: u8,
    pub status: u8,
    pub outcome: u8,
    pub yes_total: u64,
    pub no_total: u64,
    pub resolved_score: u32,
    pub created_at: i64,
    pub resolved_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub bump: u8,
    pub yes: u64,
    pub no: u64,
    pub claimed: bool,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Sealed Run account; owner + discriminator verified in `load_run`.
    pub run: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", run.key().as_ref()],
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
        seeds = [b"market", run.key().as_ref()],
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
        seeds = [b"market", run.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
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
    pub threshold: u32,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub side: u8,
    pub lamports: u64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub run: Pubkey,
    pub correct: u32,
    pub threshold: u32,
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
    #[msg("Side must be 1 (YES) or 2 (NO)")]
    InvalidSide,
    #[msg("Bet amount must be positive")]
    ZeroAmount,
    #[msg("Position already claimed")]
    AlreadyClaimed,
    #[msg("Nothing to claim on this position")]
    NothingToClaim,
}
