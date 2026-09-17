//! Sealed: a benchmark registry whose answers live onchain only as MXE-encrypted
//! ciphertext, scored inside Arcium MPC, with scores posted by the cluster callback.
//!
//! Lifecycle
//!   create_benchmark      commit to the item bank (Merkle root of question commitments)
//!   init_chunk / stage_part
//!                         author uploads answer hashes encrypted with a shared key,
//!                         8 items (one part) per transaction
//!   seal_part (+cb)       MPC re-encrypts a part to the MXE key; the author key is
//!                         discarded. A chunk is sealed when its 4 parts are; the
//!                         benchmark goes Live once every chunk is sealed
//!   create_run            a runner commits to a model's outputs (root) and pays the fee
//!   score_chunk (+cb)     MPC compares 32 public output hashes to the 4 sealed parts
//!                         and reveals only the count; callback accumulates it on the Run
//!
//! `AnswerChunk::ciphertexts` is read by the MPC cluster straight from account bytes
//! (`ArgBuilder::account`), so the fields before it are fixed-size and must not be
//! reordered without updating `CIPHERTEXTS_OFFSET`.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_SEAL_PART: u32 = comp_def_offset("seal_part");
const COMP_DEF_OFFSET_SCORE_CHUNK: u32 = comp_def_offset("score_chunk");
const COMP_DEF_OFFSET_GEN_PART: u32 = comp_def_offset("gen_part");

/// Items per chunk (one scoring computation). Must equal `CHUNK` in encrypted-ixs.
pub const CHUNK: usize = 32;
/// Items per part (one staging tx, one sealing computation). Must equal `PART` in encrypted-ixs.
pub const PART: usize = 8;
pub const PARTS: usize = CHUNK / PART;
pub const ALL_PARTS: u8 = (1u8 << PARTS) - 1;
pub const NO_PART: u8 = 0xFF;
/// Max chunks per benchmark; run bookkeeping uses a u64 bitmask.
pub const MAX_CHUNKS: u16 = 64;
/// 8 (discriminator) + benchmark 32 + index 2 + bump 1 + parts_staged 1 + parts_sealed 1
/// + sealing_part 1 + author_pubkey 32 + nonces 4*16.
pub const CIPHERTEXTS_OFFSET: u32 = 8 + 32 + 2 + 1 + 1 + 1 + 1 + 32 + (16 * PARTS as u32);
pub const PART_CIPHERTEXTS_LEN: u32 = (32 * PART) as u32;

pub const STATUS_DRAFT: u8 = 0;
pub const STATUS_LIVE: u8 = 1;
pub const STATUS_RETIRED: u8 = 2;
pub const RUN_PENDING: u8 = 0;
pub const RUN_FINALIZED: u8 = 1;
/// Author-staged bank: answers uploaded by the authority, sealed via `seal_part`.
pub const KIND_AUTHORED: u8 = 0;
/// MPC-generated bank: items minted inside `gen_part`; no answer key ever exists.
pub const KIND_GENERATED: u8 = 1;
/// Bytes per onchain item spec (a, b, c, op0, op1). Mirrored in the harness.
pub const ITEM_SPEC_LEN: usize = 5;

declare_id!("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");

#[inline]
fn part_offset(part: u8) -> u32 {
    CIPHERTEXTS_OFFSET + part as u32 * PART_CIPHERTEXTS_LEN
}

#[arcium_program]
pub mod sealed {
    use super::*;

    // ------------------------------------------------------------ comp defs

    pub fn init_seal_part_comp_def(ctx: Context<InitSealPartCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_score_chunk_comp_def(ctx: Context<InitScoreChunkCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_gen_part_comp_def(ctx: Context<InitGenPartCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    // ------------------------------------------------------------ benchmark

    pub fn create_benchmark(
        ctx: Context<CreateBenchmark>,
        id: u32,
        name: String,
        chunk_count: u16,
        items_root: [u8; 32],
        fee_lamports: u64,
        kind: u8,
    ) -> Result<()> {
        require!(
            (1..=MAX_CHUNKS).contains(&chunk_count),
            ErrorCode::InvalidChunkCount
        );
        require!(name.len() <= 32, ErrorCode::NameTooLong);
        require!(kind <= KIND_GENERATED, ErrorCode::WrongBankKind);
        let b = &mut ctx.accounts.benchmark;
        b.authority = ctx.accounts.authority.key();
        b.id = id;
        b.bump = ctx.bumps.benchmark;
        b.status = STATUS_DRAFT;
        b.chunk_count = chunk_count;
        b.chunks_sealed = 0;
        b.items_root = items_root;
        b.fee_lamports = fee_lamports;
        b.run_count = 0;
        b.created_at = Clock::get()?.unix_timestamp;
        b.kind = kind;
        b.name = name;
        emit!(BenchmarkCreated {
            benchmark: b.key(),
            authority: b.authority,
            id,
            chunk_count,
            items_root,
        });
        Ok(())
    }

    /// For generated banks: create the account that receives the minted item
    /// specs (5 bytes per item, 32 per chunk) from the `gen_part` callbacks.
    pub fn init_items(ctx: Context<InitItems>, index: u16) -> Result<()> {
        let b = &ctx.accounts.benchmark;
        require!(b.kind == KIND_GENERATED, ErrorCode::WrongBankKind);
        require!(index < b.chunk_count, ErrorCode::InvalidChunkIndex);
        let c = &mut ctx.accounts.items;
        c.benchmark = b.key();
        c.index = index;
        c.bump = ctx.bumps.items;
        Ok(())
    }

    pub fn init_chunk(ctx: Context<InitChunk>, index: u16) -> Result<()> {
        require!(
            index < ctx.accounts.benchmark.chunk_count,
            ErrorCode::InvalidChunkIndex
        );
        let c = &mut ctx.accounts.chunk;
        c.benchmark = ctx.accounts.benchmark.key();
        c.index = index;
        c.bump = ctx.bumps.chunk;
        c.sealing_part = NO_PART;
        Ok(())
    }

    /// Upload one part: `PART` answer-hash ciphertexts encrypted with the author's
    /// x25519 shared key (RescueCipher, one nonce per part).
    pub fn stage_part(
        ctx: Context<StagePart>,
        _index: u16,
        part: u8,
        author_pubkey: [u8; 32],
        nonce: u128,
        ciphertexts: [[u8; 32]; PART],
    ) -> Result<()> {
        let c = &mut ctx.accounts.chunk;
        require!(ctx.accounts.benchmark.kind == KIND_AUTHORED, ErrorCode::WrongBankKind);
        require!((part as usize) < PARTS, ErrorCode::InvalidPart);
        let bit = 1u8 << part;
        require!(c.parts_sealed & bit == 0, ErrorCode::PartAlreadySealed);
        require!(c.sealing_part != part, ErrorCode::PartSealPending);
        if c.parts_staged == 0 {
            c.author_pubkey = author_pubkey;
        } else {
            require!(c.author_pubkey == author_pubkey, ErrorCode::StagingKeyMismatch);
        }
        c.nonces[part as usize] = nonce;
        let start = part as usize * PART;
        c.ciphertexts[start..start + PART].copy_from_slice(&ciphertexts);
        c.parts_staged |= bit;
        Ok(())
    }

    /// Queue the MPC re-encryption of one staged part to the MXE key.
    pub fn seal_part(
        ctx: Context<SealPart>,
        computation_offset: u64,
        _index: u16,
        part: u8,
    ) -> Result<()> {
        let c = &mut ctx.accounts.chunk;
        require!(ctx.accounts.benchmark.kind == KIND_AUTHORED, ErrorCode::WrongBankKind);
        require!((part as usize) < PARTS, ErrorCode::InvalidPart);
        let bit = 1u8 << part;
        require!(c.parts_staged & bit != 0, ErrorCode::PartNotStaged);
        require!(c.parts_sealed & bit == 0, ErrorCode::PartAlreadySealed);
        require!(c.sealing_part == NO_PART, ErrorCode::PartSealPending);
        c.sealing_part = part;

        // Enc<Shared, AnswerPart> = pubkey, nonce, then PART ciphertexts read from the account.
        let args = ArgBuilder::new()
            .x25519_pubkey(c.author_pubkey)
            .plaintext_u128(c.nonces[part as usize])
            .account(c.key(), part_offset(part), PART_CIPHERTEXTS_LEN)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SealPartCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount { pubkey: ctx.accounts.chunk.key(), is_writable: true },
                    CallbackAccount { pubkey: ctx.accounts.benchmark.key(), is_writable: true },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "seal_part")]
    pub fn seal_part_callback(
        ctx: Context<SealPartCallback>,
        output: SignedComputationOutputs<SealPartOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SealPartOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("seal_part aborted: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };
        let c = &mut ctx.accounts.chunk;
        let part = c.sealing_part;
        require!(part != NO_PART, ErrorCode::PartSealNotPending);
        let bit = 1u8 << part;
        require!(c.parts_sealed & bit == 0, ErrorCode::PartAlreadySealed);
        let start = part as usize * PART;
        c.ciphertexts[start..start + PART].copy_from_slice(&o.ciphertexts);
        c.nonces[part as usize] = o.nonce;
        c.parts_sealed |= bit;
        c.sealing_part = NO_PART;

        let b = &mut ctx.accounts.benchmark;
        let chunk_sealed = c.parts_sealed == ALL_PARTS;
        if chunk_sealed {
            c.author_pubkey = [0u8; 32];
            b.chunks_sealed += 1;
            if b.chunks_sealed == b.chunk_count {
                b.status = STATUS_LIVE;
            }
        }
        emit!(PartSealed {
            benchmark: b.key(),
            chunk_index: c.index,
            part,
            chunk_sealed,
            live: b.status == STATUS_LIVE,
        });
        Ok(())
    }

    /// Queue the MPC minting of one part of a generated bank: 8 item specs drawn
    /// from ArcisRNG plus their answer fingerprints, born encrypted to the MXE key.
    /// No answer key ever exists for a generated bank — there is nothing to leak.
    pub fn gen_part(
        ctx: Context<GenPart>,
        computation_offset: u64,
        _index: u16,
        part: u8,
    ) -> Result<()> {
        let b = &ctx.accounts.benchmark;
        require!(b.kind == KIND_GENERATED, ErrorCode::WrongBankKind);
        let c = &mut ctx.accounts.chunk;
        let items = &ctx.accounts.items;
        require!((part as usize) < PARTS, ErrorCode::InvalidPart);
        let bit = 1u8 << part;
        require!(c.parts_sealed & bit == 0, ErrorCode::PartAlreadySealed);
        require!(items.parts_written & bit == 0, ErrorCode::PartAlreadySealed);
        require!(c.sealing_part == NO_PART, ErrorCode::PartSealPending);
        c.sealing_part = part;

        let base_index = c.index as u32 * CHUNK as u32 + part as u32 * PART as u32;
        let args = ArgBuilder::new()
            .plaintext_u32(b.id)
            .plaintext_u32(base_index)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![GenPartCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount { pubkey: ctx.accounts.chunk.key(), is_writable: true },
                    CallbackAccount { pubkey: ctx.accounts.items.key(), is_writable: true },
                    CallbackAccount { pubkey: ctx.accounts.benchmark.key(), is_writable: true },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "gen_part")]
    pub fn gen_part_callback(
        ctx: Context<GenPartCallback>,
        output: SignedComputationOutputs<GenPartOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(GenPartOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("gen_part aborted: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };
        // The circuit returns a tuple, so everything nests under `field_0`:
        // `field_0.field_0` is the public `GenPart` (items array), `field_0.field_1`
        // is `Enc<Mxe, AnswerPart>` (MXEEncryptedStruct<8>).
        let gen = o.field_0;
        let enc = o.field_1;
        let c = &mut ctx.accounts.chunk;
        let part = c.sealing_part;
        require!(part != NO_PART, ErrorCode::PartSealNotPending);
        let bit = 1u8 << part;
        require!(c.parts_sealed & bit == 0, ErrorCode::PartAlreadySealed);
        let start = part as usize * PART;
        c.ciphertexts[start..start + PART].copy_from_slice(&enc.ciphertexts);
        c.nonces[part as usize] = enc.nonce;
        c.parts_sealed |= bit;
        c.sealing_part = NO_PART;

        let items = &mut ctx.accounts.items;
        let mut spec_bytes = Vec::with_capacity(PART * ITEM_SPEC_LEN);
        for (k, spec) in gen.field_0.iter().enumerate() {
            items.items[start + k] = ItemSpecWire {
                a: spec.field_0,
                b: spec.field_1,
                c: spec.field_2,
                op0: spec.field_3,
                op1: spec.field_4,
            };
            spec_bytes.extend_from_slice(&[
                spec.field_0,
                spec.field_1,
                spec.field_2,
                spec.field_3,
                spec.field_4,
            ]);
        }
        items.parts_written |= bit;

        // Fold this part's specs into items_root: a running commitment to every
        // minted item, in order.
        let b = &mut ctx.accounts.benchmark;
        b.items_root = solana_sha256_hasher::hashv(&[
            &b"sealed/v1/genitems\0"[..],
            &b.items_root[..],
            &c.index.to_le_bytes()[..],
            &[part][..],
            &spec_bytes[..],
        ])
        .to_bytes();

        let chunk_sealed = c.parts_sealed == ALL_PARTS;
        if chunk_sealed {
            b.chunks_sealed += 1;
            if b.chunks_sealed == b.chunk_count {
                b.status = STATUS_LIVE;
            }
        }
        emit!(PartSealed {
            benchmark: b.key(),
            chunk_index: c.index,
            part,
            chunk_sealed,
            live: b.status == STATUS_LIVE,
        });
        Ok(())
    }

    /// If a seal computation aborts, its callback never lands. The authority clears
    /// the flag so the part can be staged/sealed again.
    pub fn reset_sealing(ctx: Context<ResetSealing>, _index: u16) -> Result<()> {
        ctx.accounts.chunk.sealing_part = NO_PART;
        Ok(())
    }

    pub fn retire_benchmark(ctx: Context<RetireBenchmark>) -> Result<()> {
        ctx.accounts.benchmark.status = STATUS_RETIRED;
        Ok(())
    }

    // ------------------------------------------------------------ runs

    /// Register a model run. `outputs_root` commits to every output hash before any
    /// chunk is scored; `harness_hash` pins the prompt template and sampling params.
    pub fn create_run(
        ctx: Context<CreateRun>,
        model_id: String,
        harness_hash: [u8; 32],
        outputs_root: [u8; 32],
    ) -> Result<()> {
        require!(model_id.len() <= 64, ErrorCode::NameTooLong);
        let b = &mut ctx.accounts.benchmark;
        require!(b.status == STATUS_LIVE, ErrorCode::BenchmarkNotLive);
        if b.fee_lamports > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.runner.to_account_info(),
                        to: ctx.accounts.authority.to_account_info(),
                    },
                ),
                b.fee_lamports,
            )?;
        }
        let r = &mut ctx.accounts.run;
        r.benchmark = b.key();
        r.runner = ctx.accounts.runner.key();
        r.index = b.run_count;
        r.bump = ctx.bumps.run;
        r.status = RUN_PENDING;
        r.chunk_count = b.chunk_count;
        r.pending_mask = 0;
        r.scored_mask = 0;
        r.correct = 0;
        r.created_at = Clock::get()?.unix_timestamp;
        r.finalized_at = 0;
        r.harness_hash = harness_hash;
        r.outputs_root = outputs_root;
        r.model_id = model_id.clone();
        b.run_count += 1;
        emit!(RunCreated {
            run: r.key(),
            benchmark: b.key(),
            index: r.index,
            runner: r.runner,
            model_id,
        });
        Ok(())
    }

    /// Queue scoring of one chunk. `outputs[i]` is the run's public hash of the
    /// model's canonical answer to item `chunk_index * CHUNK + i`.
    pub fn score_chunk(
        ctx: Context<ScoreChunk>,
        computation_offset: u64,
        _run_index: u64,
        chunk_index: u16,
        outputs: [u64; CHUNK],
    ) -> Result<()> {
        let r = &mut ctx.accounts.run;
        let c = &ctx.accounts.chunk;
        require!(r.status == RUN_PENDING, ErrorCode::RunAlreadyFinalized);
        require!(c.parts_sealed == ALL_PARTS, ErrorCode::ChunkNotSealed);
        require!(c.index == chunk_index, ErrorCode::InvalidChunkIndex);
        let bit = 1u64 << chunk_index;
        require!(r.scored_mask & bit == 0, ErrorCode::ChunkAlreadyScored);
        require!(r.pending_mask & bit == 0, ErrorCode::ChunkScorePending);
        r.pending_mask |= bit;

        // Circuit signature: (outputs: [u64; CHUNK], p0..p3: Enc<Mxe, AnswerPart>).
        let mut args = outputs
            .iter()
            .fold(ArgBuilder::new(), |b, h| b.plaintext_u64(*h));
        for p in 0..PARTS as u8 {
            args = args
                .plaintext_u128(c.nonces[p as usize])
                .account(c.key(), part_offset(p), PART_CIPHERTEXTS_LEN);
        }
        let args = args.build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ScoreChunkCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount { pubkey: ctx.accounts.run.key(), is_writable: true },
                    CallbackAccount { pubkey: ctx.accounts.chunk.key(), is_writable: false },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "score_chunk")]
    pub fn score_chunk_callback(
        ctx: Context<ScoreChunkCallback>,
        output: SignedComputationOutputs<ScoreChunkOutput>,
    ) -> Result<()> {
        let correct = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ScoreChunkOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("score_chunk aborted: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };
        let r = &mut ctx.accounts.run;
        let c = &ctx.accounts.chunk;
        let bit = 1u64 << c.index;
        require!(r.pending_mask & bit != 0, ErrorCode::ChunkScoreNotPending);
        require!(r.scored_mask & bit == 0, ErrorCode::ChunkAlreadyScored);
        r.pending_mask &= !bit;
        r.scored_mask |= bit;
        r.correct += correct as u32;
        emit!(ChunkScored {
            run: r.key(),
            chunk_index: c.index,
            correct,
        });
        let all = if r.chunk_count >= 64 { u64::MAX } else { (1u64 << r.chunk_count) - 1 };
        if r.scored_mask == all {
            r.status = RUN_FINALIZED;
            r.finalized_at = Clock::get()?.unix_timestamp;
            emit!(RunFinalized {
                run: r.key(),
                benchmark: r.benchmark,
                correct: r.correct,
                item_count: r.chunk_count as u32 * CHUNK as u32,
            });
        }
        Ok(())
    }

    /// If an MPC computation aborts, its callback never lands and the chunk stays
    /// pending. The runner can clear the flag and queue again; double counting is
    /// prevented by `scored_mask` in the callback.
    pub fn reset_pending(ctx: Context<ResetPending>, _run_index: u64, chunk_index: u16) -> Result<()> {
        let r = &mut ctx.accounts.run;
        require!(r.status == RUN_PENDING, ErrorCode::RunAlreadyFinalized);
        require!(chunk_index < r.chunk_count, ErrorCode::InvalidChunkIndex);
        r.pending_mask &= !(1u64 << chunk_index);
        Ok(())
    }
}

// ================================================================== accounts

#[account]
#[derive(InitSpace)]
pub struct Benchmark {
    pub authority: Pubkey,
    pub id: u32,
    pub bump: u8,
    pub status: u8,
    pub chunk_count: u16,
    pub chunks_sealed: u16,
    pub items_root: [u8; 32],
    pub fee_lamports: u64,
    pub run_count: u64,
    pub created_at: i64,
    /// 0 = author-staged answers; 1 = items minted inside MPC (no answer key).
    pub kind: u8,
    #[max_len(32)]
    pub name: String,
}

/// One minted item spec, 5 bytes packed onchain. Mirrors `ItemSpec` in the
/// circuit: evaluate `((a op0 b) op1 c)`; ops 0=+ 1=- 2=*.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct ItemSpecWire {
    pub a: u8,
    pub b: u8,
    pub c: u8,
    pub op0: u8,
    pub op1: u8,
}

/// Item specs for one chunk of a generated bank, written by `gen_part` callbacks.
/// Public data — anyone can render the prompts from these specs.
#[account]
#[derive(InitSpace)]
pub struct ItemChunk {
    pub benchmark: Pubkey,
    pub index: u16,
    pub bump: u8,
    /// Bitmask of parts written so far.
    pub parts_written: u8,
    pub items: [ItemSpecWire; CHUNK],
}

/// Fixed-size prefix; `ciphertexts` starts at `CIPHERTEXTS_OFFSET`. Part `p` occupies
/// `ciphertexts[p*PART..(p+1)*PART]` and is encrypted under `nonces[p]`.
#[account]
#[derive(InitSpace)]
pub struct AnswerChunk {
    pub benchmark: Pubkey,
    pub index: u16,
    pub bump: u8,
    /// Bitmask of parts uploaded by the author.
    pub parts_staged: u8,
    /// Bitmask of parts re-encrypted to the MXE key.
    pub parts_sealed: u8,
    /// Part whose seal computation is in flight, or `NO_PART`.
    pub sealing_part: u8,
    /// Author's x25519 public key while staging; zeroed once the chunk is fully sealed.
    pub author_pubkey: [u8; 32],
    /// Per-part nonce: the author's while staged, the MXE's once sealed.
    pub nonces: [u128; PARTS],
    pub ciphertexts: [[u8; 32]; CHUNK],
}

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

// ------------------------------------------------------------------ plain ixs

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct CreateBenchmark<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Benchmark::INIT_SPACE,
        seeds = [b"benchmark", authority.key().as_ref(), id.to_le_bytes().as_ref()],
        bump,
    )]
    pub benchmark: Account<'info, Benchmark>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct InitChunk<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ ErrorCode::NotAuthority)]
    pub benchmark: Account<'info, Benchmark>,
    #[account(
        init,
        payer = authority,
        space = 8 + AnswerChunk::INIT_SPACE,
        seeds = [b"chunk", benchmark.key().as_ref(), index.to_le_bytes().as_ref()],
        bump,
    )]
    pub chunk: Box<Account<'info, AnswerChunk>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct InitItems<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ ErrorCode::NotAuthority)]
    pub benchmark: Account<'info, Benchmark>,
    #[account(
        init,
        payer = authority,
        space = 8 + ItemChunk::INIT_SPACE,
        seeds = [b"items", benchmark.key().as_ref(), index.to_le_bytes().as_ref()],
        bump,
    )]
    pub items: Box<Account<'info, ItemChunk>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct StagePart<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority @ ErrorCode::NotAuthority)]
    pub benchmark: Account<'info, Benchmark>,
    #[account(
        mut,
        seeds = [b"chunk", benchmark.key().as_ref(), index.to_le_bytes().as_ref()],
        bump = chunk.bump,
    )]
    pub chunk: Box<Account<'info, AnswerChunk>>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct ResetSealing<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority @ ErrorCode::NotAuthority)]
    pub benchmark: Account<'info, Benchmark>,
    #[account(
        mut,
        seeds = [b"chunk", benchmark.key().as_ref(), index.to_le_bytes().as_ref()],
        bump = chunk.bump,
    )]
    pub chunk: Box<Account<'info, AnswerChunk>>,
}

#[derive(Accounts)]
pub struct RetireBenchmark<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::NotAuthority)]
    pub benchmark: Account<'info, Benchmark>,
}

#[derive(Accounts)]
pub struct CreateRun<'info> {
    #[account(mut)]
    pub runner: Signer<'info>,
    /// CHECK: fee recipient, constrained to `benchmark.authority`.
    #[account(mut, address = benchmark.authority @ ErrorCode::NotAuthority)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub benchmark: Account<'info, Benchmark>,
    #[account(
        init,
        payer = runner,
        space = 8 + Run::INIT_SPACE,
        seeds = [b"run", benchmark.key().as_ref(), benchmark.run_count.to_le_bytes().as_ref()],
        bump,
    )]
    pub run: Account<'info, Run>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(run_index: u64, chunk_index: u16)]
pub struct ResetPending<'info> {
    pub runner: Signer<'info>,
    #[account(
        mut,
        has_one = runner @ ErrorCode::NotRunner,
        seeds = [b"run", run.benchmark.as_ref(), run_index.to_le_bytes().as_ref()],
        bump = run.bump,
    )]
    pub run: Account<'info, Run>,
}

// ------------------------------------------------------------------ arcium ixs

#[init_computation_definition_accounts("seal_part", payer)]
#[derive(Accounts)]
pub struct InitSealPartCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program. Not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("score_chunk", payer)]
#[derive(Accounts)]
pub struct InitScoreChunkCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program. Not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("gen_part", payer)]
#[derive(Accounts)]
pub struct InitGenPartCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program. Not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("seal_part", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, index: u16)]
pub struct SealPart<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = benchmark.authority == payer.key() @ ErrorCode::NotAuthority)]
    pub benchmark: Box<Account<'info, Benchmark>>,
    #[account(
        mut,
        seeds = [b"chunk", benchmark.key().as_ref(), index.to_le_bytes().as_ref()],
        bump = chunk.bump,
    )]
    pub chunk: Box<Account<'info, AnswerChunk>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEAL_PART))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("seal_part")]
#[derive(Accounts)]
pub struct SealPartCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEAL_PART))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, constraint = chunk.benchmark == benchmark.key() @ ErrorCode::ChunkBenchmarkMismatch)]
    pub chunk: Box<Account<'info, AnswerChunk>>,
    #[account(mut)]
    pub benchmark: Box<Account<'info, Benchmark>>,
}

#[queue_computation_accounts("gen_part", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, index: u16)]
pub struct GenPart<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = benchmark.authority == payer.key() @ ErrorCode::NotAuthority)]
    pub benchmark: Box<Account<'info, Benchmark>>,
    #[account(
        mut,
        seeds = [b"chunk", benchmark.key().as_ref(), index.to_le_bytes().as_ref()],
        bump = chunk.bump,
    )]
    pub chunk: Box<Account<'info, AnswerChunk>>,
    #[account(
        mut,
        seeds = [b"items", benchmark.key().as_ref(), index.to_le_bytes().as_ref()],
        bump = items.bump,
    )]
    pub items: Box<Account<'info, ItemChunk>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_GEN_PART))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("gen_part")]
#[derive(Accounts)]
pub struct GenPartCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_GEN_PART))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, constraint = chunk.benchmark == benchmark.key() @ ErrorCode::ChunkBenchmarkMismatch)]
    pub chunk: Box<Account<'info, AnswerChunk>>,
    #[account(
        mut,
        seeds = [b"items", benchmark.key().as_ref(), chunk.index.to_le_bytes().as_ref()],
        bump = items.bump,
    )]
    pub items: Box<Account<'info, ItemChunk>>,
    #[account(mut)]
    pub benchmark: Box<Account<'info, Benchmark>>,
}

#[queue_computation_accounts("score_chunk", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, run_index: u64, chunk_index: u16)]
pub struct ScoreChunk<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        has_one = runner @ ErrorCode::NotRunner,
        seeds = [b"run", run.benchmark.as_ref(), run_index.to_le_bytes().as_ref()],
        bump = run.bump,
    )]
    pub run: Box<Account<'info, Run>>,
    pub runner: Signer<'info>,
    #[account(
        seeds = [b"chunk", run.benchmark.as_ref(), chunk_index.to_le_bytes().as_ref()],
        bump = chunk.bump,
    )]
    pub chunk: Box<Account<'info, AnswerChunk>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SCORE_CHUNK))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("score_chunk")]
#[derive(Accounts)]
pub struct ScoreChunkCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SCORE_CHUNK))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, constraint = run.benchmark == chunk.benchmark @ ErrorCode::ChunkBenchmarkMismatch)]
    pub run: Box<Account<'info, Run>>,
    pub chunk: Box<Account<'info, AnswerChunk>>,
}

// ================================================================== events

#[event]
pub struct BenchmarkCreated {
    pub benchmark: Pubkey,
    pub authority: Pubkey,
    pub id: u32,
    pub chunk_count: u16,
    pub items_root: [u8; 32],
}

#[event]
pub struct PartSealed {
    pub benchmark: Pubkey,
    pub chunk_index: u16,
    pub part: u8,
    pub chunk_sealed: bool,
    pub live: bool,
}

#[event]
pub struct RunCreated {
    pub run: Pubkey,
    pub benchmark: Pubkey,
    pub index: u64,
    pub runner: Pubkey,
    pub model_id: String,
}

#[event]
pub struct ChunkScored {
    pub run: Pubkey,
    pub chunk_index: u16,
    pub correct: u8,
}

#[event]
pub struct RunFinalized {
    pub run: Pubkey,
    pub benchmark: Pubkey,
    pub correct: u32,
    pub item_count: u32,
}

// ================================================================== errors

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Signer is not the benchmark authority")]
    NotAuthority,
    #[msg("Signer is not the runner of this run")]
    NotRunner,
    #[msg("chunk_count must be between 1 and 64")]
    InvalidChunkCount,
    #[msg("Chunk index out of range")]
    InvalidChunkIndex,
    #[msg("Part index out of range")]
    InvalidPart,
    #[msg("Name or model id too long")]
    NameTooLong,
    #[msg("All parts of a chunk must be staged with the same author key")]
    StagingKeyMismatch,
    #[msg("Part is already sealed")]
    PartAlreadySealed,
    #[msg("Part is not staged")]
    PartNotStaged,
    #[msg("A seal computation is already pending on this chunk")]
    PartSealPending,
    #[msg("No seal computation is pending on this chunk")]
    PartSealNotPending,
    #[msg("Chunk is not fully sealed yet")]
    ChunkNotSealed,
    #[msg("Benchmark is not live")]
    BenchmarkNotLive,
    #[msg("Chunk already scored for this run")]
    ChunkAlreadyScored,
    #[msg("A score for this chunk is already pending")]
    ChunkScorePending,
    #[msg("No score is pending for this chunk")]
    ChunkScoreNotPending,
    #[msg("Run is already finalized")]
    RunAlreadyFinalized,
    #[msg("Chunk does not belong to this benchmark")]
    ChunkBenchmarkMismatch,
    #[msg("Operation does not match the benchmark kind (authored vs generated)")]
    WrongBankKind,
}
