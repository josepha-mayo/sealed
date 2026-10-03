# Measured compute-unit costs

Real `meta.computeUnitsConsumed` for every instruction, measured on the
localnet by walking blocks (`scripts/measure-cu.mjs --slots N`) after each
tx burst (`scripts/cu-sweep.sh`). Single-run samples unless `txs` > 1 —
queue-side MPC instructions scale mildly with chunk size; these rows are
the 32-item (one-chunk) shape. Failed transactions are excluded.

## `sealed` program

| instruction | txs | CU | what it does |
|---|---|---|---|
| `create_benchmark` | 2 | ~9–10k | PDA init + config write |
| `init_chunk` | 2 | ~11–12k | `AnswerChunk` allocation |
| `init_items` | 1 | ~17k | `ItemChunk` allocation |
| `init_items_private` | 1 | ~9k | `PrivItemChunk` allocation |
| `stage_part` | 4 | ~8.3k | buffer part ciphertext into the chunk account |
| `seal_part` (queue) | 4 | ~108–112k | `queue_computation` for the seal circuit |
| `seal_part_callback` | 4 | ~137–147k | callback lands fingerprints + part mask |
| `gen_part` (queue) | 4 | ~125–130k | MPC mints a public bank's items in-circuit |
| `gen_part_callback` | 4 | ~155–165k | writes items + fingerprints on callback |
| `gen_part_private` (queue) | 4 | ~116–125k | same, specs returned `Enc<Shared>` |
| `gen_part_private_callback` | 4 | ~144–159k | writes ciphertext-only specs |
| `init_signer_pda` | 1 | ~7.5k | grief-proof shared-signer init |
| `unbrick_pda` | 1 | ~5.6k | grief-dust reclaim: PDA re-derivation + one signed transfer |
| `record_score` | 1 | ~18.4k | first-enroll path: `ModelRecord` + `ScoreLog` creates + event (dup reject ~14k) |
| `create_run` | 1 | ~14.5k | run PDA + committed `outputs_root` |
| `score_chunk` (queue) | 1 | ~150k | `queue_computation` per chunk |
| `score_chunk_callback` | 1 | ~156k | writes `Run.correct`, clears pending bits |
| `reshare_part` (queue) | 1 | ~128k | x25519 re-encryption grant |
| `reshare_part_callback` | 1 | ~137k | writes `ShareGrant` ciphertext |
| `reveal_part` (queue) | 1 | ~114k | declassify 8 fingerprints for audit |
| `reveal_part_callback` | 1 | ~133k | writes `Reveal`, bumps `reveal_count` |

Pattern: queue-side MPC instructions run ~110–150k CU (computation
account + queueing); their callbacks run ~130–160k CU (decrypt sizes +
account writes). Plain account ops sit ~8–18k. Everything fits in a
default 200k CU budget — no `setComputeUnitLimit` needed anywhere in the
harness; headroom stays >20%.

## `market` program

| instruction | txs | CU | what it does |
|---|---|---|---|
| `create_market` | 2 | ~10.5–12k | score-band parimutuel PDA on a pending run |
| `bet` | 3 | ~13–19k | position PDA + escrow lamports |
| `resolve` | 2 | ~6.3–7k | outcome = f(`run.correct`), pool split |
| `claim` | 3 | ~7.2–7.6k | winner payout (or gross refund on cancel) |
| `claim_fee` | 1 | ~4.3k | take-rate sweep after resolution |
| `create_duel` | 1 | ~14.4k | head-to-head market over two bound runs |
| `bet_duel` | 1 | ~18.4k | position on A-wins / B-wins / tie |
| `resolve_duel` | 1 | ~7.4k | argmax both runs' `correct` |
| `create_ladder` | 1 | ~12.9k | K-way argmax market, 3–8 bound legs |
| `bet_ladder` | 1 | ~19.8k | position keyed to leg index |
| `resolve_ladder` | 1 | ~9.6k | argmax mask over all legs |
| `claim_ladder` | 1 | ~7.8k | winner/dead-heat pro-rata payout |
| `claim_fee_ladder` | 1 | ~4.4k | take-rate sweep |
| `create_dark` | 2 | ~11.7–13.2k | commit-reveal market |
| `bet_dark` | 2 | ~14.6–20.6k | position = sha256 commitment only |
| `resolve_dark` | 2 | ~6.5k | opens the reveal window |
| `reveal_dark` | 1 | ~7.5k | preimage check → stake counted |
| `finalize_dark` | 1 | ~3.7k | tally after window close; forfeits priced |
| `claim_dark` | 1 | ~7.4k | winner payout after finalize |
| `claim_fee_dark` | 1 | ~4.1k | fee sweep (tallied-gated) |
| `create_bounty` | 2 | ~9.9k | sponsor escrow, threshold + deadline |
| `claim_bounty` | 1 | ~6.1k | FCFS payout to `run.runner` |
| `expire_bounty` | 1 | ~4.4k | close → refund to stored sponsor |

Market instructions are pure lamport accounting — 4–20k CU each, i.e.
trivially cheap; a full open→bet→resolve→claim lifecycle costs less than
one MPC queue ix. The dark lifecycle (open→bet→resolve→reveal→finalize→
claim→fee) totals ~50k CU across seven transactions.

## Devnet reference points (measured pre-upgrade, same code paths)

`gen_part` queue ~132–158k, `reset_sealing` ~7.6k, `create_benchmark`
~8–11k, `init_items` ~15–17k, `init_chunk` ~11–12k — consistent with the
localnet table (devnet adds no premium; CU is deterministic).

## How to re-measure

```bash
# any history-indexing RPC (devnet/mainnet/full validator):
node scripts/measure-cu.mjs https://api.devnet.solana.com --limit 200

# solana-test-validator (no signature index) — walk blocks:
bash scripts/cu-sweep.sh           # sealed-pipeline tx mix + measurement
bash scripts/cu-sweep-markets.sh   # duel/ladder/dark/band market mix
bash scripts/cu-dark-claim.sh      # dark reveal→finalize→claim cycle
bash scripts/cu-band-fee.sh        # fully-backed book → claim + fee sweep
node scripts/measure-cu.mjs http://127.0.0.1:8899 --slots 400
```

Note: `solana-test-validator` serves `getBlock` but not
`getSignaturesForAddress`, and prunes to the last few hundred slots —
measure right after a tx burst, not hours later (the sweep scripts
interleave `measure` calls between phases for exactly this reason).
A one-sided band book is cancelled by the `all_backed` guard on resolve
(gross refunds), so `claim_fee` only lands on a book with every bucket
backed — that is why the fee row needed its own two-sided script.
