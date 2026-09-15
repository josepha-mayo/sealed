//! Sealed: MPC circuits for a benchmark whose answers never exist in plaintext
//! outside the item author.
//!
//! `seal_part`    author-encrypted answers (8 items) -> MXE-only encrypted answers
//! `score_chunk`  public output hashes (32 items) + 4 sealed parts -> match count
//!
//! Only the aggregate count leaves `score_chunk`. Which items a model got right,
//! and what the answers are, stay inside MPC.
//!
//! Why parts: a callback must fit in one Solana transaction (1232 bytes). Eight
//! 32-byte ciphertexts (256 B) fit; thirty-two (1 KB) do not. Sealing is a one-time
//! cost per bank, so it is split; scoring is the recurring path, so it reads all
//! four parts in a single computation.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Items per scoring computation.
    pub const CHUNK: usize = 32;
    /// Items per sealing computation.
    pub const PART: usize = 8;

    /// Answer commitments for one part. Each entry is the little-endian u64 of the
    /// first 8 bytes of SHA-256 over the canonical answer (see packages/harness).
    pub struct AnswerPart {
        pub hashes: [u64; PART],
    }

    /// Re-encrypt a part from the author's shared key to the MXE key. After this
    /// runs, the ciphertext stored onchain can only be opened inside the cluster.
    #[instruction]
    pub fn seal_part(staged: Enc<Shared, AnswerPart>) -> Enc<Mxe, AnswerPart> {
        let part = staged.to_arcis();
        Mxe::get().from_arcis(part)
    }

    /// Count positions where the run's output hash equals the sealed answer hash.
    /// `outputs` is public (it is the run's permanent commitment to what the model
    /// said); the per-item match bits are never revealed, only their sum.
    #[instruction]
    pub fn score_chunk(
        outputs: [u64; CHUNK],
        p0: Enc<Mxe, AnswerPart>,
        p1: Enc<Mxe, AnswerPart>,
        p2: Enc<Mxe, AnswerPart>,
        p3: Enc<Mxe, AnswerPart>,
    ) -> u8 {
        let a0 = p0.to_arcis();
        let a1 = p1.to_arcis();
        let a2 = p2.to_arcis();
        let a3 = p3.to_arcis();
        let mut correct: u8 = 0;
        for i in 0..PART {
            if outputs[i] == a0.hashes[i] {
                correct += 1;
            }
            if outputs[PART + i] == a1.hashes[i] {
                correct += 1;
            }
            if outputs[2 * PART + i] == a2.hashes[i] {
                correct += 1;
            }
            if outputs[3 * PART + i] == a3.hashes[i] {
                correct += 1;
            }
        }
        correct.reveal()
    }
}
