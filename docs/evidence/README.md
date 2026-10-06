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

### Portable artifacts — verify without a ledger

The three artifact formats a judge can hold in one hand and check in the
other. All are offline-replayable; all are sha256-pinned in `SHA256SUMS`.

- `claims/` — **31 `sealed-claim/v1` cards**, one per registry record.
  Each embeds the record's aggregate, every `ScoreLog` receipt, the runs
  they point at, the banks those runs scored on, and every venue settled
  on them — plus PDA seed material so a verifier re-derives every address.
  Batch-verify the whole registry:
  `chain prove --verify docs/evidence/claims` (279 checks across 31 cards).
  Overlay your own policy while you're at it:
  `chain prove --verify claims/qwen2.5-3b-instruct.json --min-pct 20`.
- `policies/` — **`sealed-policy/v1` certificates**: a policy + every
  record's verdict + the embedded receipts the verdict replayed from.
  `min60-3runs.json` (whole registry), `strict70-vouched.json` (attested
  pre-reveal evidence only), `sealed-test-60pct.json` (bank-scoped —
  29 records honestly report `no-evidence` in that scope). Replay any of
  them: `chain gate --certify-verify policies/<file>.json`.
- `reports/` — **`sealed-report/v1` printable capability reports** —
  the dossier as a document: registry record, four ranking lenses, the
  receipt ledger, venue settlements, honesty flags, and a canonical
  claim-card sha256 that re-mints identically (`generatedAt`/`source`
  excluded from the digest). Reproduce:
  `chain report qwen2.5-3b-instruct --snapshot ../../web/snapshot.json`.
- `calibration/` — authored bank 77007 with plaintext answers shipped
  *on purpose*: `scripts/rescore.mjs` recomputes answer hashes, re-binds
  the artifact to `Run.outputs_root`, and recounts **bit-identical** to
  the MPC-written score (7/32). See `calibration/README.md`.

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

### Flagship: blind duel on a private exam — two delegates, two models (in `snapshot.json`)

`scripts/duel-private.sh` (transcript `duel-private.txt`) — the deepest
composition: two delegates each see the exam only through their own
`reshare_part` grants, run different models against it, and a head-to-head
market prices the race blind:

- bank `8HHm4HgA…` (the same private exam as below — now 8 grant records
  to two delegate keys; each rebuilt `items_root` `27f9acdd…` independently,
  a live consistency proof that grants converge);
- delegate A ran `qwen2.5-3b` → run #4 finalized **5/32**; delegate B ran
  `qwen2.5-1.5b` → run #5 finalized **4/32** — both matching local
  pre-scores exactly;
- duel `EHiTUjmP…` opened + three-way book filled (A / B / tie) while both
  runs were pending → resolved `[0] A wins` straight off `Run.correct`,
  winner claimed pro-rata.

Two models raced an exam nobody could read without a grant — and the
market never saw the questions. (Note: an earlier attempt created 4
grants to a delegate key whose keypair was overwritten mid-run — those
grants remain on-chain as orphans, honest evidence that grants are
permanent records, not revocable sessions.)

### Prefund-grief reclaim (`unbrick_pda`) — `unbrick-demo.txt`

`scripts/unbrick-demo.sh` — a live grief-and-reclaim on the sealed program's
PDA space: an attacker sends rent dust to a bank's next `run` PDA; a
permissionless rescuer calls `unbrick_pda` which re-proves the seeds under
the program id and sweeps the dust (the account is garbage-collected); a
second sweep rejects `NothingToDrain`; `create_run` then lands on the
cleaned address; and a drain attempt on the now-live account rejects
`NotGriefedPda`. Regression-tested in `tests/sealed.ts` on both programs.

### Persistent capability registry — `record-local.txt`

`scripts/record-local.sh` — two real open-weights models answer
MPC-minted exams (no answer key ever exists) and their finalized runs are
enrolled into the on-chain **capability registry**:

- `qwen2.5-3b-instruct` → 9/32 (run `4biuMVnc…`, record `7mAKsLaB…`,
  `localCorrect` == MPC score, as always)
- `qwen2.5-1.5b-instruct` → 5/32 (run `55iJanaG…`, record `FQGc2nW7…`)

Each `record_score` call is permissionless — the recorder just pays rent;
the score itself was written by the `score_chunk` callback. The PDA is
`[modelrec, sha256(model_id)]` so an entry binds the run's *declared*
identity (`ModelHashMismatch` otherwise), and the init-once `ScoreLog
[scorelog, run]` receipt makes double-counting structurally impossible —
the transcript ends with the second enrollment attempt rejected live
(`Allocate: already in use`). The explorer's "model capability records"
section renders the aggregates; `verify.mjs [5b]` and the in-browser audit
replay every `ModelRecord` bit-exact from its receipts. `model_id` remains
self-reported metadata — `vouched_at_record` is what separates an
authority-vouched score from a stranger's claim, and the records say so.

`records.txt` — the full registry after `chain record --all` crawled the
ledger: 31 model records holding 292 receipts (278+ enrolled by that single
permissionless sweep — no operator touch). Real models at the top; the
`test/ mock/ ladder/ duel/ dark/ delegate/` fixtures are suite baselines.
Both runs above were then authority-attested — their receipts keep
`vouched=0` honestly (they were recorded first); the explorer shows the
attested pill on the runs while the receipts preserve record-time truth.

### Flagship: capability bounty — first-to-beat pays the operator, not a bettor (in `snapshot.json`)

`scripts/bounty-local.sh` (transcript `bounty-local.txt`) — a primitive the
usual eval-market suspects don't have: a sponsor escrows SOL against
"first run on this bank to score ≥ T takes it." There are no positions,
no odds — the pot pays the winning **run's operator**, and the oracle is
the same MPC-written `Run.correct` everything else settles on:

- bank `DQ4Hum2q…` minted inside MPC (answers never existed in plaintext);
- bounty `6EqmVxLM…` — sponsor escrowed 0.1 SOL, threshold 4, +1h deadline;
- an **independent** runner keypair (`8imv9tDz…`, airdropped, distinct from
  the sponsor — sponsor self-claim is rejected on-chain) ran
  `mock/oracle-0.5` → MPC finalized 17/32 == local pre-score;
- permissionless `claim_bounty` paid the pot straight to `run.runner`
  (`489115440 → 589115440` lamports) and stamped `winner_run` +
  `winning_score` as permanent on-chain evidence;
- a second bounty `DLMkwgSQ…` (threshold 30 — unreachable after the run
  landed) lapsed and `expire_bounty` refunded the escrow to the sponsor.

The transcript also shows three on-chain bait rejections: threshold above
the bank's item max (`InvalidThreshold`), a deadline inside the 60s
minimum (`DeadlineTooSoon`), and a second claim on the resolved bounty
(`MarketNotOpen`). The unit suite additionally covers the retroactivity
wall, wrong-bank runs, sponsor self-claim, pending-run claims, and the
proven-partial path (`tests::bounty_qualifies_gates`), and the E2E test
exercises retroactive-claim rejection, a permissionless third-party claim
trigger, and double-claim rejection against real MPC scoring.

**With a real open-weights model** (epoch 3, in `snapshot.json`): bank
`BqC4fmNq…` (MPC-minted, answers never existed), bounty `rXKda9QJ…`
(0.1 SOL, threshold 6/32). `qwen2.5-3b-instruct` (local llama.cpp,
independent runner key `CTjqTWai…`) scored **7/32 through the MPC
pipeline — matching its local pre-score** — and a third-party claim paid
the pot to `run.runner` (89.1M → 189.1M lamports). The sibling run on the
same bank, `qwen2.5-1.5b-instruct` at **2/32**, stayed below threshold —
the benchmark measures; it does not flatter.

Same bank, more real-model market evidence (`real-bounty.txt`): a band
market `t82Q2fPE…` priced **llama-3.2-1b's pending run** with every
bucket backed — it resolved `<4` on the MPC-verified **0/32** and paid
the winning bucket the full pool; a parallel market on 0.5b's run
correctly **cancelled** for an unbacked bucket (gross refunds). The
bank's real-model leaderboard: 3b 7/32 · 1.5b 2/32 · 0.5b and llama-1b
0/32 — four honest zeros-and-sevens, all MPC-written.

Honesty note — bounty `EJzXf3q4…` in the merged snapshot was claimed by a
run whose `runner == sponsor`: it landed on an epoch-2 binary **before**
the `runner != sponsor` guard shipped (the first demo is what exposed the
gap). The verifier flags it as a grandfathered note, not a fail — it is
historical evidence of a bug we found, fixed, and shipped a regression
check for. Any *new* self-deal claim fails verification.

### Flagship: double-sealed — dark market on a private exam, real model (in `snapshot.json`)

`scripts/dark-local.sh` (transcript `dark-local.txt`) — the purest privacy
composition in the repo: a commit-reveal market priced a run on an exam
whose questions exist only as ciphertext, while every bettor's *side* was
itself a sha256 commitment:

- private bank `8HHm4HgAjSDMc1HWMBpsgY5LZ3saEEyZenM3KyitVAug` (id 10019)
  minted inside MPC — specs ciphertext-only on chain;
- all 4 parts re-shared to a fresh delegate `N4q2ySTQj…` inside MPC
  (4 `ShareGrant` records); delegate rebuilt the 32-item bank from grants
  alone — no plaintext ever touched the authority's disk in this flow;
- `qwen2.5-3b-instruct` answered → pending run `EQkXCFGS…`;
- dark market `7TVjSaFD…` opened on the pending run (`<5` | `>=5`),
  two sealed positions filled (0.08 `<5` / 0.12 `>=5`);
- MPC finalized **5/32** == local pre-score → resolved `[1] >= 5`;
- the winner revealed in-window and claimed the tallied pot; the losing
  position stayed sealed and forfeited.

Exam sealed + positions sealed + score written by MPC: three independent
hiding guarantees on one artifact.

### Flagship: score-band market on the same sealed exam (in `snapshot.json`)

`scripts/band-local.sh` (transcripts `band-local.txt`, and
`band-local-cancelled.txt` — the first run intentionally documents the
unbacked-bucket cancel path live) — private bank `8HHm4HgA…` hosts a
three-model leaderboard (`qwen2.5-3b` 5/32, `qwen2.5-1.5b` 4/32,
`qwen2.5-0.5b` 2/32 — every score written by MPC, each matching its local
pre-score):

- market `H3RGMd3N…` on the 1.5b run: only two buckets backed →
  **CANCELLED** at resolve, gross refunds — the `all_backed` guard firing
  for real;
- market `497kuApd…` on the 0.5b run: full six-bucket book →
  resolved `[1] 1–7` on MPC score 2/32, winner claimed pro-rata.

That completes the coverage matrix — **every market primitive has now
settled a real open-weights model's score written by MPC**: score-band,
duel, ladder (dead-heat), and dark commit-reveal, on both public
MPC-minted banks and a grant-only private exam.

### Flagship: four real open-weights models race — dead-heat + dark market (in `snapshot.json`)

`scripts/ladder-local.sh` (transcript `ladder-local.txt`) — the widest
primitive exercised end-to-end with zero external API: four local llama.cpp
models, two families, one runner wallet each:

- exam minted inside MPC: bank `BoKj4kY1…` (id 87635, 32 items,
  `items_root` `6c823331…` — no answer key ever existed);
- `qwen2.5-3b` **6/32**, `qwen2.5-1.5b` **6/32** — a REAL dead-heat;
  `llama-3.2-1b` **1/32**; `qwen2.5-0.5b` **0/32**;
- ladder `A4fMA7eK…` opened + five bets filled while ALL four runs were
  pending (positions on every leg);
- MPC finalized each leg == its local pre-score → argmax resolved
  `result_mask=0b11` — the co-leader dead-heat path paying both backers
  pro-rata, live;
- bonus: dark commit-reveal market `BrFdXAxY…` on leg 0's pending run —
  sealed positions (0.07 SOL `<4` / 0.11 SOL `>=4`) sat as sha256
  commitments while MPC scored; resolved `>=4` (score 6), the winner
  revealed in-window, the loser stayed sealed and forfeited into the pot.

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
  masks, dark), replays every capability-registry aggregate from its
  `ScoreLog` receipts, and re-verifies each `prove-*.json` Merkle path —
  plus cross-validates every on-chain `post_reveal` flag against
  timestamp inference.
  Current bundle: **12 PASS / 0 FAIL** (+ 27 informational notes — per-bank
  reveal-burn accounting and the grandfathered epoch-2 bounty).
- **`node scripts/rescore.mjs`** — the calibration check: an authored bank
  whose plaintext answers ship in `calibration/` *on purpose*. The script
  recomputes every `answerHash` from plaintext, checks them against the
  on-chain `Reveal` accounts, re-binds the run artifact to
  `Run.outputs_root`, and recounts — **bit-identical to the MPC-written
  `Run.correct` (7/32), 7 PASS / 0 FAIL, fully offline.** The MPC's
  arithmetic is not just claimed — it is independently reproduced.
  See `calibration/README.md`.
- **`SHA256SUMS`** — integrity manifest over every file in this bundle.
  `sha256sum -c SHA256SUMS` (or `scripts/evidence-manifest.sh check`)
  verifies nothing here was modified after commit; `verify-all.sh` runs it
  as stage 5/6 so a stale or tampered artifact fails the pipeline loudly.
  Regenerate after intentionally changing any evidence file:
  `scripts/evidence-manifest.sh update`.
- **`replay.txt`** — a captured transcript of the CLI's snapshot-replay
  surfaces: `chain stats` (counts, escrow, MPC latency, the two inline
  verdicts — all model records bit-exact, all resolutions matching
  `Run.correct`), `gate --all`, the paired-evidence leaderboard, a
  paired `compare`, the keeper board, a self-verifying `modelrec`, and
  the bounty index. Every line ran keyless against `web/snapshot.json`;
  the header shows how to reproduce it, and the loader sha256-checks the
  bundle against `web/MANIFEST` before answering.
- **`node scripts/decrypt-grants-test.mjs`** — offline regression for the
  explorer's "decrypt as delegate" button: vendors the real `RescueCipher`
  (`web/vendor/rescue.mjs`), decrypts the throwaway demo delegate's 4
  ShareGrants on private bank `8HHm4HgA…` straight out of `snapshot.json`
  (`meta.mxe_x25519` carries the cluster pubkey), and pins the spec digest —
  plus a 32/32 item-for-item match against `chain delegate-bank`'s own
  reconstruction when that reference is present.

`mock/oracle-*` is the deterministic offline model — the same pipeline
(`run` → `chain score` → `prove`) works verbatim with a real model via
`--model openai` + endpoint env vars; the on-chain steps are identical.

The unseen-exam market flow is also captured as a recording: `../unseen.cast`
(asciinema) + `../unseen.gif` — market `HKnKiFTS…`/`2v2WqSyG…` filled while
the run stayed pending.

*Disclosure:* `run-25864-v2-artifact.json` carries `canonical` answers for
authored bank 25864 — that bank is a disposable localnet fixture whose
plaintext lived in `bank/` (gitignored); the file is kept to prove the
run artifact ↔ on-chain binding, not because authored banks leak answers
through the protocol (they don't — answers seal to the MXE key).

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
