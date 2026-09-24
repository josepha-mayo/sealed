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
| **Product / execution** | Six Arcis circuits + two Anchor programs + TS harness + web explorer, all live: `seal_part`, `score_chunk`, `gen_part`, `gen_part_private`, `reveal_part`, `reshare_part`. | `encrypted-ixs/src/lib.rs`, `programs/sealed/src/lib.rs` |
| **Does it work?** | `yarn test` — 11/11 mocha E2E on a real MPC localnet (seal, score, score-band + duel + ladder markets, generated banks, private banks, reshare delegation, delegated-runner scoring). `yarn harness:test` — 13/13 unit. | `tests/sealed.ts`, `packages/harness/test/harness.test.ts` |
| **Real model evidence** | gpt-oss-20b (`openai` on the anonymous Pollinations tier) answered all 64 items of **MPC-minted bank 6932** — no answer key exists; on-chain MPC score **64/64 == local pre-score** (run `HW5H5bT7…`). Same model, authored bank 25864: **64/64** (run `4uns99WD…`) — and a stale-bank artifact claiming 64/64 scored **1/64** (`3CKnMa8X…`, reproduced via a deliberate insecure-bypass — the client check refuses it, MPC is the boundary). Artifacts + accounts + Merkle proofs in `docs/evidence/`, verifiable on the live ledger. Historical: 99003 32/32, ling-3.0 58/64, nemotron-3.5 59/64 — all MPC-scored, all matching. **And the strongest**: `9nfKSXnM…` — gpt-oss-20b **32/32 on a private bank** whose specs it could only read through `reshare_part` grants; the exam was never published anywhere (delegate `9z6CwKCQ…`, `scripts/real-unseen-run.sh`). | `docs/submission.md` |
| **Why crypto is load-bearing** | Solana = the commitment layer (roots, PDAs, market settlement). Arcium MPC = the only reason data can be on-chain yet unreadable. Without either, this is a database + a promise. | `docs/threat-model.md` |
| **Privacy depth** | Three disclosure levels, all proven: public specs (generated), delegate-only specs (`reshare_part` → `ShareGrant` PDAs — one-directional, grant trail on-chain), sealed answers (MXE-only, fingerprints declassifiable via `reveal_part`). | `docs/threat-model.md` tables |
| **Market fit / viability** | Per-run fees to the benchmark authority are live (`create_run` transfers `fee_lamports`); market take-rate is live too (`fee_bps` at resolution, `claim_fee`). Four novel settlement primitives ship here: **run duels** (head-to-head "does A outscore B", bets latch on either leg's first scoring queue, `RunnersMustDiffer` anti-sybil), **ladder races** (K-way argmax over 3–8 bound runs — dead-heat pro-rata ties, legs that land nothing forfeit at 0 while landed partials count, any-leg betting latch), **unseen-exam markets** (a market opens and fills on a private-bank run — the event being priced is itself confidential: specs are ciphertext-only before, during, and after settlement, `scripts/unseen.sh`), and **committed-settle expiry** (`all_queued_at` + 24h landing window — a stalled run refunds only if the runner never committed every chunk; no transaction can both commit and expire). Any venue resolves permissionlessly off `Run.correct` — the referee is infrastructure, not a vendor. | `programs/market`, `docs/submission.md` |
| **Honesty / craft** | The devnet note is recorded truthfully: the shared Arcium devnet cluster finalizes computations but is withholding callback txs during an outage (programs already upgraded to the hardened build; only callbacks are missing) — retry loops are armed and every localnet flow is reproducible meanwhile. | `docs/submission.md` "Devnet note" |

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

# 2. eyeball the chain state — ciphertext-only private chunks, grant trail,
#    minted specs, scores, resolved markets
python3 -m http.server -d . 8788
#   → http://localhost:8788/web/?rpc=http://127.0.0.1:8899
#   offline (no localnet): http://localhost:8788/web/?snapshot=/docs/evidence/snapshot.json

# note: --run means an artifact FILE for run/score/prove, but a run PDA
# for attest/reset-pending/market open (verify-proof.mjs also takes --run-pda)

# 3. verify the suites yourself
yarn test                      # 11/11 E2E
yarn harness:test              # 13/13 unit

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
