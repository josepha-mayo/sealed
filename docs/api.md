# API surface

Every public instruction, its purpose, and its guard rails. Source of truth:
`programs/sealed/src/lib.rs`, `programs/market/src/lib.rs`, `encrypted-ixs/src/lib.rs`.
Program IDs — sealed `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ`,
market `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN`.

## `sealed` — banks, runs, MPC lifecycle

Plain instructions:

| ix | what it does | key constraints |
|---|---|---|
| `create_benchmark(items_root, kind, …)` | registers a bank PDA `[benchmark, authority, id]` | items_root commits to questions (authored) or ciphertext (generated) |
| `init_chunk` / `init_items` / `init_items_private` | allocates `AnswerChunk` / `ItemChunk` / `PrivItemChunk` for chunk `index` | seeds bind benchmark + index |
| `stage_part(index, part, …)` | author writes 8 items' encrypted answers + spec commitments | authority-only; rejected once sealing starts for that part |
| `create_run(model_id, harness_hash, outputs_root)` | mints `Run` PDA `[run, benchmark, run_index]` committing to every output hash | stamps `post_reveal=1` if `benchmark.reveal_count > 0` (F1) |
| `attest_run(run_index)` | authority vouches for a run's model identity | benchmark authority only |
| `reset_pending` / `reset_sealing` | liveness sweeps: clear stalled pending bits / sealing locks | permissionless — a stalled queue can be cleared by anyone |
| `retire_benchmark` | stops new runs/chunks on the bank | authority; refused while runs pending |

MPC-boundary instructions (queue → Arcium computes → `*_callback` writes):

| queue ix | circuit | callback writes |
|---|---|---|
| `seal_part(index, part)` | `seal_part`: `Enc<Shared> → Enc<Mxe>` re-encryption | sealed ciphertext into `AnswerChunk` |
| `gen_part(id, base_index)` | `gen_part`: ArcisRNG specs + in-circuit answers | public `ItemChunk` specs + sealed answer ciphertext |
| `gen_part_private` | same, but specs returned `Enc<Shared>` to authority | ciphertext-only `PrivItemChunk` |
| `score_chunk(run_index, index)` | `score_chunk`: compares committed output hashes vs sealed answers, reveals count only | `scored_mask` bit + `correct` count on `Run` |
| `reveal_part(index, part)` | `reveal_part`: declassifies fingerprints | `Reveal` account + bumps `benchmark.reveal_count` (burn) |
| `reshare_part(index, part, viewer)` | `reshare_part`: re-encrypts specs to viewer x25519 | `ShareGrant` PDA — questions only, never answers |

All callbacks are gated by `callback_computation` — only the Arcium cluster
can invoke them, on the exact computation that was queued.

## `market` — five parimutuel primitives on `Run.correct`

Every creator rejects runs that have begun scoring (`ScoringStarted`), runs
flagged `post_reveal` (`PostRevealRun`), and bait-shaped edge layouts.

| ix set | primitive | resolution |
|---|---|---|
| `create_market` / `bet` / `resolve` / `claim` / `claim_fee` / `void_market` / `expire_market` | score-band: `outcome_of(edges, n, correct)` | bucket edges must leave every outcome reachable; expiry refunds |
| `create_duel` / `bet_duel` / `resolve_duel` / `void_duel` | duel: two runs, same bank class | A wins / B wins / tie bucket; distinct runner keys required |
| `create_ladder` / `bet_ladder` / `resolve_ladder` / `claim_ladder` / `claim_fee_ladder` / `void_ladder` | race: 3–8 ordered legs | argmax → `result_mask` bitmask, dead-heats split pro-rata; legs landing nothing score 0, landed partials count |
| `create_dark` / `dark_bet` / `resolve_dark` / `reveal_dark` / `finalize_dark` / `claim_dark` / `claim_fee_dark` / `void_dark` / `expire_dark` | commit-reveal: bet tx carries only a salted sha256 | resolved → reveal window (60s–90d) → tally; zero reveals or void → gross refund; fee gated on `tallied` |

## `encrypted-ixs` — the six Arcis circuits

```rust
seal_part(Enc<Shared, AnswerPart>)          -> Enc<Mxe, AnswerPart>
gen_part(benchmark_id, base_index)          -> (GenPart, Enc<Mxe, AnswerPart>)
gen_part_private(benchmark_id, base_index)  -> (Enc<Shared, GenPart>, Enc<Mxe, AnswerPart>)
reshare_part(Enc<Mxe, Pack<GenPart>>, viewer_x25519) -> Enc<Shared, Pack<GenPart>>
reveal_part(Enc<Mxe, AnswerPart>)           -> AnswerPart            // plaintext u64 fingerprints
score_chunk(outputs[32]u64, Enc<Mxe, AnswerPart>×4) -> u8            // count only — match bits stay inside
```

Only `reveal_part` returns plaintext — and only fingerprints (SHA3-256
truncated u64s), which is why a landed reveal burns the bank for future
runs. `score_chunk` reveals a count, never per-item results.
