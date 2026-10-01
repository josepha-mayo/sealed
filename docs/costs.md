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
| `create_market` | 1 | ~12k | parimutuel market PDA on a pending run |
| `bet` | 1 | ~15.8k | position PDA + escrow lamports |
| `resolve` | 1 | ~6.3k | outcome = f(`run.correct`), pool split |
| `claim` | 1 | ~7.2k | winner payout + position close |
| `create_dark` | 1 | ~11.7k | commit-reveal market |
| `bet_dark` | 1 | ~14.6k | position = sha256 commitment only |
| `resolve_dark` | 1 | ~6.5k | opens the reveal window |
| `create_bounty` | 2 | ~9.9k | sponsor escrow, threshold + deadline |
| `claim_bounty` | 1 | ~6.1k | FCFS payout to `run.runner` |
| `expire_bounty` | 1 | ~4.4k | close → refund to stored sponsor |

Market instructions are pure lamport accounting — 4–16k CU each, i.e.
trivially cheap; a full open→bet→resolve→claim lifecycle costs less than
one MPC queue ix.

## Devnet reference points (measured pre-upgrade, same code paths)

`gen_part` queue ~132–158k, `reset_sealing` ~7.6k, `create_benchmark`
~8–11k, `init_items` ~15–17k, `init_chunk` ~11–12k — consistent with the
localnet table (devnet adds no premium; CU is deterministic).

## How to re-measure

```bash
# any history-indexing RPC (devnet/mainnet/full validator):
node scripts/measure-cu.mjs https://api.devnet.solana.com --limit 200

# solana-test-validator (no signature index) — walk blocks:
bash scripts/cu-sweep.sh           # runs the tx mix + measures each phase
node scripts/measure-cu.mjs http://127.0.0.1:8899 --slots 400
```

Note: `solana-test-validator` serves `getBlock` but not
`getSignaturesForAddress`, and prunes to the last few hundred slots —
measure right after a tx burst, not hours later.
