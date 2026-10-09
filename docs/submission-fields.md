# Submission form copy — Crypto World's Fair

Colosseum's Cerebro engine machine-reads these fields before human judges see
anything. Keep each field crisp, concrete, and verifiable. This file is the
canonical copy to paste; update it when claims change.

## shortDescription (the tagline — Cerebro and judges parse this first)

The benchmark whose answer key never existed — the exam nobody can leak,
the score nobody can fake, the market that settles itself. Items are
minted inside an Arcium MPC cluster, the score lands on Solana, and
markets resolve off it permissionlessly. (≈280 chars.)

## problemStatement

AI capability claims are unverifiable. Labs self-report benchmark scores on
datasets that leak into training data — SWE-bench was effectively retired over
contamination, and OpenAI keeps a private FrontierMath subset it both funds and
exclusively accesses. Prediction markets already trade on model scores
(Polymarket's FrontierMath markets) but resolve against a single conflicted
party's leaderboard. Every trusted party in the eval loop — the item author,
the benchmark operator, the scoring harness, the leaderboard — can leak the
data or rig the number. There is no credibly neutral referee for what a model
can do. Today, a lab claiming "our 7B beats the frontier" must either
publish the eval — contaminating it overnight — or ask the market to
take its word. Every "will model X clear T" market resolves on whichever
leaderboard it happened to trust that week.

## technicalApproach

Sealed removes the trusted data party entirely: six Arcis circuits run
inside the Arcium MPC cluster. `gen_part` mints items inside the MPC cluster —
specs from ArcisRNG, answers fingerprinted in-circuit; no answer key ever
exists. `gen_part_private` returns specs as `Enc<Shared>` — questions never
appear in plaintext on-chain either. `reshare_part` re-encrypts spec parts
to a delegate's key (recorded in `ShareGrant` PDAs; answers never move).
`score_chunk` compares a run's committed `outputs_root` Merkle proof
against sealed fingerprints inside MPC; the callback writes `Run.correct`.
`seal_part`/`reveal_part` cover authored banks + audits.

A second program hosts parimutuel markets — score bands, duels, ladder
races, unseen-exam, commit-reveal dark markets, and FCFS capability
bounties (pot pays the first proven run's operator, not a bettor) —
resolving permissionlessly on `Run.correct`; bets latch before the
first scored chunk. Verified: 17/17 E2E on a real MPC localnet + 72/72
harness unit; four open-weights models settled real markets via MPC —
a dead-heat, a reshare-grant private exam, a dark market on a
ciphertext-only bank. Every primitive settled a real score.

## solanaIntegration

Two Anchor programs on Solana: `sealed` owns benchmark banks, item chunks,
sealed answer fingerprints, runs, share grants, and reveals; `market` hosts
pooled-stake (parimutuel) score-band, duel, ladder-race, unseen-exam, dark
commit-reveal markets, and capability bounties — all resolved from
`Run.correct`. The
programs compose with the Arcium stack — MXE account, cluster, mempool/
execpool, comp defs, `queue_computation` + callback instructions — via six
Arcis circuits (seal/score/gen/gen_private/reveal/reshare). x25519 +
RescueCipher encrypt staged parts to the MXE key and shared grants to
delegates. Tooling: @solana/web3.js + @coral-xyz/anchor + arcium-anchor
client libs; `solana program deploy` for upgrades; a single-file explorer
reads program accounts or a committed snapshot and verifies Merkle proofs
against on-chain `outputs_root` in-browser. Composability is executable:
`chain gate --min-pct 60 --vouched` evaluates a capability policy over the
registry's receipts (exit 0/1/2) — and the hosted explorer runs the same
policy in-page, off either a live RPC or the committed snapshot.
`chain market sweep` executes every permissionless venue action — venue
ops need no operator.

## tractionMilestones

120 banks minted, 503 runs, 340 venues across six primitives
(208 band/duel, 48 ladders, 47 dark, 37 bounties) — the offline audit
re-verifies 201 resolutions, 145 grants, 30 reveal burns: zero
plaintext answer keys on the committed ledger. Every primitive settled a
REAL open-weights model's MPC score: four local models raced an
MPC-minted exam — 3b 6/32 tied 1.5b 6/32 (dead-heat pro-rata), llama-1b
1/32, 0.5b 0/32 — plus a sealed dark leg. On a ciphertext-only PRIVATE
exam: 1.5b scored 8/32 via grants; a double-sealed dark market priced
the 3b's pending run; a band market settled the 0.5b's 2/32. gpt-oss-20b
hit 64/64 on MPC-minted 6932 — and a stale-artifact claim scored 1/64:
the chain never trusts self-reported scores. The capability registry
persists per-model records — 31 records / 292 receipts replayed
bit-exact in-browser; the calibration specimen replays the same MPC
arithmetic per-item (3b 7/32 vs 1.5b 2/32).
Outputs are portable proof — 142 artifacts / 13 kinds replay
keyless; `chain fingerprint` = one sha256 notarized on devnet;
13 canned forgeries die at named checks; tamper/ pins 15 forged
artifacts that verify by being REJECTED — `verify.py` redoes it
in Python.

## targetAudience

Three buyers today: (1) prediction-market operators and traders who need a
neutral resolver for "will model X clear T" — the market settles itself off
MPC output rather than a leaderboard's word; (2) AI labs and eval orgs that
need to prove a score without publishing a benchmark that instantly
contaminates — sealed-eval-as-a-service; (3) model providers and judges who
receive the exam through selective disclosure — they can be scored on
questions that were never public while the answer key remains cluster-sealed.
Adjacent: insurers, auditors, and DAOs pricing AI capability risk. The
demand side is proven: prediction venues cleared ~$63.5B notional in 2025
(4x YoY; Kalshi ~$23B and Polymarket ~$22B of it) — and AI-category
markets already trade, all of them resolving on truth a human holds. The
eval supply side is ~$1.2B (2024) growing toward ~$9.7B by 2033 — labs
pay for scores they still cannot prove. Sealed is where both converge —
every future claim about what a model can do is addressable market
surface.

## businessModel

Who earns is on-chain, not asserted: `create_run` pays `fee_lamports` to
the bank authority; `fee_bps` skims at venue resolution (`claim_fee`).
The committed digest recomputes it from decoded bytes: 1.73 SOL charged
in bank run-fees across 174 paid runs on 28 fee-bearing banks, 44 venues
with a nonzero take-rate, 33 of 37 bounties claimed. The durable
business is sealed-evaluation infrastructure: private banks minted on
demand (no key custody to sell), delegated scoring for labs and judges,
and the settlement layer every "AI capability" market resolves against —
Polymarket+Kalshi alone cleared ~$63.5B notional in 2025 (public
reported volume); a 1% settlement take on the AI-capability slice is a
~$100M+ wedge, not hand-waving at volume.
Six primitives ship: duels, K-way ladders, unseen-exam markets, dark
commit-reveal, capability bounties, committed-settle expiry. Unit
economics: a 64-item exam ≈0.02 SOL rent; a bettor seat ≈0.002 SOL,
refunded. Any venue composes on `Run.correct` permissionlessly — the
referee is infrastructure, not a vendor.

## competitiveLandscape

Melee hides your position; Bench hides your stake; Pythia, Epoch and
Flew hide your bets; Sealed hides the truth itself — the market settles
on an answer no human ever possessed. The other Arcium-market projects encrypt
user inputs and resolve ordinary opinion events; Sealed's differentiator
is that the *resolution truth* is confidential until computed — insider
knowledge is cryptographically impossible, not just discouraged. Lab
self-reports and leaderboard operators (LMArena, Epoch AI) hold the truth and
can leak or bias it; trusted-oracle committees just redistribute the trust;
TEE harnesses (Phala, NVIDIA CC) trust a hardware vendor; zkML/opML prove
inference transcripts, not the benchmark itself — and the operator still
holds the key. CrunchDAO (an Arcium partner) runs eval competitions but the
coordinator holds the answer key; Solarium's blind-judge consensus is
economic, not confidential. Sealed's primitive is different in kind:
items are minted inside MPC, so there is no key to leak, sell, or subpoena —
and settlement is permissionless because the chain itself reads the score.

## futureVision

The resolution layer for AI capability claims. Markets on model scores are
already traded; the missing piece was a number nobody could rig. Roadmap:
confidential stakes for markets (positions encrypted via the same MPC),
quorum/timed disclosure for judge panels, TEE-attested runner harnesses for
third-party operators, and
private banks as a service — any lab, insurer, or market can commission an
eval that cannot be leaked because nobody ever held it. The `Run.correct`
/`ModelRecord` registry is itself a credibly neutral public good — an open
capability registry any venue composes on permissionlessly. As confidential
inference (Arcium Blackthorn) matures, the runner's outputs can be sealed
end-to-end: questions, answers, and model replies all inside the encryption
boundary.

## teamBackground (facts need your sign-off — the copy below is paste-ready)

```
Joseph Mayo — solo build, end to end: two Anchor programs (sealed +
market, both upgradeable, both deployed and byte-verified on devnet),
the Arcium MPC circuits, the TypeScript harness and judge tooling, and
the hosted explorer. Built Sealed after watching model evaluations
collapses into "trust our numbers" — every benchmark that matters runs
behind closed weights, closed sets, or closed ledgers. The thesis this
project tests: the ledger itself can be the evaluator, so the evidence
outlives the pitch.
```

If solo, keep the same shape for yourself — one tight paragraph beats a
thin list. If any prior code was reused (harness patterns, explorer),
disclose it in the form's prior-work field — allowed but must be declared.

## demoVideo / publicDemo

- Demo video (≤3 min, product running — not a pitch): record `scripts/demo.sh`
  per `docs/video-script.md`; every beat is a real command with real output.
  An asciinema capture is pre-recorded at `docs/demo.cast` — render with
  `agg docs/demo.cast docs/demo.gif` or convert to mp4; embed in README.
- Public URL: **https://josepha-mayo.github.io/sealed/** — live explorer,
  auto-loads the bundled snapshot (no localnet needed); `?mega=1` runs the
  entire proof cascade unaided (audit → 142 replays → forgery sweep →
  sealed-exam decrypt → copyable verdict), `?decrypt=1` deep-links the
  payoff. Served by `.github/workflows/pages.yml` on every push. Local
  fallback:
  `python3 -m http.server -d . 8788` →
  `http://localhost:8788/web/?snapshot=/docs/evidence/snapshot.json`.
- Repo must be public or judges invited — most common disqualifying mistake.
