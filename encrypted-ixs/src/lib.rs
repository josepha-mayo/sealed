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

    /// A generated arithmetic item: evaluate `((a op0 b) op1 c)`; ops 0=+ 1=- 2=*.
    /// All fields are public — the prompt is rendered from the spec off-circuit.
    /// Drawn from ArcisRNG inside MPC, so no human ever held this item.
    #[derive(Copy, Clone)]
    pub struct ItemSpec {
        pub a: u8,
        pub b: u8,
        pub c: u8,
        pub op0: u8,
        pub op1: u8,
    }

    /// Public half of `gen_part`: the 8 item specs minted in this computation.
    pub struct GenPart {
        pub items: [ItemSpec; PART],
    }

    const OP_ADD: u8 = 0;
    const OP_SUB: u8 = 1;
    const OP_MUL: u8 = 2;

    fn apply_op(x: i64, op: u8, y: i64) -> i64 {
        if op == OP_ADD {
            x + y
        } else if op == OP_SUB {
            x - y
        } else {
            x * y
        }
    }

    /// Answer fingerprint for generated banks:
    /// u64le(SHA3-256("sealed/v1/genanswer\0" || u32le(id) || u32le(item) || le8(ans))[0..8]).
    /// The payload is the answer as 8 little-endian bytes (two's complement); the
    /// harness derives it from the model's canonical reply by parsing it as an
    /// integer, so no decimal rendering happens inside MPC.
    fn gen_answer_hash(benchmark_id: u32, item_index: u32, ans: i64) -> u64 {
        let mut msg = [0u8; 36];
        let domain = *b"sealed/v1/genanswer\0";
        for i in 0..20 {
            msg[i] = domain[i];
        }
        for i in 0..4 {
            msg[20 + i] = ((benchmark_id >> (8 * i)) & 0xff) as u8;
            msg[24 + i] = ((item_index >> (8 * i)) & 0xff) as u8;
        }
        for i in 0..8 {
            msg[28 + i] = ((ans >> (8 * i)) & 0xff) as u8;
        }
        let digest = SHA3_256::new().digest(&msg);
        let mut h: u64 = 0;
        for i in 0..8 {
            h |= (digest[i] as u64) << (8 * i);
        }
        h
    }

    /// Shared mint loop: 8 item specs drawn from MPC randomness plus their
    /// answer fingerprints. Used by both the public and private gen variants.
    fn mint_part(benchmark_id: u32, base_index: u32) -> (GenPart, AnswerPart) {
        let mut specs = [ItemSpec { a: 0, b: 0, c: 0, op0: 0, op1: 0 }; PART];
        let mut hashes = [0u64; PART];
        for i in 0..PART {
            let a = ArcisRNG::gen_public_integer_from_width(6) as u8; // 0..63
            let b = ArcisRNG::gen_public_integer_from_width(6) as u8;
            let c = ArcisRNG::gen_public_integer_from_width(6) as u8;
            let op0 = (ArcisRNG::gen_public_integer_from_width(2) as u8) % 3;
            let op1 = (ArcisRNG::gen_public_integer_from_width(2) as u8) % 3;
            let ans = apply_op(apply_op(a as i64, op0, b as i64), op1, c as i64);
            specs[i] = ItemSpec { a, b, c, op0, op1 };
            hashes[i] = gen_answer_hash(benchmark_id, base_index + i as u32, ans);
        }
        (GenPart { items: specs }, AnswerPart { hashes })
    }

    /// Mint one part of a generated bank: 8 items drawn from MPC randomness and
    /// their answer fingerprints, born encrypted to the MXE key. The item specs
    /// come back public; the answers never exist in plaintext anywhere.
    #[instruction]
    pub fn gen_part(benchmark_id: u32, base_index: u32) -> (GenPart, Enc<Mxe, AnswerPart>) {
        let (gen, answers) = mint_part(benchmark_id, base_index);
        (gen, Mxe::get().from_arcis(answers))
    }

    /// Mint one part of a PRIVATE generated bank: same mint, but the specs come
    /// back packed and encrypted to the viewer's x25519 key (`Shared`). Only the
    /// designated viewer — in practice the benchmark authority — can render the
    /// prompts; the answers are still born `Enc<Mxe>`. Result: a bank where the
    /// questions are confidential *and* no answer key exists anywhere.
    #[instruction]
    pub fn gen_part_private(
        benchmark_id: u32,
        base_index: u32,
        viewer: ArcisX25519Pubkey,
    ) -> (Enc<Shared, Pack<GenPart>>, Enc<Mxe, AnswerPart>) {
        let (gen, answers) = mint_part(benchmark_id, base_index);
        (
            Shared::new(viewer).from_arcis(Pack::new(gen)),
            Mxe::get().from_arcis(answers),
        )
    }

    /// Re-encrypt a private bank's part to a SECOND viewer key. The authority
    /// submits the stored `Enc<Shared, Pack<GenPart>>` (theirs), MPC decrypts
    /// inside the enclave and re-encrypts to `viewer` — selective disclosure of
    /// the questions themselves, to a delegate, without ever publishing them.
    /// The answer fingerprints stay `Enc<Mxe>`; only the specs move.
    #[instruction]
    pub fn reshare_part(
        specs: Enc<Shared, Pack<GenPart>>,
        viewer: ArcisX25519Pubkey,
    ) -> Enc<Shared, Pack<GenPart>> {
        Shared::new(viewer).from_arcis(specs.to_arcis())
    }

    /// Declassify one part's answer fingerprints (not the answers — the hashes).
    /// The on-chain program gates this on the benchmark authority's signature;
    /// MPC mediates the decryption, so even the authority only ever receives
    /// hash commitments, which can be compared against a run's committed output
    /// hashes for a spot-check audit of the scoring.
    #[instruction]
    pub fn reveal_part(part: Enc<Mxe, AnswerPart>) -> AnswerPart {
        part.to_arcis().reveal()
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
