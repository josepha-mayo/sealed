# Sealed

**A benchmark whose answer key was never written down, scored by nobody in particular.**

Sealed is a referee for AI-capability claims. Benchmark items can be **minted inside the MPC cluster itself** — drawn from `ArcisRNG`, answered and fingerprinted in-circuit, and stored encrypted to the cluster key. The answer key never exists in plaintext anywhere on Earth: there is nothing to leak, sell, or subpoena. Models are scored inside an [Arcium](https://arcium.com) MPC cluster; the score is written to Solana by the cluster's callback, not by us. Anyone can build a market on "does model X clear 70% on Sealed v1 by date D" and settle it without trusting a leaderboard operator.

Built for Colosseum's Crypto World's Fair (Sep 14 – Oct 12, 2026).

> **Judging?** Start at [docs/judges.md](docs/judges.md) — a 10-minute path mapped to the rubric. With `arcium localnet` running, `scripts/demo.sh` runs the whole flow end-to-end; `web/index.html` is the public explorer (leaderboard, proof verification, market board, ciphertext + grant views) and renders the committed `docs/evidence/snapshot.json` offline — no localnet needed.

![Full demo: MPC-minted bank → private bank → selective disclosure → 3 runners → binary/band/duel/ladder markets → settle + claim](docs/demo.gif)

*([asciicast](docs/demo.cast) · [mp4](docs/demo.mp4) — the real `scripts/demo.sh` run, MPC waits capped at 2s)*

## Why

Prediction markets on AI progress settle against leaderboards run by single companies, and lab-reported benchmark numbers are unverifiable and increasingly contaminated by training data. There is no neutral referee. Sealed makes the referee a protocol:

| Property | How |
|---|---|
| Questions are never published | Only a Merkle root of salted question commitments goes onchain (`Benchmark.items_root`). Retired items are revealed with their salt and checked against the root. |
| Answers are never in plaintext onchain | Answer hashes are encrypted by the author, then **re-encrypted to the MXE key inside MPC** (`seal_part`). After sealing, the author's key is discarded and the stored ciphertext can only be opened by the cluster acting together. |
| **No answer key at all** | Generated banks (`chain gen`) mint items **inside MPC**: `gen_part` draws specs from `ArcisRNG`, computes answers in-circuit, fingerprints them (SHA3-256), and returns them encrypted to the MXE key. Only the public item specs land onchain. There is no answer key — nothing to leak. |
| **No questions OR answers onchain** | Private generated banks (`chain gen-private`) go further: `gen_part_private` returns the specs as `Enc<Shared, Pack<GenPart>>` to the authority's x25519 key (derived from their Solana keypair — no extra key management). `PrivItemChunk` accounts hold ciphertext only; `items_root` commits to the ciphertext itself, so the mint transcript is auditable by anyone while the questions stay confidential to the authority. Neither the questions nor any answer key exists in plaintext. |
| Scores are not posted by the operator | `score_chunk` compares a run's public output hashes with the sealed answers in MPC and reveals only the count. The Arcium callback writes it to the `Run` account. |
| Scores are auditable without a key | `reveal_part` lets the benchmark authority declassify one part's answer *fingerprints* (hashes, never plaintext). `chain verify` then checks them against a run's committed output hashes — a spot-check of what `score_chunk` counted, mediated by MPC so even the authority only ever sees hash commitments. |
| Questions are shareable without publishing | `reshare_part` re-encrypts a private bank's specs to a *second* viewer key inside MPC — the authority can hand a judge, runner, or panel the exam questions without ever putting them onchain. Grants land in per-(chunk, part, viewer) PDAs; disclosure is one-directional (the authority's own key cannot open the delegate's grant), and answers never move. |
| Runs are commitments | A run commits to the Merkle root of all its output hashes before any chunk is scored, and every scored chunk's hashes are permanently in the transaction record. A bad run cannot be retracted. |
| Per-item results stay hidden | Only aggregate counts leave the circuit, so a run cannot be used to leak the answer to a specific item. |

## Architecture

```
packages/harness (TypeScript)            programs/sealed (Anchor)         encrypted-ixs (Arcis, runs in MPC)
------------------------------            ------------------------         ----------------------------------
authored bank (kind=0):
buildBank(seed) -> prompts, answers  --> create_benchmark(items_root, kind)
  answerHash = SHA256(...)[0..8]     --> init_chunk / stage_part (8 items)
  encrypt(RescueCipher, x25519)      --> seal_part  -------------------->  seal_part: Enc<Shared> -> Enc<Mxe>
                                         seal_part_callback <------------  (ciphertext stored in AnswerChunk)

generated bank (kind=1):               create_benchmark(kind, root=0)
                                       init_chunk + init_items
                                       gen_part ----------------------->  gen_part: specs <- ArcisRNG;
  specs land public in ItemChunk          gen_part_callback <------------   answers hashed + Enc<Mxe> born
  items_root = running spec fold                                        (no answer key ever exists)

private bank (kind=2):                 create_benchmark(kind, root=0)
                                       init_chunk + init_items_private
                                       gen_part_private(viewer_pub) --->  same, but specs return
  specs land as ciphertext in             gen_part_private_callback <--    Enc<Shared, Pack<GenPart>>
  PrivItemChunk; items_root folds the     (ciphertext stored; only the
  ciphertext itself                        authority can decrypt)
                                       reshare_part(viewer_pub) ------->  reshare_part: decrypt specs in
  ShareGrant PDA <- delegate decrypts      reshare_part_callback <-----    enclave, re-encrypt to delegate
  with their own wallet key              (selective question disclosure)

runModel(model) -> outputs[]         --> create_run(outputs_root, fee)
  canonicalAnswer -> hash            --> score_chunk(outputs[32]) ------>  score_chunk: count(outputs == 4 sealed parts)
                                         score_chunk_callback <----------  reveals only the count
                                         Run.correct += count; finalized when all chunks scored
```

- **Items** are procedural, exact-answer tasks. **Authored banks** (kind 0) draw ten families (arithmetic chains, stack-machine programs, list transforms, Caesar shifts, base conversion, grid walks, gcd/lcm, digit sums, calendar arithmetic, word sorting) from a master seed — infinite and fresh by construction. **Generated banks** (kind 1) mint arithmetic-expression items inside MPC; anyone can render the prompts from the public specs, but the answer fingerprints were computed and sealed inside the enclave — *no answer key ever existed*.
- **Canonicalization** (`canonical.ts`) is the only normalization applied to a model's reply before hashing; author and runner use the same function.
- **Chunks** are 32 items, stored as 4 parts of 8. Sealing is per part because an MPC callback must fit in one Solana transaction (8 ciphertexts = 256 B; 32 would not). Scoring reads all 4 parts in one computation, so a run over a 10-chunk (320-item) bank is 10 MPC computations.
- **Fee**: `create_run` pays `Benchmark.fee_lamports` to the benchmark authority. That is the business.

### Markets (`programs/market`)

A second Anchor program hosts N-way parimutuel markets on a run's final score, whose resolution input is a Sealed `Run` account — no oracle operator, no admin key deciding outcomes. It ships five novel settlement primitives: **run duels** (head-to-head "does A outscore B" on the same bank — bets latch the moment either leg's first scoring computation queues, `RunnersMustDiffer` blocks self-duels), **ladder races** (K-way argmax markets over 3–8 bound runs — co-leaders split the pot dead-heat, legs that land nothing forfeit at 0 instead of cancelling, and bets latch the moment *any* leg leaves pending), **unseen-exam markets** (a market opens and fills on a private-bank run — the event being priced is itself confidential: questions are ciphertext-only before, during, and after settlement, `scripts/unseen.sh`), **dark commit-reveal markets** (a bettor's side is a `sha256` commitment — sealed until they choose to reveal; no-show winners forfeit into the pot and a zero-reveal market refunds everyone, `scripts/dark.sh`), and **committed-settle expiry** (`all_queued_at` + a 24h landing window — a stalled run refunds unless the runner committed every chunk and the cluster had a full window to land it; no transaction can both commit and expire).

```
create_market(run, salt, edges, fee_bps, closes_at, resolve_by)
                                  open while run is pending and unscored
                                  (scored_mask == 0 && pending_since == 0 —
                                  once scoring is ever queued, markets on
                                  that run stay closed permanently).
                                  edges=[t] is a binary market; edges=[10,20,40] makes 4
                                  score buckets (strictly increasing, no duplicates).
                                  fee_bps <= 1000 (10% max) skimmed at resolution;
                                  closes_at optional (0 = until scoring starts);
                                  resolve_by REQUIRED — every market carries a
                                  permissionless refund deadline (max now+90d).
create_duel(run_a, run_b, salt, fee_bps, closes_at, resolve_by)
                                  head-to-head on the same benchmark: does A
                                  outscore B? 3 outcomes — A wins / B wins / tie
create_ladder(legs[3..8], salt, fee_bps, closes_at, resolve_by)
                                  K-way race on one benchmark: highest score
                                  takes the pot; ties split dead-heat pro-rata.
                                  closes_at REQUIRED (the leg list is public).
                                  A leg that never scores forfeits at 0 — dead
                                  legs never cancel the race (a cancel would be
                                  a free exit for losing leg operators). Bettors
                                  should verify every leg has a live runner.
bet(outcome, lamports)            stake on one bucket; one position PDA per (market, bettor).
                                  Rejects once scoring starts, closes_at passes, or
                                  resolve_by passes.
bet_duel(outcome, lamports)       same, but closes once EITHER run starts scoring
resolve()                         permissionless once run.status == FINALIZED:
                                  outcome = the bucket containing run.correct.
                                  Markets with any unbacked bucket cancel (refunds).
resolve_duel()                    permissionless once BOTH runs are FINALIZED:
                                  outcome = larger correct (ties pay the tie bucket);
                                  resolved_score packs (a << 16) | b
resolve_ladder()                  permissionless once every leg is terminal
                                  (finalized or proven stall) — a never-queued
                                  leg doesn't block, it scores 0. Past resolve_by
                                  anyone forces it, but a leg inside its
                                  post-commit landing window still gets the
                                  window (same JIT-commit invariant as expire).
claim()                           winners split the pot net of fee pro-rata and the
                                  position closes; cancelled markets refund in full;
                                  losing positions close for their rent back
claim_fee()                       authority collects fees_accrued once resolved; safe
                                  to call before bettors claim (fee is recomputed
                                  from fee_bps at each claim, so solvency never
                                  depends on claim order)
void_market()                     authority cancels — only while the run is still
                                  pending AND unscored (no free-look cancels)
expire_market()                   permissionless cleanup once resolve_by passes —
                                  never-queued/uncommitted runs refund in full; a
                                  run that committed every chunk AND stalled past
                                  its 24h landing window settles on the proven
                                  partial score; NOT callable once finalized
```

The `Run` account is verified by owner (`SEALED_PROGRAM`) + discriminator and deserialized inside `resolve`, so the settlement source is the MPC-scored field itself. Betting closes the moment the first scoring computation is queued — before that, all a bettor can see is the model id and the committed `outputs_root`.

### Trust model (honest version)

- The item author knows the answers to the items they wrote — **authored banks only**. Generated banks eliminate this role entirely: specs are drawn from `ArcisRNG` inside the cluster and the answers are born as MXE ciphertext. Honest caveat: *public* generated specs are public, so answers are computable by anyone who renders the items — the property they buy is *provable freshness and zero key custody* (nothing to leak, no author to collude with), not answer secrecy at inference time. **Private** generated banks close that gap: the specs never leave MPC unencrypted, so only the authority can render the prompts — at the cost of trusting the authority not to publish them (they hold the questions; the answers remain MXE-sealed and computable only by the cluster). For authored banks, secrecy comes from the author; sealing means no one *else* can ever read them.
- The runner controls what outputs it submits. Today the venue runs public model APIs itself; third-party runners get a TEE-attested harness or redundant runs from independent runners.
- Aggregate-only reveal plus a per-run fee bounds adaptive probing of individual answers.

## Repo layout

```
encrypted-ixs/          Arcis circuits: seal_part, score_chunk, gen_part, gen_part_private, reveal_part, reshare_part
programs/sealed/        Anchor program (Arcium MXE): registry, chunks, runs, callbacks
programs/market/        Anchor program: parimutuel markets resolving on Run.correct
packages/harness/       item generators, canonical hashing, model harness, chain client, CLI
web/index.html          leaderboard + proof explorer (single file, web3.js via CDN, reads any RPC)
tests/                  end-to-end test on Arcium localnet
scripts/                demo.sh (full judge demo), unseen.sh (market on a never-published exam), ladder8.sh (max-width race), real-unseen-run.sh (real model on a grant-only exam), localnet-up.sh (restart fallback), smoke-localnet.sh, setup-wsl.sh (toolchain), real-model-run.sh / real-gen-run.sh (real-model pipelines), score-artifact-insecure.mts
```

## Develop

Toolchain (Ubuntu 24.04 / WSL2): `scripts/setup-wsl.sh` installs Docker, Node 22, Rust, Solana CLI 3.1.10, Anchor 1.0.2 and Arcium.

```bash
yarn install
arcium build                      # circuits + program (+ .idarc callback types)
scripts/e2e.sh                    # build + `arcium test`: local 2-node MPC cluster, full seal/score flow
yarn harness:test                 # generators, canonicalization, Merkle, run pipeline (offline)
```

Harness CLI (`yarn --cwd packages/harness cli ...`):

```bash
sealed bank build  --seed "$SEALED_MASTER_SEED" --id 1 --chunks 10   # -> bank/1.json (private: prompts + answers)
sealed run         --bank bank/1.json --model openai/gpt-5.2         # -> runs/… (private: raw replies)
sealed run         --bank bank/1.json --model mock/oracle-0.6        # offline stand-in, 60% correct
sealed chain init                                                    # comp defs + circuit upload, once per deployment
sealed chain seal  --bank bank/1.json --fee-lamports 1000000         # authored bank: create, stage + seal every part
sealed chain gen   --id 7 --chunks 2 --fee-lamports 1000000          # generated bank: mint items inside MPC, no answer key
sealed chain items --benchmark <pubkey>                              # re-render a generated bank from onchain specs
sealed chain gen-private --id 8 --chunks 2 --fee-lamports 1000000    # private bank: specs encrypted to YOUR key
sealed chain pitems --benchmark <pubkey>                             # decrypt + render a private bank (authority only)
sealed chain reshare --benchmark <pk> --chunk <i> --part <p> --to <solana-pubkey>  # delegate the questions to a second key
sealed chain grant   --benchmark <pk> --chunk <i> --part <p>           # delegate-side: fetch + decrypt your grant
sealed chain grants  --benchmark <pk>                                  # list who can see which parts
sealed chain delegate-bank --benchmark <pk> [--out bank.json]          # rebuild the whole bank from your grants
sealed chain score --bank bank/1.json --run runs/….json              # create_run + score every chunk in MPC
sealed chain score --bank bank/1.json --run runs/….json --create-only  # park the run pending (for a market)
sealed chain score --bank bank/1.json --run runs/….json --run-index 1  # score an existing run
                              [--authority <pubkey>]  # bank authority when the
                                                      # scoring wallet is a separate runner
sealed chain status --benchmark <pubkey>                             # leaderboard from chain state

sealed chain market open    --run <pubkey> --threshold 55            # binary: "score >= 55?"
sealed chain market open    --run <pubkey> --edges 40,55 --salt 1    # 3-way score bands, 2nd market
                              [--fee-bps 0..1000] [--closes-at +secs|ts] --resolve-by +secs|ts
                              # resolve_by required: 60s..90d from now; closes_at optional, same floor
sealed chain market duel    --run-a <pk> --run-b <pk> --resolve-by +86400  # head-to-head
sealed chain market bet     --market <pk> --outcome 1 --lamports 500000000 [--bettor kp.json]
sealed chain market bet     --market <pk> --side yes --lamports 500000000   # binary shorthand
sealed chain market resolve --market <pk>                            # settles off Run.correct
sealed chain market claim   --market <pk> [--bettor kp.json]
sealed chain market void    --market <pk>                            # authority cancels, pre-scoring only
sealed chain market expire  --market <pk>                            # anyone, once resolve_by passes (not if finalized)
sealed chain market claim-fee --market <pk>                          # authority collects the accrued fee
sealed chain market show    --market <pk>
sealed chain market ladder open --legs <pk,pk,..> --closes-at +86400 --resolve-by +172800  # 3–8-way race
sealed chain market ladder bet|resolve|claim|void|claim-fee|show      # argmax settle, dead-heat splits
sealed chain market dark open  --run <pk> --threshold 20 --resolve-by +86400 [--reveal-secs 86400]
sealed chain market dark bet|reveal|resolve|finalize|claim|void|expire|claim-fee|show
                                                                     # commit-reveal: outcomes sealed
sealed chain reset-sealing  --bank-id <n> --chunk <i>                # clear a part stuck by a dropped MPC computation
sealed chain reset-pending  --run <pk> --chunk <i>                   # sweep a stuck scoring bit (stale = anyone)
sealed chain attest        --run <pk>                                 # authority pins an attestation flag on a finalized run
sealed chain reveal  --benchmark <pk> --chunk <i> --part <0..3>      # authority declassifies 8 answer fingerprints
sealed chain verify  --benchmark <pk> --run <file> [--run-index n]   # audit revealed hashes vs committed outputs
sealed prove                --run <file> --item <i>                # Merkle proof that output i was committed pre-scoring
```

The explorer's **verify-an-output** widget recomputes the Merkle path in-browser and checks it against the run's onchain `outputs_root` — cryptographic evidence that a model's claimed answer was in the committed set.

Explorer: serve the repo root (`python3 -m http.server -d . 8788`) and open `http://localhost:8788/web/?rpc=<url>` — defaults to localnet `http://127.0.0.1:8899`; offline, load the committed dump via `?snapshot=/docs/evidence/snapshot.json` or the file picker; on devnet it links out to explorer.solana.com.

Chain commands read `ANCHOR_PROVIDER_URL`, `ANCHOR_WALLET` and `SEALED_CLUSTER_OFFSET` (localnet: 0, devnet: 456; `ARCIUM_CLUSTER_OFFSET` works as a fallback when running inside the `arcium` env). `scripts/smoke-localnet.sh` runs the whole pipeline against a running `arcium localnet`.

Model calls go through any OpenAI-compatible endpoint (`SEALED_API_BASE`, `SEALED_API_KEY`; defaults to OpenRouter).

## Status

- [x] Circuits and program
- [x] Harness: generators, canonicalization, hashing, model client, run pipeline (tests green)
- [x] Localnet end-to-end: `arcium test` seals 2 chunks, scores a run (45/64 planted), finalizes
- [x] **Generated banks**: `gen_part` circuit mints items inside MPC — 4 comps mint a 32-item chunk, bank goes LIVE, specs public in `ItemChunk`, answers born `Enc<Mxe>`; E2E mint→live→score 17/32 planted, plus CLI `chain gen --id 77` -> mock run -> MPC score 24/32 == local pre-score
- [x] **Private generated banks**: `gen_part_private` mints the same items but returns them `Enc<Shared, Pack<GenPart>>` to the authority's x25519 key — `PrivItemChunk` holds ciphertext only, `items_root` commits to the ciphertext; E2E proves ciphertext-only onchain state, authority-side decrypt→render, wrong-key rejection, public-path `WrongBankKind`, and MPC score 21/32 planted + CLI `gen-private` → mock run → MPC score 23/32 == local pre-score
- [x] CLI pipeline on localnet: authored bank -> mock run -> MPC score 40/64, equal to the local pre-score (earlier epoch)
- [x] Real models through OpenCode Zen (earlier epoch, before Zen free-tier gating): ling-3.0-flash-fin-free 58/64 and nemotron-3.5-lightning-free 59/64, both MPC-scored on localnet with MPC == local pre-score
- [x] **Real model on an MPC-minted bank**: gpt-oss-20b (`openai` on Pollinations anonymous tier) answered all 64 items of generated bank 6932 — minted inside MPC, no answer key exists; MPC finalized **64/64 == local pre-score** (run `HW5H5bT7…`). Also 64/64 on authored bank 25864 (run `4uns99WD…`) — where a stale-bank artifact scored **1/64** (run `3CKnMa8X…`), proving the chain never trusts self-reported scores
- [x] **Delegated runner**: `chain delegate-bank` rebuilds a private bank entirely from a wallet's ShareGrants — verified byte-identical to the authority's decryption (prompts, answer hashes, items_root); a model provider can be granted the exam, run it, and get scored without the questions ever being public
- [x] Market program: N-way parimutuel resolved on `Run.correct` end-to-end on localnet — binary + 3-way score-band markets on one MPC-scored run, late-bet rejection, resolve reads `Run.correct`, winner paid
- [x] **Duel markets**: `create_duel`/`bet_duel`/`resolve_duel` — head-to-head "does run A outscore run B on the same bank?" with A-wins/B-wins/tie buckets; bets close once EITHER run starts scoring, settle reads both finalized `Run.correct`, E2E proves 25–19 resolution + pro-rata claim
- [x] **Ladder races**: `create_ladder`/`bet_ladder`/`resolve_ladder` — K-way argmax markets over 3–8 bound runs; dead-heat pro-rata ties, legs that land nothing forfeit at 0 instead of cancelling (a cancel would be a free exit for losing leg operators), any-leg betting latch + required `closes_at`; E2E proves a 30/20/10 race → mask `0b001` → pro-rata claim
- [x] Web: `web/index.html` single-file leaderboard + proof explorer + market board over any RPC
- [x] Output proofs: `sealed prove` + in-browser verifier against onchain `outputs_root`
- [x] Spot-check audit: `reveal_part` circuit + `chain reveal`/`chain verify` — authority declassifies answer fingerprints via MPC; E2E test confirms 8 declassified hashes equal the planted answers and non-authority reveals are rejected
- [x] **Selective question disclosure**: `reshare_part` re-encrypts a private bank's specs to a delegate's x25519 key inside MPC — `ShareGrant` PDAs record who can see which parts; E2E proves the delegate decrypts items identical to the authority's, the authority's key cannot open the delegate's grant, non-authority reshares are rejected, and the suite salts bank ids per run so 13/13 tests pass on any ledger
- [x] Devnet: programs `FGVuEo…`/`8VSHkh…`, MXE on cluster 456, comp defs + circuits uploaded
- [ ] Devnet sealing: blocked on an Arcium devnet outage — cluster 456 finalizes computations but does not submit callback txs (`callbackTransactionsSubmittedBm=0`); `scripts/seal-devnet-retry.sh` completes sealing automatically when it recovers

MIT.
