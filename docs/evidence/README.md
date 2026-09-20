# Evidence bundle — model scored through an MPC-minted bank

Checkable artifacts for the headline claim: models answer banks **minted
inside Arcium MPC** — the answer key never exists in plaintext anywhere —
and the on-chain MPC score is the only score that counts. This bundle also
contains a live demonstration of *why* that matters: a stale artifact that
claimed 64/64 locally was scored **1/64** on-chain.

All identifiers below refer to the current **localnet** ledger
(`http://127.0.0.1:8899`, cluster offset 0), produced by `scripts/demo.sh`
running end-to-end plus a real-model pipeline run. The accounts verify live
while that ledger is up; the artifacts are also self-checking offline.

## Files

### Benchmarks

- `acct-6ZTikUCZ….json` — generated benchmark id 25864 (PDA
  `6ZTikUCZ4tAEtcMai29X7bNLBjJU5RDqHcv6xXBnH9Cd`), `status=LIVE`, `kind=1`,
  `items_root` `e6a614da…`. Public item specs; the answer key was produced
  and sealed inside MPC.
- `acct-9Pkx2TkW….json` — the demo's generated benchmark id 6750 (PDA
  `9Pkx2TkW6FAxLzvR1nR8HX1jHehuQPhUBqGqQj6HqDc3`), `items_root` `7e890a95…`,
  carrying two finalized runs and three resolved markets.
- `acct-6VFa9Sqk….json` — the demo's **private** generated benchmark id 6751
  (PDA `6VFa9SqksupE6EQZMPn2wJ2K2ki3iYPkSoKPG9GvDjQE`), `kind=2`,
  `items_root` `169ba824…`. Its item specs exist on-chain only as ciphertext
  encrypted to the authority's x25519 key — proof that a benchmark can be
  minted with *no plaintext questions at all*.

### Runs

- `acct-4uns99WD….json` — **the anti-cheat demonstration.** A real model
  run (`openai` = gpt-oss-20b via Pollinations) whose artifact claimed
  `localCorrect=64/64` — but the bank file had been re-minted mid-run, so
  the outputs were for a stale item set. MPC scored it **1/64** (one
  coincidental match) and the on-chain `Run.correct` permanently records
  the truth: the protocol never trusts a runner's self-reported score.
  The harness now also refuses this case outright — run artifacts bind to
  the bank's `items_root`, and `chain score` rejects a mismatch before
  spending an MPC computation.
- `acct-F75o5JjA….json` — demo run on bank 6750: `mock/oracle-0.75`,
  `correct=49/64`, FINALIZED. Score written by the MPC cluster's callback,
  not the runner.
- `acct-ADJz27sF….json` — second demo run: `mock/oracle-0.50`, `correct=
  32/64`, created by a *separate judge wallet* (the `RunnersMustDiffer`
  duel path).
- `run-25864-stale-artifact.json` — the local artifact behind the 1/64 run:
  outputs, canonical answers, per-item output hashes, committed
  `outputsRoot` `61bdeb56…`. Self-checking offline.
- `run-real-99003-artifact.json` — historical real-model artifact: a
  previous 32-item MPC-minted bank answered **32/32** and scored on-chain
  at the time (run `7pcbA5hE…`). Its ledger epoch is gone; the artifact
  remains self-checking and the pipeline is identical (`--model openai`).

### Markets

- `acct-Ecgwuxex….json` — duel market resolved on-chain: run A (49/64) beat
  run B (32/64) → outcome "A wins", pool paid out.
- `acct-EH3wCWEd….json` — binary market (`< 48 | >= 48`) resolved to
  `>= 48` off the finalized score.
- `acct-7mPoyFpb….json` — 3-way score-band market resolved to `>= 48`.

### Proof + snapshot

- `prove-item0.json` — `sealed prove --run run-25864-stale-artifact.json
  --item 0`: a chunk-level Merkle proof that output 0 was in the committed
  root. Verify:

  ```bash
  # internal consistency (artifact's own outputsRoot):
  node scripts/verify-proof.mjs docs/evidence/prove-item0.json
  # bound to the on-chain Run account (while that ledger is live):
  node scripts/verify-proof.mjs docs/evidence/prove-item0.json \
    --run 4uns99WDqEFZCzNXa7KhW361CKd4XB5x7CLDX8THfJZ1 \
    --rpc http://127.0.0.1:8899
  # or paste it into the explorer's verify widget — "load example" loads a copy
  ```

- `snapshot.json` — `node scripts/snapshot.mjs` dump of every sealed +
  market program account on this ledger (65 + 27 accounts: banks, chunks,
  runs, grants, markets, positions). The explorer renders the full UI from
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
SEALED_API_KEY=<key>` and `--model <id>` (e.g. `openai` on the free
Pollinations endpoint was gpt-oss-20b; anonymous callers are capped at one
in-flight request). NOTE: the anonymous Pollinations tier is now
credit-walled — it returns a billing notice as a normal 200 reply, which the
harness now rejects (`ModelClient` provider-error signatures + the
identical-replies guard in `runModel`). Any funded OpenAI-compatible
endpoint works the same way.
