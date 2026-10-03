# Circuit review guide — `encrypted-ixs/src/lib.rs`

The referee is 206 lines of Arcis. This doc walks each instruction, what it
proves, and the subtleties a reviewer should check. Pair with
`docs/threat-model.md` for the adversarial analysis and
`docs/evidence/calibration/` for an independently-recomputable score.

## At a glance

| instruction | in | out | what leaves MPC |
|---|---|---|---|
| `seal_part` | `Enc<Shared, AnswerPart>` | `Enc<Mxe, AnswerPart>` | nothing (re-key only) |
| `gen_part` | `benchmark_id, base_index` | `GenPart` + `Enc<Mxe, AnswerPart>` | item **specs** (public) |
| `gen_part_private` | `+ viewer x25519` | `Enc<Shared, Pack<GenPart>>` + `Enc<Mxe, AnswerPart>` | nothing plaintext |
| `reshare_part` | `Enc<Shared, Pack<GenPart>>` + viewer | `Enc<Shared, Pack<GenPart>>` | nothing (re-key only) |
| `reveal_part` | `Enc<Mxe, AnswerPart>` | `AnswerPart` | 8 fingerprint u64s |
| `score_chunk` | `[u64; 32]` + 4×`Enc<Mxe, AnswerPart>` | `u8` | the count. **only the count.** |

Constants: `CHUNK = 32` items per scoring call, `PART = 8` items per
seal/mint/reveal call. The split exists because a callback result must fit a
1232-byte Solana transaction: 8 ciphertexts ≈ 256 B fits, 32 ≈ 1 KB doesn't.

## `score_chunk` — the referee (lines 178–205)

```rust
for i in 0..PART {
    if outputs[i] == a0.hashes[i] { correct += 1; }   // …p1, p2, p3
}
correct.reveal()
```

- `outputs` arrives **public** — it is the run's pre-scoring commitment,
  already bound on-chain by `Run.outputs_root` (see `create_run` /
  `score_chunk` in `programs/sealed/src/lib.rs`; the submitted leaf must
  fold to the committed root or the tx fails).
- The four `Enc<Mxe, AnswerPart>`s are decrypted *inside* the enclave;
  per-item match bits never leave — only `correct` is `.reveal()`ed.
- Soundness: equality on `u64` fingerprints. `Run.correct` is therefore a
  pure function of (committed outputs) × (sealed fingerprints) — which is
  exactly what `scripts/rescore.mjs` and the in-browser audit reproduce.

## `mint_part` / `gen_part` — the uncontaminated item source (lines 99–131)

Each of the 8 items draws `a, b, c` from `ArcisRNG` (width-6 → 0..63) and two
ops. The answer is computed *in-circuit* (`apply_op`) and fingerprinted
in-circuit — at no point does a plaintext answer exist anywhere on Earth.

**Subtlety a reviewer should check — the op draw (lines 112–115).** Ops are
`gen_public_integer_from_width(16) % 3`, not `width(2) % 3`. A 2-bit draw
would map `{0,3}→0` making `+` 50% likely; a 16-bit draw leaves a residual
bias of 2^-16 (33.335% vs 33.332%) — statistically undetectable. The comment
documents this; the fix is deliberate.

**Fingerprint domain separation.** Generated banks use
`SHA3-256("sealed/v1/genanswer\0" ‖ id ‖ index ‖ i64le(ans))` while authored
banks use `SHA-256("sealed/v1/answer\0" ‖ id ‖ index ‖ utf8(canonical))`.
Generated answers are hashed as raw two's-complement bytes — no decimal
rendering inside MPC — while authored canonical strings hash as UTF-8.
Both are reproduced in `packages/harness/src/hash.ts` and `rescore.mjs`.

## `seal_part` — authored banks' key handoff (lines 34–38)

Author encrypts `AnswerPart` to their own `Shared` key, submits it; MPC
re-encrypts to `Mxe`. After sealing, *no single party* — not even the
author via the chain — can open the stored ciphertext; only the cluster
can, inside a computation.

## `gen_part_private` / `reshare_part` — confidential questions (139–162)

Same mint as `gen_part`, but specs return `Enc<Shared, Pack<GenPart>>` —
packed 40 bytes into two 256-bit fields, encrypted to the authority's
x25519. `reshare_part` re-keys a stored part to a *second* viewer inside
the enclave: selective disclosure of questions to a delegate, answers still
sealed. On-chain, each reshare writes a `ShareGrant` PDA — the disclosure
trail is public while the content stays private.

## `reveal_part` — audit-and-burn (169–172)

`part.to_arcis().reveal()` — declassifies the 8 fingerprint u64s. Not the
answers (those are hashes by construction). The sealed program's
`reveal_part_callback` bumps `benchmark.reveal_count`, and every
subsequently-created run is stamped `post_reveal = 1`; all four market
creators reject such runs (`PostRevealRun`). Disclosure is therefore
permanent and self-marking — nobody can quietly mint a "fresh" exam on a
burned bank.

## Reviewer checklist

- [ ] `score_chunk` compares `outputs[32]` positionally against the four
      parts in index order (part-major: `outputs[PART+i]` ↔ `p1.hashes[i]`).
      `packages/harness/src/run.ts` slices artifacts the same way.
- [ ] Nothing but the u8 count is `.reveal()`ed.
- [ ] The op-draw bias comment matches the code (width-16, not width-2).
- [ ] `gen_answer_hash` byte layout is `domain(20) ‖ id(4) ‖ index(4) ‖
      ans(8)` — mirrored by `genAnswerHash` in the harness.
- [ ] `mint_part` uses `base_index + i` in the fingerprint — fingerprints
      are position-bound; permuting items changes their hashes.
- [ ] Replay the MPC's arithmetic yourself:
      `node scripts/rescore.mjs --bank docs/evidence/calibration/bank.json
      --run docs/evidence/calibration/run-artifact.json --benchmark
      CSnhf6Qy… --snapshot web/snapshot.json` → 7 PASS / 0 FAIL.
