# Evidence bundle — model scored through an MPC-minted bank

Checkable artifacts for the headline claim: a model answered all 32 items of a
bank **minted inside Arcium MPC** — the answer key never existed in plaintext
anywhere — and the on-chain MPC score matched the local pre-score exactly.

All identifiers below refer to the current **localnet** ledger
(`http://127.0.0.1:8899`, cluster offset 0). The run account verifies live
while that ledger is up; the artifact is also self-checking offline.

## Files

- `benchmark-99004-account.json` — dump of the generated benchmark
  (id 99004, PDA `GJtU2gRqcq9HpYNEvezWey6Jfxk3fVrkFzPjC9AGDDLW`).
  `status=LIVE`, `kind=1` (generated), `items_root` `9e59c342…`. The bank's
  questions are public specs; the answers were produced and sealed inside MPC.
- `run-2W4E4TPf-account.json` — dump of the finalized run
  (`2W4E4TPfbFh6NXyFJvJVbdh5THdDMhdykNMeaRPxveU1`): model id
  `mock/oracle-0.75`, `correct=22/32`, `outputs_root` `ac15db63…`, status
  FINALIZED. The score field was written by the MPC cluster's callback
  transaction, not by the run's creator.
- `run-99004-artifact.json` — the local run artifact (model outputs, canonical
  answers, per-item output hashes, committed `outputsRoot`). Re-running the
  same model reproduces the same `outputsRoot`.
- `run-real-99003-artifact.json` — a **real model** (`openai` = gpt-oss-20b via
  the free Pollinations endpoint) answering a previous 32-item MPC-minted bank
  **32/32**, scored and finalized on-chain at the time (run
  `7pcbA5hE…`, `outputs_root` `e64f04fd…`, verified live). Its on-chain account
  lived on a previous localnet epoch — the artifact itself remains
  self-checking, and the real-model pipeline is identical (`--model openai`).
- `prove-item0.json` — `sealed prove --run run-99004-artifact.json --item 0`:
  a chunk-level Merkle proof that output 0 was in the committed root. Verify:

  ```bash
  # internal consistency (artifact's own outputsRoot):
  node scripts/verify-proof.mjs docs/evidence/prove-item0.json
  # bound to the on-chain Run account (while that ledger is live):
  node scripts/verify-proof.mjs docs/evidence/prove-item0.json \
    --run 2W4E4TPfbFh6NXyFJvJVbdh5THdDMhdykNMeaRPxveU1 \
    --rpc http://127.0.0.1:8899
  # or paste the artifact into the explorer's verify widget
  ```

  The artifact is self-checking: `itemIndex` must map into `chunkIndex`,
  `outputHash` must equal `chunkOutputs[itemIndex % 32]`, and the folded
  leaf+proof must reach the committed root. With `--run`, the verifier also
  fetches the Run account, checks its owner program + discriminator, and
  compares against the committed `outputs_root`.

- `snapshot.json` — `node scripts/snapshot.mjs` dump of every sealed + market
  program account on this ledger. The explorer renders the full UI from it
  offline (`?snapshot=` param or the "load snapshot" button) — no localnet
  needed to inspect committed state.

`mock/oracle-0.75` is the deterministic offline model — the same pipeline
(`run` → `chain score` → `prove`) works verbatim with a real model by passing
`--model openai` and the endpoint env vars; the on-chain steps are identical.

## Reproduce the whole thing yourself

```bash
# prerequisites: yarn install && arcium build; a running `arcium localnet`
export ARCIUM_CLUSTER_OFFSET=0 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=~/.config/solana/id.json
CLI="npx tsx packages/harness/src/cli.ts"

$CLI chain init                                 # one-time: comp defs + circuit upload
$CLI chain gen --id 99005 --chunks 1            # mint a fresh bank inside MPC
$CLI run --bank bank-99005.json --model mock/oracle-0.75 \
        --out /tmp/run.json                     # model answers the items
$CLI chain score --bank bank-99005.json --run /tmp/run.json
#   → "FINALIZED: N/32 (matches local pre-score)"
$CLI prove --run /tmp/run.json --item 0         # Merkle proof vs committed root
```

For a real model: `export SEALED_API_BASE=<openai-compatible-endpoint>
SEALED_API_KEY=<key>` and `--model <id>` (e.g. `openai` on the free
Pollinations endpoint is gpt-oss-20b; anonymous callers are capped at one
in-flight request, so a 32-item bank takes ~15–20 minutes at
`--concurrency 1`).
