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
   answers can be "onchain but unreadable." Without MPC this is a database.
   Without the chain it's a promise.
5. **Market close (0:30)** — "Prediction markets on AI progress already exist
   and settle on vibes. Sealed turns 'will model X clear threshold T' into a
   contract that resolves itself. Fees: every run pays the benchmark authority;
   markets add take-rate on settlement. The surface area is every future claim
   about what a model can do."

## Demo shot list (~3 min)

All on `arcium localnet` (or devnet once funded). Narrate the trust boundary,
not the commands.

| Shot | Command | Say |
|---|---|---|
| 1. Mint a bank | `sealed chain gen --id 8 --chunks 10` | "320 items minted inside MPC, 8 per computation. The questions are public; the answers were computed in the enclave and never left it." |
| 2. Show the items | `sealed chain items --benchmark <pk>` | "Anyone can render the specs into prompts — the specs are plaintext. The answers exist only as MXE ciphertext." |
| 3. Run a real model | `sealed run --bank bank/gen-8.json --model <model>` | "A real model API, normalized to canonical answers, hashed publicly." |
| 4. Park the run | `sealed chain score ... --create-only` | "The run commits its output root before scoring. Now the market opens." |
| 5. Open a market + bet | `sealed chain market open --run <pk> --threshold 55` then `market bet` ×2 | "'Will it clear 55/64?' Bets close the moment scoring starts — after that the score leaks information." |
| 6. Score in MPC | `sealed chain score --bank … --run … --run-index N` | "Each chunk is one MPC computation comparing output hashes to answers born encrypted. Only the count leaves the circuit." |
| 7. Explorer | open `web/index.html` | "Leaderboard from raw chain state — minted specs, items root, outputs root, MPC score." |
| 8. Resolve + claim | `chain market resolve` / `claim` | "The market read `Run.correct` itself. Winner withdraws; the loser has nothing to claim." |
| 9. Duel (optional beat) | `sealed chain market duel --run-a <pk> --run-b <pk>` | "Two runs, one sealed bank: 'who outscores whom?' — bets close once either side starts scoring, so nobody trades on a half-known result." |

## One-pager for the submission form

- **Name:** Sealed
- **Tagline:** A benchmark nobody can read, scored by nobody in particular.
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
  mocha suite 8/8 + 12/12 unit tests green. Authored banks work too (seal+score).
- **Business:** per-run fee to the benchmark authority; take rate on market
  settlement; sell sealed-eval as a service to labs, markets, and insurers.
- **Moat:** for generated banks the answer key never exists — not encrypted
  at rest, not held by a committee, not in the author's head. A benchmark
  with no secret to leak is a rotation policy, not a trust request.
