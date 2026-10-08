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
| 9b. Ladder (optional beat) | `sealed chain market ladder open --legs <pk,pk,pk> --closes-at +86400 --resolve-by +86400` | "Or a K-way race: three models, one pot, argmax takes it — dead-heat splits ties, and a leg that never shows up forfeits at 0 instead of refunding its backers out." |
| 9c. Unseen exam (optional) | `scripts/unseen.sh` | "And the strangest market here: bettors just filled positions on an exam that was never published — not before the market, not during, not after. The event being priced is itself confidential." |
| 10. The honest leaderboard | `sealed chain compare --all` | "And because aggregates lie — the registry receipts join by shared benchmark into a paired W-L-T table. Models that never took the same exam count as unranked, not assumed. Most leaderboard pairs share nothing; this one says so." |
| 10b. The disagreement detector (optional beat) | `sealed chain market divergence` | "Four ways to rank a model exist now — receipts, paired evidence, settlement, belief — none of them a leaderboard's word. And when the money disagrees with the receipts, this says by exactly how much: the market priced its third-heaviest book on a model that loses every paired comparison." |
| 11. The submission audits itself | `sealed chain tour --snapshot web/snapshot.json` | "No trust required: one command replays the whole ledger offline — a run's custody trail, its feed, a venue's book, a bettor's P&L — and closes on where the money disagrees with the receipts. Paste any pubkey into the explorer or `chain search` and it tells you what that key IS and where its dossier lives." |

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
  scoring) + a TypeScript harness driving real model APIs (any
  OpenAI-compatible endpoint — Pollinations, OpenRouter, Zen).
- **Status:** localnet end-to-end verified — public generated banks minted in
  MPC (specs public, answers born encrypted), **private generated banks whose
  specs are ciphertext-only onchain** (`Enc<Shared, Pack<GenPart>>` to the
  authority — questions AND answers both absent from public state), selective
  question disclosure to delegate keys (`reshare_part` — one-directional,
  grant trail onchain), on-chain MPC scores matching local pre-scores exactly,
  six settlement primitives resolved and paid out (score-bands, duels,
  K-way ladder races with dead-heat pro-rata, unseen-exam markets, dark
  commit-reveal markets, capability bounties), a persistent permissionless
  capability registry (`ModelRecord`/`ScoreLog`), fingerprint reveal audits,
  mocha suite 17/17 + 67/67 harness unit tests green. Authored banks work too (seal+score).
  And the outputs aren't claims you take on faith — `chain prove` mints a
  portable `sealed-claim/v1` card per model (PDAs re-derive keyless,
  verdicts replay, tamper fails, and `--verify <card> --min-pct N`
  re-grades it against the CALLER's policy — authentic AND sufficient),
  `chain gate --all --cert` binds a whole policy decision into a
  `sealed-policy/v1` certificate (the governance artifact — DAO proposals,
  insurer memos), `chain report` prints the dossier as a document,
  `chain anomalies` runs twelve hostile audits on its own bundle, and
  `chain market escrow` + `unclaimed` reconcile every staked lamport to
  the obligation — and the claimant — it sits with. `chain artifact
  docs/evidence --recursive` replays all 138 committed artifacts in one
  pass; `chain fingerprint` folds the entire evidence base into a
  single sha256 the terminal and the browser agree on.
- **Traction evidence:** 503 runs / 120 banks / 340 venues across six
  primitives on the merged evidence ledger (8 epochs) — 201 resolutions
  re-derived bit-exact by the offline audit, 31 capability records replayed
  from 292 receipts. Real models through the full MPC pipeline: a
  four-model race on an MPC-minted exam with a natural dead-heat, a
  sponsor-paid **0.1 SOL bounty claimed by an independent operator** whose
  model provably cleared the threshold, a double-sealed dark market on a
  ciphertext-only bank, gpt-oss-20b 64/64 on a bank whose answer key never
  existed — and a stale-artifact cheat scored 1/64 honestly.
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

And the evidence isn't a folder of promises — it is one hash. `chain
fingerprint` re-hashes all 351 manifest-pinned files and prints a single
`BUNDLE ROOT`; the explorer's bundle replay recomputes the same root
in-browser after driving all 138 committed artifacts through their own
verifiers. Terminal and browser agree, or the bundle is dirty. The
submission ends in a sha256 — not a promise.
