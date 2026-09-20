# Sealed — pitch & demo script

Target: Crypto World's Fair submission. Judging weights founder+market fit, insight,
product+execution, market size, communication, viability, traction.

## 30-second version

AI capability is becoming a tradable asset — but every market and leaderboard that
prices it settles on numbers a lab reported about itself, on benchmarks that leak
into training data. Sealed is the referee: a benchmark whose items are **minted
inside an Arcium MPC cluster** — the specs drawn from MPC randomness, the answers
computed and fingerprinted inside the enclave, born encrypted to a key no single
party holds. No answer key ever exists in plaintext. Not in our repo, not in a
KMS, not in the author's head. Models commit outputs publicly, the cluster counts
matches inside the encryption boundary and writes only the score onchain — and a
parimutuel market resolves on that number. The leaderboard is the oracle.

## Pitch beats (~2.5 min)

1. **Hook (0:15)** — "Who verifies that GPT-X really scored 92%? Today: nobody.
   The lab ran the eval, the lab published the number, and the benchmark may
   already be in the training set."
2. **Insight (0:30)** — "The failure isn't the benchmark, it's the trust path.
   Fixing contamination with a better dataset doesn't work — any public dataset
   leaks. Fixing honesty with a better leaderboard doesn't work — the operator
   is the trust bottleneck. What's needed is a score nobody can read early and
   nobody can edit late."
3. **Product (0:45)** — walk the generated pipeline: `chain gen` queues MPC
   computations that draw item specs from `ArcisRNG`, evaluate the answer
   in-circuit, fingerprint it (SHA3-256), and return it encrypted to the MXE
   key. Only the specs come back public — anyone can render the questions,
   nobody can read the answers. Then the escalation: `chain gen-private`
   mints the same items but returns them `Enc<Shared>` to the authority —
   **the questions never touch the chain in plaintext either**. The account
   holds ciphertext; `items_root` commits to the ciphertext, so the mint is
   auditable but unreadable. And disclosure is selective, not binary:
   `reshare_part` re-encrypts a private bank's specs *to a second key* inside
   MPC — hand the judge the exam without publishing it, while the
   `ShareGrant` trail proves who can see what. → a model's outputs are committed by hash root
   before scoring → the cluster counts matches inside the encryption boundary
   and reveals only the count → the callback writes `Run.correct` onchain.
   (Authored banks still work: `seal` re-encrypts a staged answer to the MXE
   key, but generated banks are the honest primitive.)
4. **Why crypto is load-bearing (0:30)** — Solana is the commitment layer
   (roots, accounts, fees, market settlement); Arcium is the only reason the
   answers can be "onchain but unreadable" — trust is split across MPC
   nodes, so no single operator and no breakable chip holds the truth (TEE
   evals trust Intel; Arcium trusts math). Without MPC this is a database.
   Without the chain it's a promise. Confidential AI evaluation is exactly
   the flagship use-case MPC exists for — Sealed is it, productized.
5. **Market close (0:30)** — "Prediction markets on AI progress already exist
   and settle on vibes. Sealed turns 'will model X clear threshold T' into a
   contract that resolves itself. Fees: every run pays the benchmark authority;
   markets skim up to 10% at resolution (`fee_bps`), claimed by the authority
   with order-independent solvency. The surface area is every future claim
   about what a model can do."

## Demo shot list (~3 min)

All on `arcium localnet` (devnet once the Arcium callback outage resolves). Narrate the trust boundary,
not the commands.

| Shot | Command | Say |
|---|---|---|
| 1. Mint a bank | `sealed chain gen --id 8 --chunks 2` | "64 items minted inside MPC, 8 per computation. The questions are public; the answers were computed in the enclave and never left it." |
| 2. Show the items | `sealed chain items --benchmark <pk>` | "Anyone can render the specs into prompts — the specs are plaintext. The answers exist only as MXE ciphertext." |
| 3. Run a real model | `sealed run --bank bank/gen-8.json --model <model>` | "A real model API, normalized to canonical answers, hashed publicly." |
| 4. Park the run | `sealed chain score ... --create-only` | "The run commits its output root before scoring. Now the market opens." |
| 5. Open a market + bet | `sealed chain market open --run <pk> --threshold 55 --resolve-by +86400` then `market bet` ×2 (two wallets, both outcomes) | "'Will it clear 55/64?' Bets close the moment scoring starts — after that the score leaks information." |
| 6. Score in MPC | `sealed chain score --bank … --run … --run-index N` | "Each chunk is one MPC computation comparing output hashes to answers born encrypted. Only the count leaves the circuit." |
| 7. Explorer | open `web/index.html` | "Leaderboard from raw chain state — minted specs, items root, outputs root, MPC score. On bank 25864: `openai` 1/64 sits under `openai` 64/64 — a stale artifact claimed 64/64 locally and MPC said 1. The enclave's count is the score." |
| 8. Resolve + claim | `chain market resolve` / `claim` | "The market read `Run.correct` itself. Winner withdraws; the loser has nothing to claim." |
| 9. Duel (optional beat) | `sealed chain market duel --run-a <pk> --run-b <pk> --resolve-by +86400` | "Two runs, one sealed bank: 'who outscores whom?' — bets close once either side starts scoring, so nobody trades on a half-known result." |

## One-pager for the submission form

- **Name:** Sealed
- **Tagline:** A benchmark no one can leak, scored by nobody in particular.
- **Problem:** AI capability claims are unverifiable: labs self-report, public
  benchmarks leak into training data, and prediction markets have no neutral
  resolution source.
- **Solution:** An onchain benchmark registry whose answers live only as
  Arcium-MPC ciphertext. Models commit outputs publicly; the cluster reveals
  only aggregate scores; parimutuel markets settle directly on `Run.correct`.
- **Stack:** Solana (commitments, fees, settlement) + Arcium MPC (confidential
  scoring) + a TypeScript harness driving real model APIs (OpenRouter /
  OpenCode Zen compatible).
- **Status:** localnet end-to-end verified — public generated banks minted in
  MPC (specs public, answers born encrypted), **private generated banks whose
  specs are ciphertext-only onchain** (`Enc<Shared, Pack<GenPart>>` to the
  authority — questions AND answers both absent from public state), selective
  question disclosure to delegate keys (`reshare_part` — one-directional,
  grant trail onchain), on-chain MPC scores matching local pre-scores exactly,
  binary + N-way markets resolved and paid out, fingerprint reveal audits,
  mocha suite 9/9 + 12/12 unit tests green. Authored banks work too (seal+score).
- **Traction evidence:** 30+ sealed evaluations executed on the evidence
  ledger (generated + private + delegated runs), incl. real models — gpt-oss-20b
  64/64 fresh on the evidence ledger (run 3CKnMa8X), ling-3.0 58/64,
  nemotron-3.5 59/64 — every MPC score identical to the
  local pre-score, artifacts + tx proofs in `docs/evidence/`.
- **Business:** per-run fee to the benchmark authority (live on-chain); market
  take-rate on settlement (`fee_bps`, capped at 10%, live on-chain);
  sealed-eval as a service to labs, markets, and insurers.
- **Moat:** for generated banks the answer key never exists — not encrypted
  at rest, not held by a committee, not in the author's head. A benchmark
  with no secret to leak is a rotation policy, not a trust request.

## vs. the alternatives

| Approach | Who holds the truth | Can it leak? | Settles markets? |
|---|---|---|---|
| Lab self-report (SWE-bench, FrontierMath) | The lab being measured | Already in training data | Polymarket resolves on Epoch AI — a single conflicted party |
| On-chain arenas (Recall) | The operator — test sets public | Public evals are gameable/contaminable | Demand proven (7.8M predictions), no cheat-proof evals |
| Leaderboard operator (LMArena) | The operator | Operator sees votes + tests | No settlement layer |
| TEE pilot (DeepMind × OpenMined) | Enclave + one bespoke operator | One hardware trust domain, not a product | One-off research run — not permissionless |
| Trusted oracle / committee | The committee | Any member can leak | Yes, but trust-permissioned |
| zkML / opML | Proves "M(x)=y", not the eval | Operator still holds the key | Inference proofs only |
| **Sealed** | **No one — the key never exists outside the MPC** | **Nothing to leak: mint, key, and scoring stay inside the cluster** | **Yes — `Run.correct` written by MPC callback, markets resolve permissionlessly** |

Melee hides your position; Bench hides your stake; **Sealed hides the truth
itself** — the market settles on an answer no human ever possessed. Google
needed a bespoke TEE pilot to run one double-blind eval; Sealed makes it a
permissionless primitive. The private-bank path keeps questions
ciphertext-only; `reshare_part` hands a judge the exam without publishing it;
betting closes before scoring starts, so nobody trades on leaked
information. The repeatable one-liner: **the benchmark that can't leak.**
