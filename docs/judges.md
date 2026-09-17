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
| **Does it work?** | `yarn test` — 7/7 mocha E2E on a real MPC localnet (seal, score, markets, generated banks, private banks, reshare delegation, delegated-runner scoring). `yarn harness:test` — 12/12 unit. | `tests/sealed.ts` |
| **Real model evidence** | gpt-oss-20b answered all 32 MPC-minted items; on-chain MPC score **32/32 == local pre-score** (run `FRWixfmP…`). Historical: ling-3.0 58/64, nemotron-3.5 59/64 — all MPC-scored, all matching. | `docs/submission.md` |
| **Why crypto is load-bearing** | Solana = the commitment layer (roots, PDAs, market settlement). Arcium MPC = the only reason data can be on-chain yet unreadable. Without either, this is a database + a promise. | `docs/threat-model.md` |
| **Privacy depth** | Three disclosure levels, all proven: public specs (generated), delegate-only specs (`reshare_part` → `ShareGrant` PDAs — one-directional, grant trail on-chain), sealed answers (MXE-only, fingerprints declassifiable via `reveal_part`). | `docs/threat-model.md` tables |
| **Market fit / viability** | Per-run fees to the benchmark authority are live (`create_run` transfers `fee_lamports`). Parimutuel markets on scores are deployed and resolve themselves off `Run.correct` — the first self-settling "will model X clear T" primitive. | `programs/market`, `docs/submission.md` |
| **Honesty / craft** | The devnet note is recorded truthfully: the shared Arcium devnet cluster finalizes computations but is withholding callback txs during an outage — retry loops are armed and every localnet flow is reproducible meanwhile. | `docs/submission.md` "Devnet note" |

## 3-minute reproduction

```bash
# 1. see the whole thing work on localnet (MPC mint -> private bank -> delegate
#    -> model -> score -> markets)
arcium localnet &              # or scripts/localnet-up.sh if already bootstrapped
scripts/demo.sh

# 2. eyeball the chain state — ciphertext-only private chunks, grant trail,
#    minted specs, scores, resolved markets
python3 -m http.server -d web 8788
#   → http://localhost:8788/?rpc=http://127.0.0.1:8899

# 3. verify the suites yourself
yarn test                      # 7/7 E2E
yarn harness:test              # 12/12 unit
```

## The 30-second wow moment

`chain pitems` on a private benchmark prints **only ciphertext** — the
questions do not exist in plaintext on-chain. Then `chain reshare --to
<judge-pubkey>` + (as the judge) `chain delegate-bank` rebuilds the exam
**entirely from grants** — byte-identical to the authority's decryption, and
nobody else on the network ever saw a single question. That is an evaluation
the exam's own author can't leak, because there is no author.
