# Evidence bundle — real model through an MPC-minted bank

Checkable artifacts for the headline claim: a real model (gpt-oss-20b via the
free Pollinations OpenAI-compatible endpoint) answered all 32 items of a bank
minted inside Arcium MPC, and the on-chain MPC score matched the local
pre-score exactly.

## Files

- `benchmark-99001-account.json` — `solana account` dump of the generated
  benchmark (id 99001). `status=LIVE`, `kind=1` (generated), `items_root`
  `32f2b448…`.
- `run-G5X7Ly4r-account.json` — `solana account` dump of the finalized run:
  model id `openai`, `correct=32`, `outputs_root` `3a75a0a8…`, status
  FINALIZED. The score field was written by the MPC cluster's callback
  transaction, not by the run's creator.
- `run-99001-artifact.json` — the local run artifact (model outputs, canonical
  answers, per-item output hashes, committed `outputsRoot`). Re-running the
  same model reproduces the same `outputsRoot`.
- `prove-item0.json` — `sealed prove --run run-99001-artifact.json --item 0`:
  Merkle proof that output 0 was in the committed root. Recompute the root
  from the proof and compare with the `outputs_root` in the account dump.

## Reproduce the whole thing yourself

```bash
# prerequisites: yarn install && arcium build; a running `arcium localnet`
export SEALED_CLUSTER_OFFSET=0 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export SEALED_API_BASE=https://text.pollinations.ai/openai SEALED_API_KEY=anon
CLI="yarn -s --cwd packages/harness cli"

$CLI chain gen --id 99002 --chunks 1            # mint a fresh bank inside MPC
$CLI run --bank bank/gen-99002.json --model openai --concurrency 1 \
        --out /tmp/run.json                     # gpt-oss-20b answers the items
$CLI chain score --bank bank/gen-99002.json --run /tmp/run.json
#   → "FINALIZED: N/32 (matches local pre-score)"
$CLI prove --run /tmp/run.json --item 0         # Merkle proof vs on-chain root
```

`openai` on that endpoint is gpt-oss-20b; anonymous callers are capped at one
in-flight request, so a 32-item bank takes ~15–20 minutes at `--concurrency 1`.
