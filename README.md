# Sealed

**A benchmark nobody can read, scored by nobody in particular.**

Sealed is a referee for AI-capability claims. The answer key to a benchmark exists onchain only as ciphertext that a single party cannot decrypt; models are scored inside an [Arcium](https://arcium.com) MPC cluster; the score is written to Solana by the cluster's callback, not by us. Anyone can build a market on "does model X clear 70% on Sealed v1 by date D" and settle it without trusting a leaderboard operator.

Built for Colosseum's Crypto World's Fair (Sep 14 – Oct 12, 2026).

## Why

Prediction markets on AI progress settle against leaderboards run by single companies, and lab-reported benchmark numbers are unverifiable and increasingly contaminated by training data. There is no neutral referee. Sealed makes the referee a protocol:

| Property | How |
|---|---|
| Questions are never published | Only a Merkle root of salted question commitments goes onchain (`Benchmark.items_root`). Retired items are revealed with their salt and checked against the root. |
| Answers are never in plaintext onchain | Answer hashes are encrypted by the author, then **re-encrypted to the MXE key inside MPC** (`seal_chunk`). After sealing, the author's key is discarded and the stored ciphertext can only be opened by the cluster acting together. |
| Scores are not posted by the operator | `score_chunk` compares a run's public output hashes with the sealed answers in MPC and reveals only the count. The Arcium callback writes it to the `Run` account. |
| Runs are commitments | A run commits to the Merkle root of all its output hashes before any chunk is scored, and every scored chunk's hashes are permanently in the transaction record. A bad run cannot be retracted. |
| Per-item results stay hidden | Only aggregate counts leave the circuit, so a run cannot be used to leak the answer to a specific item. |

## Architecture

```
packages/harness (TypeScript)            programs/sealed (Anchor)         encrypted-ixs (Arcis, runs in MPC)
------------------------------            ------------------------         ----------------------------------
buildBank(seed) -> prompts, answers  --> create_benchmark(items_root)
  answerHash = SHA256(...)[0..8]     --> init_chunk / stage_part (8 items)
  encrypt(RescueCipher, x25519)      --> seal_part  -------------------->  seal_part: Enc<Shared> -> Enc<Mxe>
                                         seal_part_callback <------------  (ciphertext stored in AnswerChunk)
runModel(model) -> outputs[]         --> create_run(outputs_root, fee)
  canonicalAnswer -> answerHash      --> score_chunk(outputs[32]) ------>  score_chunk: count(outputs == 4 sealed parts)
                                         score_chunk_callback <----------  reveals only the count
                                         Run.correct += count; finalized when all chunks scored
```

- **Items** are procedural, exact-answer tasks (arithmetic chains, stack-machine programs, list transforms, Caesar shifts, base conversion, grid walks, gcd/lcm, digit sums, calendar arithmetic, word sorting), generated from a master seed. The bank is infinite and fresh by construction; contamination is a rotation policy, not a hope.
- **Canonicalization** (`canonical.ts`) is the only normalization applied to a model's reply before hashing; author and runner use the same function.
- **Chunks** are 32 items, stored as 4 parts of 8. Sealing is per part because an MPC callback must fit in one Solana transaction (8 ciphertexts = 256 B; 32 would not). Scoring reads all 4 parts in one computation, so a run over a 10-chunk (320-item) bank is 10 MPC computations.
- **Fee**: `create_run` pays `Benchmark.fee_lamports` to the benchmark authority. That is the business.

### Markets (`programs/market`)

A second Anchor program hosts parimutuel YES/NO markets whose resolution input is a Sealed `Run` account — no oracle operator, no admin key deciding outcomes.

```
create_market(run, threshold)   open while run is pending and unscored (scored_mask == 0)
bet(side, lamports)             stake YES or NO; one position PDA per (market, bettor)
resolve()                       permissionless once run.status == FINALIZED:
                                outcome = run.correct >= threshold
claim()                         winners split the whole pot pro-rata; one-sided or
                                voided markets refund
```

The `Run` account is verified by owner (`SEALED_PROGRAM`) + discriminator and deserialized inside `resolve`, so the settlement source is the MPC-scored field itself. Betting closes the moment the first chunk is scored — before that, all a bettor can see is the model id and the committed `outputs_root`.

### Trust model (honest version)

- The item author knows the answers to the items they wrote. Sealing means no one *else* can read them from chain, including the author later or an operator who did not write them. Independent authors and in-MPC item generation (planned: arithmetic families generated from `ArcisRNG` so *no one* knows the answer) shrink this further.
- The runner controls what outputs it submits. Today the venue runs public model APIs itself; third-party runners get a TEE-attested harness or redundant runs from independent runners.
- Aggregate-only reveal plus a per-run fee bounds adaptive probing of individual answers.

## Repo layout

```
encrypted-ixs/          Arcis circuits: seal_chunk, score_chunk
programs/sealed/        Anchor program (Arcium MXE): registry, chunks, runs, callbacks
programs/market/        Anchor program: parimutuel markets resolving on Run.correct
packages/harness/       item generators, canonical hashing, model harness, chain client, CLI
web/index.html          leaderboard + proof explorer (single file, web3.js via CDN, reads any RPC)
tests/                  end-to-end test on Arcium localnet
scripts/                setup-wsl.sh (toolchain), install-solana-cdn.sh, run-model.sh, zen-*.sh
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
sealed chain seal  --bank bank/1.json --fee-lamports 1000000         # create_benchmark, stage + seal every part
sealed chain score --bank bank/1.json --run runs/….json              # create_run + score every chunk in MPC
sealed chain score --bank bank/1.json --run runs/….json --create-only  # park the run pending (for a market)
sealed chain score --bank bank/1.json --run runs/….json --run-index 1  # score an existing run
sealed chain status --benchmark <pubkey>                             # leaderboard from chain state

sealed chain market open    --run <pubkey> --threshold 55            # "will this run score >= 55?"
sealed chain market bet     --market <pk> --side yes --lamports 500000000 [--bettor kp.json]
sealed chain market resolve --market <pk>                            # settles off Run.correct
sealed chain market claim   --market <pk> [--bettor kp.json]
sealed chain market show    --market <pk>
```

Explorer: serve `web/` (`python3 -m http.server -d web 8788`) and open `?rpc=<url>` — defaults to localnet `http://127.0.0.1:8899`; on devnet it links out to explorer.solana.com.

Chain commands read `ANCHOR_PROVIDER_URL`, `ANCHOR_WALLET` and `ARCIUM_CLUSTER_OFFSET` (localnet: 0). `scripts/smoke-localnet.sh` runs the whole pipeline against a running `arcium localnet`.

Model calls go through any OpenAI-compatible endpoint (`SEALED_API_BASE`, `SEALED_API_KEY`; defaults to OpenRouter).

## Status

- [x] Circuits and program
- [x] Harness: generators, canonicalization, hashing, model client, run pipeline (tests green)
- [x] Localnet end-to-end: `arcium test` seals 2 chunks, scores a run (45/64 planted), finalizes
- [x] CLI pipeline on localnet: generated bank -> mock run -> MPC score 40/64, equal to the local pre-score
- [x] Real models through OpenCode Zen (free tier, `x-opencode-session` header): ling-3.0-flash-fin-free 58/64 and nemotron-3.5-lightning-free 59/64, both MPC-scored on localnet with MPC == local pre-score
- [x] Market program: parimutuel market resolved on `Run.correct` end-to-end on localnet (open -> YES/NO bets -> MPC score 59/64 -> resolve YES -> claim pays out)
- [x] Web: `web/index.html` single-file leaderboard + proof explorer + market board over any RPC
- [ ] Devnet deployment + first public leaderboard over real model APIs (cluster offset 456; needs devnet SOL — public faucet is rate-limited)

MIT.
