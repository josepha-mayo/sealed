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

### Flagship: two real open-weights models duel under MPC (in `snapshot.json`)

`scripts/duel-local.sh` (transcript `duel-local.txt`) — zero external API
dependency, both legs served by local llama.cpp from open-weights GGUFs:

- exam minted inside MPC: bank `2RPWrmbqLm…` (id 33297, 32 items,
  `items_root` `7ba36716…` — no answer key ever existed);
- leg A `qwen2.5-1.5b-instruct` (llama.cpp :8081) → run
  `2sacf38JshMqyDixCuZ49hB8L2RPmA969LrAzt7PKY8J`, local pre-score **3/32**;
- leg B `qwen2.5-0.5b-instruct` (llama.cpp :8082) → run
  `E8wRqWtjdNNPPbn8dU94shJ2ML2nPsFLXYt86xqd13B4`, local pre-score **1/32**;
- duel `7p32UT6sT8DGs8LsgpWAWPko7f5NgRfe4FGwPE5piYSs` opened + filled while
  **both runs were still pending** (0.2 SOL A / 0.15 B / 0.05 tie);
- MPC finalized A **3/32**, B **1/32** — both matching local pre-scores
  exactly — resolved `[A wins]`, both backers claimed pro-rata.

Real models make real mistakes — 3/32 and 1/32 on 3-op arithmetic is the
honest capability of small instruct models, and that is the point: the
benchmark measures, it does not flatter.

### Flagship: real model on a grant-only private exam (in `snapshot.json`)

`scripts/real-unseen-run.sh` (transcript `unseen-local.txt`):

- private bank `F1owH6zEGppgjSwCB9VzYvYDSeqUAgbYp8ANSGWx8u3T` minted inside
  MPC — item specs exist on-chain only as ciphertext;
- all 4 parts re-shared to a fresh delegate key inside MPC (4 on-chain
  `ShareGrant` records);
- delegate rebuilt the full 32-item bank from grants alone;
- `qwen2.5-1.5b-instruct` answered items it could only see via grant →
  run `7S9ZmxrTvcR6jD4pm4qhBoqyL8Kz6rChFNXPsqjLfKHK` finalized **8/32**,
  matching the local pre-score exactly.

A real model took an exam that was never published anywhere — its only
view of the questions was the on-chain grant trail.

### Later ledger generations (post-wipe, not in `snapshot.json`)

- **Real model on a grant-only exam** (`scripts/real-unseen-run.sh`): private
  bank `Fa4WS8B1…` → 4 `reshare_part` grants to delegate `9z6CwKCQ…`
  (`DXmdvHCU`, `ANeM4ZCM`, `GjcjUwoi`, `HRhp7e6k`) → delegate rebuilt the
  full 32-item bank from grants alone → **gpt-oss-20b scored 32/32**
  on-chain (run `9nfKSXnM…`, MPC == local pre-score). A real model took an
  exam that was never published anywhere — its only view of the questions
  was the on-chain grant trail.
- **Unseen-exam market** (`scripts/unseen.sh`, run twice live): private bank
  `Fa4WS8B1…` (specs ciphertext-only for the market's whole life) → pending
  run `Fdbqwk7A…` → market `HKnKiFTS…` opened + filled both sides → MPC
  finalized 16/32 → resolved, sole `< 20` winner paid 0.28 SOL pro-rata.
  First run of the same script: market `2v2WqSyG…` resolved 19/32 the same
  way. Full terminal record: `../unseen.cast`.
- **Dead-heat ladder** (E2E suite): legs tied 25/25 vs 10 → `result_mask
  0b011`, co-leaders split the loser's stake pro-rata plus rent refunds.
- **Head-to-head duel** (`scripts/duel-real.sh`, transcript `duel-real.txt`,
  recorded `../duel.cast`): fresh MPC-minted bank `HheVzccx…` → two PENDING
  runs (mock/oracle-0.65 vs mock/oracle-0.40 — the real-endpoint leg was
  credit-walled at capture time; the script retries then degrades loudly)
  → duel `8ALBq8hQ…` opened + filled while both runs were pending → MPC
  finalized 22/32 vs 13/32 (both == local pre-scores) → outcome `[A wins]`
  paid both backers pro-rata. A second cast run bank `78tKSVM9…` reproduced
  the same flow.

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
- **`node scripts/verify.mjs`** — one-command cryptographic audit of the
  bundle, fully offline: re-derives every account's PDA from its own
  fields (a fabricated account would land on a different address),
  replays every gen/private bank's `items_root` commitment fold
  bit-exact, re-checks that every resolved market's outcome is a pure
  function of the MPC-written `Run.correct` (bands, duel argmax, ladder
  masks, dark), and re-verifies each `prove-*.json` Merkle path —
  plus cross-validates every on-chain `post_reveal` flag against
  timestamp inference.
  Current bundle: **10 PASS / 0 FAIL** (+ 2 informational notes).

`mock/oracle-*` is the deterministic offline model — the same pipeline
(`run` → `chain score` → `prove`) works verbatim with a real model via

The unseen-exam market flow is also captured as a recording: `../unseen.cast`
(asciinema) + `../unseen.gif` — market `HKnKiFTS…`/`2v2WqSyG…` filled while
the run stayed pending.

*Disclosure:* `run-25864-v2-artifact.json` carries `canonical` answers for
authored bank 25864 — that bank is a disposable localnet fixture whose
plaintext lived in `bank/` (gitignored); the file is kept to prove the
run artifact ↔ on-chain binding, not because authored banks leak answers
through the protocol (they don't — answers seal to the MXE key).
`--model openai` + endpoint env vars; the on-chain steps are identical.

## Dark commit-reveal markets — sealed positions on an unseen exam

`scripts/dark.sh` (transcript `dark-run.txt`; recorded `../dark.cast` +
`../dark.gif` — a second full run): a dark market on a
PRIVATE bank — the exam was ciphertext-only AND every bettor's side was
sealed while MPC scored the run.

- bank `7mwkKUHVKrrfzjwYrGqQskbRtGr6dkHFRC7D2vaW1FKD` (private, 32 items)
- run `DE1FnCRezdeMspAMFJbUXUw7Q9ggiqUpD8BXzdsWvahF` — MPC scored **16/32**
  → bucket `[0] < 20` while both positions sat sealed
- market `9QKby3Uap4pjEBkLrPvmh6HSAfFaY7tSjsXgv5SiAbdM` — pool 0.35 SOL,
  `reveal_secs=300`
- alice `Fb1UGS7z…` sealed 0.25 on outcome 1 (lost); bob `BorMXV5C…`
  sealed 0.10 on outcome 0 (won). Only sha256 commitments were on-chain.
- Both revealed inside the window → `finalize_dark` tallied → bob claimed
  the net pot (0.348 incl. alice's stake) + position rent; authority swept
  the 1% fee. The revealed loser's account stays as the audit trail.
- Bonus: the same sealed-vs-scored flow on the E2E ledger also produced a
  *forfeited* winner (`5PsgCP4p…` — 0.30 sole-revealed winner took a 0.588
  net pot after a 0.20 no-show forfeit) and two cancelled markets.

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
private bank, selective disclosure, three runs (two from separate judge
wallets), binary + 3-way + duel + ladder markets, resolution, payouts,
leaderboard.

For a real model: `export SEALED_API_BASE=<openai-compatible-endpoint>
SEALED_API_KEY=<key>` and `--model <id>`. The headline run above used
`openai` on the anonymous Pollinations tier
(`SEALED_API_BASE=https://text.pollinations.ai/openai
SEALED_API_KEY=anonymous`, `--max-tokens 512 --concurrency 1`) — the free
tier credit-walls in bursts (a billing notice returned as a normal 200
reply, which the harness rejects via provider-error signatures + the
identical-replies guard), so `scripts/real-model-run.sh` retries through the
gaps. Any funded OpenAI-compatible endpoint works the same way.
