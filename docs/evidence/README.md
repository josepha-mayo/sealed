# Evidence bundle — real model scored on an MPC-minted bank

Checkable artifacts for the headline claim: a real model
(`openai` = gpt-oss-20b) answered all 64 items of bank 6932 — minted
inside MPC, so no answer key exists anywhere — and the on-chain MPC score
matched the local pre-score exactly: **64/64** (run `HW5H5bT7…`).

A second real-model run scored **64/64** on authored bank 25864 (run
`4uns99WD…` — an authored `kind=0` bank; only its answer fingerprints
live on-chain, sealed to the MXE key).

The same bank also carries the counter-demonstration: a stale artifact
claiming 64/64 locally was scored **1/64** on-chain. The protocol never
trusts a runner's self-reported score — MPC is the sole arbiter. The 1/64
run was reproduced via `scripts/score-artifact-insecure.mts` (a
deliberately-named bypass of the client-side binding check) — the check
is UX; even bypassed, the cluster tallies a stale artifact honestly.

All identifiers below refer to the current **localnet** ledger
(`http://127.0.0.1:8899`, cluster offset 0), produced by `scripts/demo.sh`
running end-to-end plus a real-model pipeline run. The accounts verify live
while that ledger is up; the artifacts are also self-checking offline.

## Files

### Benchmarks

- `acct-EQsejQ89….json` — **the MPC-minted bank** (id 6932, PDA
  `EQsejQ899p9ZjrBfXKT8LRW1dyZdNgTKbGqMjRGDaJkW`), `status=LIVE`, `kind=1`,
  `items_root` `c4e1c840…`. Item specs public; the answer key was produced
  and sealed inside MPC — it never existed in plaintext anywhere.
- `acct-6ZTikUCZ….json` — benchmark id 25864 (PDA
  `6ZTikUCZ4tAEtcMai29X7bNLBjJU5RDqHcv6xXBnH9Cd`), `kind=0` authored,
  `items_root` `e6a614da…` — the exact item set the real model answered,
  sealed so its answer fingerprints live only as MPC ciphertexts.
- `acct-VyAAjrsB….json` — the demo's **private** generated benchmark
  (id 6933, PDA `VyAAjrsBiUkMumc8PqpA9nTzMyBsQ7uHMDf1AWQHFk3`), `kind=2`.
  Its item specs exist on-chain only as ciphertext encrypted to the
  authority's x25519 key — proof that a benchmark can be minted with
  *no plaintext questions at all*.

### Runs

- `acct-HW5H5bT7….json` — **the headline run.** `openai` (gpt-oss-20b via
  anonymous Pollinations), run #2 on MPC-minted bank 6932: `correct=64/64`,
  `outputs_root` `0c305939…`, FINALIZED — every digit written by the MPC
  cluster's callback transactions, matching the local pre-score exactly.
  The items it answered were born inside the enclave; no plaintext answer
  key has ever existed.
- `run-gen6932-real-artifact.json` — its local artifact: raw outputs,
  canonical answers, per-item output hashes, `itemsRoot` binding it to
  this exact bank revision.
- `prove-gen-item0.json` — Merkle proof that output 0 was in this run's
  committed root (`runPda` field anchors it to the on-chain account —
  the explorer's "load example" verifies it live).
- `acct-4uns99WD….json` — second real-model run, `openai` (gpt-oss-20b)
  on authored bank 25864: `correct=64/64`, `outputs_root` `f6aa29a3…`,
  FINALIZED.
- `run-25864-v2-artifact.json` — its local artifact: raw outputs,
  canonical answers, per-item output hashes, `itemsRoot` `e6a614da…`
  binding it to this exact bank revision.
- `acct-3CKnMa8X….json` — **the anti-cheat demonstration.** Run #1 on the
  same bank, same model id — the artifact claimed `localCorrect=64/64`,
  but it answered a *previous revision* of the bank (pre-binding; the
  current harness now refuses such artifacts outright — see below). MPC
  scored it **1/64** (one coincidental match) and the on-chain
  `Run.correct` permanently records the truth.
- `run-25864-stale-artifact.json` — the local artifact behind the 1/64
  run: outputs, canonical answers, per-item output hashes. Self-checking
  offline. Re-scoring it today fails fast — `chain score` rejects any
  artifact whose `itemsRoot` is missing or doesn't match the on-chain
  bank (the binding fix this incident motivated).
- `acct-FPsmr36j….json` — demo run on the MPC-minted bank 6932:
  `mock/oracle-0.75`, `correct=43/64`, FINALIZED. Score written by the
  MPC cluster's callback, not the runner.
- `acct-zbgZVGwL….json` — second demo run: `mock/oracle-0.50`,
  `correct=28/64`, created by a *separate judge wallet* (the
  `RunnersMustDiffer` duel path).
- `run-real-99003-artifact.json` — historical real-model artifact: a
  previous 32-item MPC-minted bank answered **32/32** and scored on-chain
  at the time (run `7pcbA5hE…`). Its ledger epoch is gone; the artifact
  remains self-checking and the pipeline is identical (`--model openai`).

### Markets

- `acct-Cesn1pNB….json` — binary market (`< 48 | >= 48`) resolved to
  `< 48` off the finalized 43/64 score.
- `acct-52tXNbsX….json` — 3-way score-band market (`< 32 | 32–47 | >= 48`)
  resolved to `32–47`.
- `acct-5wtfwEkE….json` — duel market resolved on-chain: run A (43/64)
  beat run B (28/64) → outcome "A wins", pool paid out.
- `acct-3Kv748WJ….json` — a `ShareGrant` PDA: selective-disclosure record
  delegating chunk-0 part-0 of the private bank to a judge wallet.
- `acct-7XGyUoc3….json` — a resolved **ladder race** (K-way argmax market):
  three runs of generated bank `GM1nPcr7…` scored 46/30/17 by MPC →
  `result_mask=0b1`, winning score 46, pot paid pro-rata. Legs:
  `acct-DhWJ4n86…` (46), `acct-HHYFCPT2…` (30), `acct-HnM9ffHU…` (17).
- `acct-Cej6nELe….json` — a resolved **8-leg ladder** (`scripts/ladder8.sh`):
  eight runners × eight MPC-finalized runs scored 30/28/27/24/19/14/9/7 →
  `result_mask=0b1`, leg 0 paid pro-rata. This is the maximum-width path
  through `load_legs`' ordered account check and the full `u8` result mask.

### Later ledger generations (post-wipe, not in `snapshot.json`)

- **Unseen-exam market** (`scripts/unseen.sh`, run twice live): private bank
  `Fa4WS8B1…` (specs ciphertext-only for the market's whole life) → pending
  run `Fdbqwk7A…` → market `HKnKiFTS…` opened + filled both sides → MPC
  finalized 16/32 → resolved, sole `< 20` winner paid 0.28 SOL pro-rata.
  First run of the same script: market `2v2WqSyG…` resolved 19/32 the same
  way. Full terminal record: `../unseen.cast`.
- **Dead-heat ladder** (E2E suite): legs tied 25/25 vs 10 → `result_mask
  0b011`, co-leaders split the loser's stake pro-rata plus rent refunds.

### Proof + snapshot

- `prove-gen-item0.json` / `prove-item0.json` — `sealed prove --run <artifact>
  --item 0`: chunk-level Merkle proofs that output 0 was in each committed
  root (gen-bank and 25864 runs respectively). Verify:

  ```bash
  # internal consistency (artifact's own outputsRoot):
  node scripts/verify-proof.mjs docs/evidence/prove-item0.json
  # bound to the on-chain Run account (while that ledger is live):
  node scripts/verify-proof.mjs docs/evidence/prove-gen-item0.json \
    --run HW5H5bT716jdTL9zVA1WuzqFDpuzAxS4tKWAgxhuyRhU \
    --rpc http://127.0.0.1:8899
  node scripts/verify-proof.mjs docs/evidence/prove-item0.json \
    --run 4uns99WDqEFZCzNXa7KhW361CKd4XB5x7CLDX8THfJZ1 \
    --rpc http://127.0.0.1:8899
  # or paste it into the explorer's verify widget — "load example" loads a copy
  ```

- `snapshot.json` — `node scripts/snapshot.mjs` dump of every sealed +
  market program account on this ledger (banks, chunks, runs, grants,
  markets, positions). The explorer renders the full UI from
  it offline (`?snapshot=` param, "load snapshot", or the bundled
  `web/snapshot.json` auto-fallback) — no localnet needed.

`mock/oracle-*` is the deterministic offline model — the same pipeline
(`run` → `chain score` → `prove`) works verbatim with a real model via
`--model openai` + endpoint env vars; the on-chain steps are identical.

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
SEALED_API_KEY=<key>` and `--model <id>`. The headline run above used
`openai` on the anonymous Pollinations tier
(`SEALED_API_BASE=https://text.pollinations.ai/openai
SEALED_API_KEY=anonymous`, `--max-tokens 512 --concurrency 1`) — the free
tier credit-walls in bursts (a billing notice returned as a normal 200
reply, which the harness rejects via provider-error signatures + the
identical-replies guard), so `scripts/real-model-run.sh` retries through the
gaps. Any funded OpenAI-compatible endpoint works the same way.
