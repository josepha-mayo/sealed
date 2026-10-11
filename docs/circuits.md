# Circuit review guide — `encrypted-ixs/src/lib.rs`

The referee is 275 lines of Arcis. This doc walks each instruction, what it
proves, and the subtleties a reviewer should check. Pair with
`docs/threat-model.md` for the adversarial analysis and
`docs/evidence/calibration/` for an independently-recomputable score.

## At a glance

| instruction | in | out | what leaves MPC |
|---|---|---|---|
| `seal_part` | `Enc<Shared, AnswerPart>` | `Enc<Mxe, AnswerPart>` | nothing (re-key only) |
| `gen_part` | `benchmark_id, base_index` | `GenPart` + `Enc<Mxe, AnswerPart>` | item **specs** (public) |
| `gen_part_private` | `+ viewer x25519` | `Enc<Shared, Pack<GenPart>>` + `Enc<Mxe, AnswerPart>` + `[u8;32]` | one spec-commitment digest |
| `reshare_part` | `Enc<Shared, Pack<GenPart>>` + viewer | `Enc<Shared, Pack<GenPart>>` + `[u8;32]` | the recomputed spec commitment |
| `reveal_part` | `Enc<Mxe, AnswerPart>` | `AnswerPart` | 8 fingerprint u64s |
| `score_chunk` | `[u64; 32]` + 4×`Enc<Mxe, AnswerPart>` | `u8` | the count. **only the count.** |

Constants: `CHUNK = 32` items per scoring call, `PART = 8` items per
seal/mint/reveal call. The split exists because a callback result must fit a
1232-byte Solana transaction: 8 ciphertexts ≈ 256 B fits, 32 ≈ 1 KB doesn't.

## How a callback proves it came from the cluster

Every instruction lands on-chain through a `*_callback` carrying
`SignedComputationOutputs<T>`; the program calls `output.verify_output(...)`
in each of the six callbacks. Under that call is Arcium's committee
authentication: cluster nodes sign the executed output with their BLS keys
and the result the program accepts is the **aggregate** — a computation
result is only writable if the committee attested it, never a lone node.
The circuit evidence card (`sealed-circuit/v1`,
`docs/evidence/circuit/arcium-devnet.json`) goes further than naming the
accounts: it pins sha256 of the actual deployed artifacts — the six compdef
headers, the six raw-circuit bytecode accounts (~1.3 MB the cluster
executes), the MXE, and the cluster account — plus the cluster's aggregated
**BLS public key and node count**, all bound byte-for-byte to the committed
`web/arcium-infra.json` dump. Identity *and* content: a re-uploaded circuit
keeps its PDA but not its hash.

## Why these circuits are written the way they are

- **Fixed structure, no secret-dependent branches.** Arcis compiles each
  instruction to a fixed-shape MPC circuit; control flow cannot early-exit
  on a secret value. Scoring is therefore an unconditional 32-way compare
  over all four parts — `for i in 0..PART { if outputs[i] == … }` — with
  every iteration executed. The temptation to "skip scored chunks" would
  leak through timing/shape; the honest version is written flat.
- **Public draw vs secret share is a choice you make per draw.**
  `ArcisRNG::gen_public_integer_from_width` reveals the value to every
  cluster node — fine for `gen_part`, whose specs are public by design.
  `gen_part_private` cannot afford that: a public draw would hand each node
  the plaintext questions *and* the answers it computes. It uses
  `gen_integer_from_width` — the operands stay secret shares — and pays the
  secret-modulo + secret-SHA3 cost deliberately (minting is one-time).
- **Aggregate-only declassification.** `score_chunk` reveals the u8 sum and
  nothing else; `gen_part_private` reveals only the spec commitment.
  Every `.reveal()` in the file is listed in the table — a reviewer can
  verify the declassification surface by grep.
- **Commitments as public anchors.** `spec_commitment` = SHA3-256 over
  `"sealed/v1/speccommit\0" ‖ 8×[a,b,c,op0,op1]` — minted inside MPC and
  stored on the `PrivItemChunk`, re-emitted by `reshare_part` onto every
  `ShareGrant`. A delegate re-hashes its decrypted specs and proves it
  received *the committed exam*, not a substitute — the grant becomes
  verifiable, not just deliverable.
- **Idempotent callbacks.** `revealed_at == 0` / `shared_at == 0` guards in
  the reveal/reshare callbacks reject a duplicated Arcium result landing
  twice — MPC is asynchronous; "apply exactly once" is a contract the
  callback enforces, not a network assumption.

## `score_chunk` — the referee

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
- The four `Enc<Mxe, AnswerPart>`s are decrypted *inside* the MPC cluster;
  per-item match bits never leave — only `correct` is `.reveal()`ed.
- Soundness: equality on `u64` fingerprints. `Run.correct` is therefore a
  pure function of (committed outputs) × (sealed fingerprints) — which is
  exactly what `scripts/rescore.mjs` and the in-browser audit reproduce.

## `mint_part` / `mint_part_secret` — the uncontaminated item source

Each of the 8 items draws `a, b, c` from `ArcisRNG` (width-6 → 0..63) and two
ops. The answer is computed *in-circuit* (`apply_op`) and fingerprinted
in-circuit — at no point does a plaintext answer exist anywhere on Earth.
`gen_part` uses `mint_part` (public draws — the specs are public anyway);
`gen_part_private` uses `mint_part_secret` (secret-share draws — nodes see
nothing, which is the difference between "confidential questions" and "the
cluster saw your exam paper as it was printed").

**Subtlety a reviewer should check — the op draw.** Ops are
`gen_*_integer_from_width(16) % 3`, not `width(2) % 3`. A 2-bit draw
would map `{0,3}→0` making `+` 50% likely; a 16-bit draw leaves a residual
bias of 2^-16 (33.335% vs 33.332%) — statistically undetectable. The comment
documents this; the fix is deliberate — and in `mint_part_secret` the draw
itself is a share, so the modulo runs *inside* MPC rather than leaking the
choice.

**Fingerprint domain separation.** Generated banks use
`SHA3-256("sealed/v1/genanswer\0" ‖ id ‖ index ‖ i64le(ans))` while authored
banks use `SHA-256("sealed/v1/answer\0" ‖ id ‖ index ‖ utf8(canonical))`.
Generated answers are hashed as raw two's-complement bytes — no decimal
rendering inside MPC — while authored canonical strings hash as UTF-8.
Both are reproduced in `packages/harness/src/hash.ts` and `rescore.mjs`.

## `seal_part` — authored banks' key handoff

Author encrypts `AnswerPart` to their own `Shared` key, submits it; MPC
re-encrypts to `Mxe`. After sealing, *no single party* — not even the
author via the chain — can open the stored ciphertext; only the cluster
can, inside a computation.

## `gen_part_private` / `reshare_part` — confidential questions

`mint_part_secret` draws the specs as secret shares, packs 40 spec bytes
into `Pack<GenPart>`, encrypts to the viewer's x25519 (`Shared`), and
reveals the public `spec_commitment` alongside. `reshare_part` re-keys a
stored part to a *second* viewer inside the cluster — selective disclosure
of questions to a delegate, answers still sealed — and recomputes the
commitment over the *decrypted* specs, so the grant carries proof it
transports the same exam the bank committed. On-chain, each reshare writes
a `ShareGrant` PDA — the disclosure trail is public while the content stays
private.

## `reveal_part` — audit-and-burn

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
- [ ] `mint_part`/`mint_part_secret` use `base_index + i` in the fingerprint
      — fingerprints are position-bound; permuting items changes their
      hashes.
- [ ] The card binds what executes, not just where it lives:
      `chain circuit --verify docs/evidence/circuit/arcium-devnet.json
      --snapshot web/snapshot.json` re-derives the six raw-circuit PDAs,
      sha256s the committed bytecode, and byte-presence-checks the
      cluster's aggregate BLS key.
- [ ] Replay the MPC's arithmetic yourself:
      `node scripts/rescore.mjs --bank docs/evidence/calibration/bank.json
      --run docs/evidence/calibration/run-artifact.json --benchmark
      CSnhf6Qy… --snapshot web/snapshot.json` → 7 PASS / 0 FAIL.
