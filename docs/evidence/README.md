# Evidence bundle — model scored through an MPC-minted bank

Checkable artifacts for the headline claim: a model answered 64 items of a
bank **minted inside Arcium MPC** — the answer key never existed in plaintext
anywhere — and the on-chain MPC score matched the local pre-score exactly.

All identifiers below refer to the current **localnet** ledger
(`http://127.0.0.1:8899`, cluster offset 0), produced by `scripts/demo.sh`
running end-to-end. The accounts verify live while that ledger is up; the
artifacts are also self-checking offline.

## Files

- `benchmark-25864-account.json` — dump of the generated benchmark
  (id 25864, PDA `6ZTikUCZ4tAEtcMai29X7bNLBjJU5RDqHcv6xXBnH9Cd`).
  `status=LIVE`, `kind=1` (generated), `items_root` `4eae8312…`. The bank's
  questions are public specs; the answers were produced and sealed inside MPC.
- `benchmark-25865-account.json` — dump of the **private** generated benchmark
  (id 25865, PDA `4MK3Nemeb6VysuZH1WNwHEBMeoJW87dSWEsCpyPtw9VD`), `kind=2`.
  Its item specs exist on-chain only as ciphertext encrypted to the
  authority's x25519 key — the account is proof that a benchmark can be
  minted with *no plaintext questions at all*.
- `run-4uns99WD-account.json` — dump of the finalized run
  (`4uns99WDqEFZCzNXa7KhW361CKd4XB5x7CLDX8THfJZ1`): model id
  `mock/oracle-0.75`, `correct=47/64`, `outputs_root` `8712eb4a…`, status
  FINALIZED. The score field was written by the MPC cluster's callback
  transaction, not by the run's creator. A second run (`3CKnMa8X…`,
  `mock/oracle-0.50`, 35/64) was created by a *separate* judge wallet and
  settled a duel market (`FpUyVX5s…`, A wins 47–35).
- `run-25864-artifact.json` — the local run artifact (model outputs, canonical
  answers, per-item output hashes, committed `outputsRoot`). Re-running the
  same model reproduces the same `outputsRoot`.
- `run-real-99003-artifact.json` — a **real model** (`openai` = gpt-oss-20b via
  the free Pollinations endpoint) answering a previous 32-item MPC-minted bank
  **32/32**, scored and finalized on-chain at the time (run
  `7pcbA5hE…`, `outputs_root` `e64f04fd…`, verified live). Its on-chain account
  lived on a previous localnet epoch — the artifact itself remains
  self-checking, and the real-model pipeline is identical (`--model openai`).
- `prove-item0.json` — `sealed prove --run run-25864-artifact.json --item 0`:
  a chunk-level Merkle proof that output 0 was in the committed root. Verify:

  ```bash
  # internal consistency (artifact's own outputsRoot):
  node scripts/verify-proof.mjs docs/evidence/prove-item0.json
  # bound to the on-chain Run account (while that ledger is live):
  node scripts/verify-proof.mjs docs/evidence/prove-item0.json \
    --run 4uns99WDqEFZCzNXa7KhW361CKd4XB5x7CLDX8THfJZ1 \
    --rpc http://127.0.0.1:8899
  # or paste it into the explorer's verify widget — "load example" loads a copy
  ```

  The artifact is self-checking: `itemIndex` must map into `chunkIndex`,
  `outputHash` must equal `chunkOutputs[itemIndex % 32]`, and the folded
  leaf+proof must reach the committed root. With `--run`, the verifier also
  fetches the Run account, checks its owner program + discriminator, and
  compares against the committed `outputs_root`.

- `snapshot.json` — `node scripts/snapshot.mjs` dump of every sealed + market
  program account on this ledger (88 + 30 accounts: banks, chunks, runs,
  grants, markets, positions). The explorer renders the full UI from it
  offline (`?snapshot=` param, the "load snapshot" button, or the bundled
  `web/snapshot.json` auto-fallback) — no localnet needed to inspect
  committed state.

`mock/oracle-0.75` is the deterministic offline model — the same pipeline
(`run` → `chain score` → `prove`) works verbatim with a real model by passing
`--model openai` and the endpoint env vars; the on-chain steps are identical.

## Reproduce the whole thing yourself

```bash
# prerequisites: yarn install && arcium build; a running localnet
# (scripts/localnet-up.sh relaunches validator + arx nodes from artifacts/)
export ARCIUM_CLUSTER_OFFSET=0 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=~/.config/solana/id.json
CLI="npx tsx packages/harness/src/cli.ts"

$CLI chain init                                 # one-time: comp defs + circuit upload
$CLI chain gen --id 99005 --chunks 1            # mint a fresh bank inside MPC
$CLI run --bank bank/gen-99005.json --model mock/oracle-0.75 \
        --out /tmp/run.json                     # model answers the items
$CLI chain score --bank bank/gen-99005.json --run /tmp/run.json
#   → "FINALIZED: N/32 (matches local pre-score)"
$CLI prove --run /tmp/run.json --item 0         # Merkle proof vs committed root
```

…or run the full narrative in one shot: `scripts/demo.sh` — generated bank,
private bank, selective disclosure, two runs (incl. a separate-runner run),
binary + 3-way + duel markets, resolution, payouts, leaderboard.

For a real model: `export SEALED_API_BASE=<openai-compatible-endpoint>
SEALED_API_KEY=<key>` and `--model <id>` (e.g. `openai` on the free
Pollinations endpoint is gpt-oss-20b; anonymous callers are capped at one
in-flight request, so a 32-item bank takes ~15–20 minutes at
`--concurrency 1`).
