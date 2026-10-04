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
| `create_run(model_id, harness_hash, outputs_root)` | mints `Run` PDA `[run, benchmark, run_index]` committing to every output hash | stamps `post_reveal=1` if `benchmark.reveal_count > 0` (F1); `model_id` is self-reported runner metadata — the scored outputs + runner key are the trust-bearing fields |
| `attest_run(run_index)` | authority vouches for a run's model identity | benchmark authority only |
| `record_score(run_index, model_hash)` | enrolls a finalized run's score into the persistent `ModelRecord` aggregate + writes a `ScoreLog` receipt | permissionless; run must be finalized; `model_hash` must be `sha256(run.model_id)` so the entry binds the run's declared identity; `score_log`'s `init` on `[scorelog, run]` makes double-counting structurally impossible |
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
can invoke them, on the exact computation that was queued — and every
mutating data account additionally carries self-canonical PDA seeds (the
account must be THE PDA its own stored fields describe).

| ix | what it does | key constraints |
|---|---|---|
| `init_signer_pda` | creates the shared `ArciumSignerAccount` PDA used by every queue path | grief-proof: drains prefunded lamports back to the caller via `invoke_signed`, then `create_account` — also *un-bricks* the singleton after a successful prefund grief. Idempotent. `chain init` calls it eagerly. |
| `unbrick_pda(seeds, bump)` | sweeps a grief-prefunded PDA's lamports to the caller | permissionless. Anchor's `init` already tolerates prefunds (tops up to rent-exempt, allocate+assign) — this ix reclaims the dust *before* init so a prefunder loses it instead of donating it, and covers any manual `create_account` path. `create_program_address(seeds ‖ bump, ID) == pda` re-proves the account belongs to this program's derivation space; only a system-owned, zero-data (never-initialized) account qualifies — arbitrary wallets can never be drained. `chain unbrick sealed run <bank> <idx>` covers every layout (run/chunk/items/pitems/reveal/grant/benchmark). |

**Capability registry.** `record_score` turns a finalized `Run` into a
durable per-model artifact: `ModelRecord [modelrec, sha256(model_id)]`
aggregates `runs_scored`, `total_correct/total_items`, an accuracy-first
`best_*` (ties break toward the larger sample), and `first_seen`/
`last_scored`; `ScoreLog [scorelog, run]` snapshots `correct`, `items`,
`recorded_by`, and the honesty flags *at record time* — so a later
`attest_run` or fingerprint reveal can't rewrite history. Enrollment is
permissionless and free of trust assumptions (anyone can pay the rent; the
score itself was written by MPC), but it is **not** attestation:
`model_id` remains self-reported metadata and only
`vouched_at_record = run.attested` distinguishes authority-vouched entries.
The harness exposes it as `chain record --run <pk>` / `chain modelrec
<pubkey|model_id>`; `verify.mjs` and the explorer audit replay every
record bit-exact from its receipts. `chain gate <model_id> --min-pct N
[--min-items N] [--vouched] [--no-post-reveal] [--min-runs N]
[--wilson P]` evaluates an admission policy over a record — exit 0
pass / 1 fail / 2 no evidence — with the Wilson lower bound so
small-sample records can't flatter a gate. Same evaluation runs
in-page in the hosted explorer. `chain gate --all` applies the policy
to *every* ModelRecord and prints the ranked pass/fail table — the
capability registry as a filterable leaderboard, not a list.

`chain market positions [--bettor kp.json] [--json]` — the bettor-side
mirror: every position the wallet holds across bands/duels/ladders/darks,
classified PAYS / REFUND / LIVE / SEALED / RENT / FORFEIT with est.
pro-rata payouts (same fee math the claim ixes recompute on-chain).
Claim commands prefilled — except darks, where `pos_salt` is a PDA seed
only the bettor knows.

`chain market sweep [--bettor kp.json] [--watch secs]` runs the board then
EXECUTES every permissionless action on it — bounty claims (the pot pays
the winning run's operator, not the sweeper), `resolve`,
`resolve_ladder`, `finalize_dark`, `expire_*`, `expire_bounty`. A raced
keeper's tx fails on the already-transitioned account and the sweep
continues. `--watch` loops it into a keeper daemon — the no-operator
design as a runnable process, not a promise.

`chain market board [--json]` scans every venue account + run and reports
the keeper inventory: bounties claimable *right now* (a qualifying run is
already finalized-or-proven — the claim command prefilled), live and
expired bounties awaiting `expire_bounty`, resolvable markets/ladders,
resolved darks past `reveal_until` awaiting `finalize_dark`, and venues
past `resolve_by` awaiting `expire` (annotated settle-vs-refund — the
same `expire_decision` split the program makes). Read-only; the
classification is pure (`packages/harness/src/board.ts`) and mirrors the
on-chain `still_moving`/`proven`/`bounty_qualifies` gates exactly.

`chain history <model_id|record-pk> [--json]` lists a model's ScoreLog
receipts oldest-first with running accuracy after each — the capability
trajectory ("did it regress after the fine-tune?") answered from
on-chain data; vouched/post-reveal flags ride on every row.

`chain compare <A> <B>` joins the two models' receipts **by benchmark** —
the paired question the markets exist to price ("does A beat B on the
SAME evidence?"). Per-bank deltas, pooled shared-item score, bank-win
count, and unshared-coverage reporting. Disjoint coverage exits 2 — an
honest "the registry can't rank them" instead of an aggregate lie.
`chain banks` indexes every benchmark (kind, items, runs, best score) —
the pk list `status`/`compare` need without the explorer.
`chain compare --all` tallies every model×model pair's shared-bank
result into a W-L-T leaderboard — rankings grounded on shared evidence
only, with disjoint pairs reported as unranked rather than assumed.
`chain trail <run-pk>` prints one run's custody chain — bank, registry
receipt, and every venue that priced it — and **re-verifies each resolved
venue's score against `Run.correct`** (duel `resolved_score` unpacked
`(a << 16) | b`), so a settlement that disagreed with the run would
print ✗ MISMATCH, not get trusted.

Every read command also takes `--snapshot <file>` — `records`,
`modelrec`, `gate`, `history`, `compare`, `trail`, `status`, `banks`, `verify`,
`grants`, `market board`, `market positions`.
`packages/harness/src/snapshot.ts` decodes the committed evidence
bundle (`web/snapshot.json`) through the same discriminator-keyed
borsh layouts the RPC path uses, so the surfaces replay **keyless and
connection-free**:

```bash
sealed chain market board --snapshot web/snapshot.json   # 36 actionable — the explorer's keeper panel, in the CLI
sealed chain gate dark/model-a --min-pct 80 --min-runs 5 --snapshot web/snapshot.json
sealed chain market positions --snapshot web/snapshot.json --viewer <pubkey>
```

`positions` in snapshot mode takes `--viewer <pubkey>` — a read-only
look at any wallet's book without a keypair. Write paths (`sweep`,
`claim`, `open`, …) stay RPC+signer only, obviously.

## `market` — four parimutuel primitives + capability bounties on `Run.correct`

Every creator rejects runs that have begun scoring (`ScoringStarted`), runs
flagged `post_reveal` (`PostRevealRun`), and bait-shaped edge layouts.

| ix set | primitive | resolution |
|---|---|---|
| `create_market` / `bet` / `resolve` / `claim` / `claim_fee` / `void_market` / `expire_market` | score-band: `outcome_of(edges, n, correct)` | bucket edges must leave every outcome reachable; expiry refunds |
| `create_duel` / `bet_duel` / `resolve_duel` / `void_duel` | duel: two runs, same bank class | A wins / B wins / tie bucket; distinct runner keys required |
| `create_ladder` / `bet_ladder` / `resolve_ladder` / `claim_ladder` / `claim_fee_ladder` / `void_ladder` | race: 3–8 ordered legs | argmax → `result_mask` bitmask, dead-heats split pro-rata; legs landing nothing score 0, landed partials count |
| `create_dark` / `dark_bet` / `resolve_dark` / `reveal_dark` / `finalize_dark` / `claim_dark` / `claim_fee_dark` / `void_dark` / `expire_dark` | commit-reveal: bet tx carries only a salted sha256 | resolved → reveal window (60s–90d) → tally; zero reveals or void → gross refund; fee gated on `tallied` |

Plus a non-parimutuel primitive — no bettors, the pot pays the operator:

| ix set | primitive | settlement |
|---|---|---|
| `create_bounty` / `claim_bounty` / `expire_bounty` | capability bounty: sponsor escrows SOL on "first run scoring ≥ `threshold`" | FCFS — the first *proven* run claims; gates: same bank, run postdates bounty creation, `runner ≠ sponsor`, `correct ≥ threshold`, finalized-or-proven, not `post_reveal` — and the claim tx itself must land by `deadline` (a total deadline: entry *and* proof must exist on-chain before it; afterwards only `expire_bounty` remains). `payee` pinned to `run.runner` so front-running can't redirect. Past `deadline`, `expire_bounty` closes the account to the stored sponsor. Claimed bounties persist as permanent `winner_run`/`winning_score` evidence. |

`unbrick_pda(seeds, bump)` exists here too — same generic grief-dust
reclaim (market/duel/position/ladder/dark/darkpos/bounty layouts), e.g.
`chain unbrick market position <market> <bettor>`.

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

Measured per-instruction compute-unit costs live in [costs.md](costs.md)
(queue-side MPC ixs ~110-150k CU, callbacks ~130-160k, market ops ~4-16k).
