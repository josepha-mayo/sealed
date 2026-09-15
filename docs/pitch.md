# Sealed — pitch & demo script

Target: Crypto World's Fair submission. Judging weights founder+market fit, insight,
product+execution, market size, communication, viability, traction.

## 30-second version

AI capability is becoming a tradable asset — but every market and leaderboard that
prices it settles on numbers a lab reported about itself, on benchmarks that leak
into training data. Sealed is the referee: a benchmark whose answer key exists on
Solana only as ciphertext no single party can decrypt, scored inside an Arcium MPC
cluster, with the score written onchain by the cluster's own callback. Then a
parimutuel market resolves directly on that score — no operator, no leaderboard
in the loop. The leaderboard is the oracle.

## Pitch beats (~2.5 min)

1. **Hook (0:15)** — "Who verifies that GPT-X really scored 92%? Today: nobody.
   The lab ran the eval, the lab published the number, and the benchmark may
   already be in the training set."
2. **Insight (0:30)** — "The failure isn't the benchmark, it's the trust path.
   Fixing contamination with a better dataset doesn't work — any public dataset
   leaks. Fixing honesty with a better leaderboard doesn't work — the operator
   is the trust bottleneck. What's needed is a score nobody can read early and
   nobody can edit late."
3. **Product (0:45)** — walk the pipeline: author commits item bank by Merkle
   root → answers re-encrypted to the MXE key inside MPC (the author's key is
   discarded) → a model's outputs are committed by hash root before scoring →
   the cluster counts matches inside the encryption boundary and reveals only
   the count → the callback writes `Run.correct` onchain.
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
| 1. Build a bank | `sealed bank build --seed s --id 8 --chunks 10` | "320 procedurally-generated items. The bank is infinite; contamination is a rotation policy." |
| 2. Seal it | `sealed chain seal --bank bank-8.json` | "Answers are encrypted to the MXE key inside MPC, 8 items per transaction. After this, no one — including me — can read them from chain." |
| 3. Run a real model | `scripts/run-model.sh bank-8.json <model>` | "A real model API, normalized to canonical answers, hashed publicly." |
| 4. Park the run | `sealed chain score ... --create-only` | "The run commits its output root before scoring. Now the market opens." |
| 5. Open a market + bet | `sealed chain market open --run <pk> --threshold 55` then `market bet` ×2 | "'Will it clear 55/64?' Bets close the moment scoring starts — after that the score leaks information." |
| 6. Score in MPC | `sealed chain score --bank bank-8.json --run … --run-index N` | "Each chunk is one MPC computation. Only the count leaves the circuit." |
| 7. Explorer | open `web/index.html` | "Leaderboard from raw chain state — items root, outputs root, MPC score." |
| 8. Resolve + claim | `chain market resolve` / `claim` | "The market read `Run.correct` itself. Winner withdraws; the loser has nothing to claim." |

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
- **Status:** localnet end-to-end verified — 320-item bank sealed (40 MPC
  computations), real models scored (ling 58/64, nemotron 59/64, mock 222/320),
  market resolved and paid out, mocha suite green.
- **Business:** per-run fee to the benchmark authority; take rate on market
  settlement; sell sealed-eval as a service to labs, markets, and insurers.
- **Moat:** the answer bank is unreadable even to us — a fresh bank is a
  rotation policy, not a trust request.
