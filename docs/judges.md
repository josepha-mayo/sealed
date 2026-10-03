# Judge's fast path — evaluating Sealed in ~10 minutes

Every claim below is verifiable. Nothing here requires trusting us.

## The one-line pitch

A benchmark whose items are **minted inside an MPC cluster** — questions drawn
from enclave randomness, answers computed and fingerprinted in-circuit — so
**no answer key exists anywhere on Earth**, and (in the private variant) **the
questions never exist in plaintext on-chain either**. Models are scored inside
the enclave; only the count leaves it. Parimutuel markets settle on that count.

## Rubric → evidence

| Criterion | What to look at | Where |
|---|---|---|
| **Insight / novelty** | The eval-honesty problem is that every trusted party in the loop can leak or rig. Sealed removes the trusted *data* party entirely: the questions are born in MPC, the answers never leave it, and disclosure is selective and recorded. | `docs/pitch.md`, README "Why" table |
| **Product / execution** | Six Arcis circuits (reviewed line-by-line in docs/circuits.md) + two Anchor programs + TS harness + web explorer, all live: `seal_part`, `score_chunk`, `gen_part`, `gen_part_private`, `reveal_part`, `reshare_part`. | `encrypted-ixs/src/lib.rs`, `programs/sealed/src/lib.rs` |
| **Does it work?** | `yarn test` — 17/17 mocha E2E on a real MPC localnet (seal, score, score-band + duel + ladder + dark markets, capability bounties, generated banks, private banks, reshare delegation, delegated-runner scoring). `yarn harness:test` — 13/13 unit. | `tests/sealed.ts`, `packages/harness/test/harness.test.ts` |
| **Real model evidence** | **Flagship — live in the bundled snapshot:** FOUR open-weights models (two families) raced an MPC-minted exam with zero external API — `qwen2.5-3b` 6/32 vs `qwen2.5-1.5b` **6/32 (a real dead-heat)** vs `llama-3.2-1b` 1/32 vs `qwen2.5-0.5b` 0/32; ladder `A4fMA7eK…` filled while all legs were *pending*, argmax resolved `result_mask=0b11` paying both co-leader backers pro-rata — plus a dark commit-reveal market on leg 0's run with sealed positions and a live forfeit (`scripts/ladder-local.sh`, `ladder-local.txt`). Also: `qwen2.5-1.5b` 3/32 vs `qwen2.5-0.5b` 1/32 duel `7p32UT6s…` (`duel-local.txt`), the 1.5b scored **8/32 on a private bank** read only through `reshare_part` grants (`7S9ZmxrT…`, `unseen-local.txt`), and the **double-sealed composition**: private bank `8HHm4HgA…` (specs ciphertext-only) hosted a dark commit-reveal market `7TVjSaFD…` on the 3b's pending run — exam sealed + positions sealed + MPC score — resolved `>=5` on 5/32 with a sealed forfeit, then a full-book score-band market `497kuApd…` resolved `1–7` on the 0.5b's 2/32 (plus a live `all_backed` cancel `H3RGMd3N…` refunding gross) (`dark-local.txt`, `band-local*.txt`). **Every market primitive has now settled a real open-weights model's MPC-written score.** Newest (epoch-3, hardened build): a sponsor escrowed **0.1 SOL against "first proven run ≥ 6/32"** — an *independent* runner keypair ran `qwen2.5-3b` for real (local pre-score 7/32, MPC-agreed 7/32) and the **permissionless claim paid the operator** while the 1.5b's honest 2/32 sat below the threshold on the same bank (`real-bounty.txt`); a second real-model band market resolved bucket-0 on `llama-3.2-1b`'s MPC-confirmed **0/32** — the exam flunking a model is evidence too. Earlier gpt-oss-20b runs: 64/64 on MPC-minted bank 6932 (`HW5H5bT7…`), 64/64 on authored 25864 (`4uns99WD…`), a stale-artifact claim scored **1/64** (`3CKnMa8X…` — the anti-cheat boundary), and 32/32 on grant-only private bank `Fa4WS8B1…` (`9nfKSXnM…`). | `docs/evidence/` |
| **Why crypto is load-bearing** | Solana = the commitment layer (roots, PDAs, market settlement). Arcium MPC = the only reason data can be on-chain yet unreadable. Without either, this is a database + a promise. | `docs/threat-model.md` |
| **Privacy depth** | Three disclosure levels, all proven: public specs (generated), delegate-only specs (`reshare_part` → `ShareGrant` PDAs — one-directional, grant trail on-chain), sealed answers (MXE-only, fingerprints declassifiable via `reveal_part`). | `docs/threat-model.md` tables |
| **Market fit / viability** | Per-run fees to the benchmark authority are live (`create_run` transfers `fee_lamports`); market take-rate is live too (`fee_bps` at resolution, `claim_fee`). Six novel settlement primitives ship here: **run duels** (head-to-head "does A outscore B", bets latch on either leg's first scoring queue, `RunnersMustDiffer` anti-sybil), **ladder races** (K-way argmax over 3–8 bound runs — dead-heat pro-rata ties, legs that land nothing forfeit at 0 while landed partials count, any-leg betting latch), **unseen-exam markets** (a market opens and fills on a private-bank run — the event being priced is itself confidential: specs are ciphertext-only before, during, and after settlement, `scripts/unseen.sh`), **dark commit-reveal markets** (a bettor's side is a `sha256` commitment — sealed until they choose to reveal; no-show winners forfeit into the pot, zero-reveals cancel to gross refunds, `scripts/dark.sh`), **capability bounties** (a sponsor escrows SOL against "first proven run ≥ threshold" — the pot pays the winning run's *operator*, not a bettor; permissionless claim, `runner ≠ sponsor` anti-self-deal, `scripts/bounty-local.sh`), and **committed-settle expiry** (`all_queued_at` + 24h landing window — a stalled run refunds only if the runner never committed every chunk; no transaction can both commit and expire). Any venue resolves permissionlessly off `Run.correct` — the referee is infrastructure, not a vendor. | `programs/market`, `docs/submission.md` |
| **Honesty / craft** | The devnet note is recorded truthfully: the shared Arcium devnet cluster finalizes computations but is withholding callback txs during an outage, and devnet write congestion has held up the hardened-build redeploy (the deployed sealed binary is the prior v4 build — the tail-read is forward-compatible). Retry loops are armed and every localnet flow is reproducible meanwhile. | `docs/submission.md` "Devnet note" |

## 3-minute reproduction

Prereqs: Solana CLI, Docker (the arx nodes), Anchor + the arcium toolchain
(`scripts/setup-wsl.sh` provisions all of it), and a wallet:
`solana-keygen new --no-bip39-passphrase -s -o ~/.config/solana/id.json`
(add `--force` if the file exists). Fund it AFTER the localnet is running:
`solana airdrop 5 "$(solana address)" --url http://127.0.0.1:8899`.
Then `yarn install && arcium build && anchor build -p market --ignore-keys`
once — `arcium build` compiles circuits + the sealed program/IDL; the market
program builds separately (its declared ID intentionally differs from any
generated keypair — `--ignore-keys` keeps it; do NOT run `anchor keys sync`).

```bash
# 0. chain env (localnet cluster offset — both vars are required)
export SEALED_CLUSTER_OFFSET=0 ARCIUM_CLUSTER_OFFSET=0 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899

# 1. see the whole thing work on localnet (MPC mint -> private bank -> delegate
#    -> model -> score -> markets)
arcium localnet &              # first bootstrap; if it times out on backup
                               # nodes, re-run it or use scripts/localnet-up.sh
scripts/demo.sh                 # full arc: mint → disclose → 3 runners → 4 market types → settle
scripts/ladder8.sh              # optional: maximum-width 8-leg race (the full result-mask path)
scripts/unseen.sh               # optional: a market on an exam that is never published (private-bank run)
# real-model flagships (need local llama.cpp endpoints — scripts/serve-local.sh):
scripts/duel-local.sh           # two real models duel on an MPC-minted exam
scripts/ladder-local.sh         # four real models race + dark leg (dead-heat fired naturally)
scripts/dark-local.sh           # double-sealed: dark market on a private exam's real-model run
scripts/duel-private.sh <bench> # blind duel: two grant-delegates race models on a ciphertext-only bank
scripts/bounty-local.sh         # capability bounty: sponsor escrows SOL, first MPC-proven run >= threshold pays its operator (no bettors); bait rejections + expiry refund included
scripts/unbrick-demo.sh         # grief dust → permissionless reclaim → init lands on the same PDA (docs/evidence/unbrick-demo.txt)

# 2. eyeball the chain state — ciphertext-only private chunks, grant trail,
#    minted specs, scores, resolved markets
#   HOSTED (zero setup): https://josepha-mayo.github.io/sealed/
#   On the hosted page, in order:
#     - hero strip: MPC ciphertext → proven score, one glance
#     - cryptographic audit panel: auto-runs — every account PDA re-derived,
#       every commitment fold replayed, every market resolution recomputed,
#       AND the calibration rescore: the MPC's arithmetic reproduced
#       bit-for-bit in your browser (7/32, run GnrRt5GU…).
#       Should read "12 pass · 0 fail" with twenty-seven reveal-burn notes.
#     - "model capability records": persistent per-model aggregates enrolled
#       by the permissionless record_score ix — each ScoreLog receipt makes
#       a run countable exactly once, and the audit replays every record
#       bit-exact from its receipts. Four REAL local models lead the table;
#       `chain record --all` is the permissionless librarian that enrolled
#       the other ~280 runs — no operator required
#     - a benchmark card: generated-item specs render publicly while the
#       answers exist only as ciphertext — click "verify commitment" to
#       replay its items_root fold yourself
#     - run rows: the "post-reveal ⚠" pill marks a run minted after a
#       fingerprint reveal — markets refuse it on-chain (PostRevealRun)
#     - the flagship races: bank 2RPWrmbq… carries the qwen duel (3/32 vs
#       1/32, market 7p32UT6s… A-wins); bank BoKj4kY1… carries FOUR real
#       models — ladder A4fMA7eK… resolved mask=0b11 (dead-heat: qwen-3b
#       and qwen-1.5b both scored 6/32) + dark market BrFdXAxY… on leg 0
#     - "verify an output": click load example → VERIFIED against the
#       snapshot's committed outputs_root
python3 -m http.server -d . 8788
#   → http://localhost:8788/web/?rpc=http://127.0.0.1:8899
#   offline (no localnet): http://localhost:8788/web/?snapshot=/docs/evidence/snapshot.json

# note: --run means an artifact FILE for run/score/prove, but a run PDA
# for attest/record/reset-pending/market open (verify-proof.mjs also takes --run-pda)

# 3. verify the suites yourself
yarn test                      # 17/17 E2E
yarn harness:test              # 13/13 unit

# 3b. cryptographic audit of the evidence bundle — fully offline:
#     re-derives every account's PDA, replays items_root commitment folds
#     bit-exact, re-checks that every market resolution is a pure function
#     of the MPC-scored run, and re-verifies the Merkle proofs.
#     The same suite also runs IN-BROWSER on the hosted explorer — the
#     "cryptographic audit" panel auto-executes against the loaded snapshot.
node scripts/verify.mjs        # 12 PASS / 0 FAIL on the committed snapshot

# 3c. THE calibration check — recompute the MPC's arithmetic yourself.
#     The calibration bank's plaintext answers ship in the repo (public on
#     purpose). rescore.mjs recomputes every fingerprint from plaintext,
#     checks them against the on-chain Reveal accounts, re-binds the run
#     artifact to Run.outputs_root, and recounts the score — the result is
#     bit-identical to what the MPC wrote (7/32). Zero trust required.
node scripts/rescore.mjs --bank docs/evidence/calibration/bank.json \
  --run docs/evidence/calibration/run-artifact.json \
  --benchmark CSnhf6QySv3BszDkJ47KGooUx86PBpLxxi2iDz42S8fp \
  --run-pubkey GnrRt5GUu6pUQXi7gyXLn7mXMbhXDdneiXbaV6LFFHvi \
  --snapshot web/snapshot.json      # 7 PASS / 0 FAIL — no RPC needed

# 4. verify a committed output independently (two-level Merkle proof)
#    — the PDA below lives on the author's current localnet; after demo.sh
#    substitute YOUR run PDA (printed by `chain score` / `chain status`).
node scripts/verify-proof.mjs docs/evidence/prove-item0.json \
  --run 4uns99WDqEFZCzNXa7KhW361CKd4XB5x7CLDX8THfJZ1 --rpc http://127.0.0.1:8899
```

## The 30-second wow moment

On-chain, a private benchmark holds **only ciphertext** — see it in the
explorer's private-bank card, or `solana account <priv-item-chunk-pda>`;
`chain pitems` is the only thing that can read it (authority key only). Then
`chain reshare --to <judge-pubkey>` + (as the judge) `chain delegate-bank`
rebuilds the exam **entirely from grants** — byte-identical to the authority's
decryption, and nobody else on the network ever saw a single question. That is
an evaluation the exam's own author can't leak, because there is no author.

**Or just click.** On the hosted explorer, the private bank card has a
*decrypt with demo delegate key* button — a throwaway localnet delegate
keypair is committed (`web/demo-delegate.json`), and the page vendors the real
`RescueCipher` (`web/vendor/rescue.mjs`, noble-only — no Node builtins), so the
shared-secret derivation, Rescue/x25519 decryption, and spec unpacking all run
in your browser. You see the 32 sealed questions nobody else can read;
`node scripts/decrypt-grants-test.mjs` regression-tests the exact same code
path offline against the harness' own reconstruction (32/32 identical).
