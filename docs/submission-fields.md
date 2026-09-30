# Submission form copy — Crypto World's Fair

Colosseum's Cerebro engine machine-reads these fields before human judges see
anything. Keep each field crisp, concrete, and verifiable. This file is the
canonical copy to paste; update it when claims change.

## shortDescription (the tagline — Cerebro and judges parse this first)

A benchmark whose answer key was never written down, scored by nobody in
particular: benchmark items are minted inside an Arcium MPC cluster, model
runs are scored in-MPC and the count lands on Solana, and markets settle
themselves off that number — the referee for AI capability is now
infrastructure, not a vendor. (≈330 chars — trim to the form's limit.)

## problemStatement

AI capability claims are unverifiable. Labs self-report benchmark scores on
datasets that leak into training data — SWE-bench was effectively retired over
contamination, and OpenAI keeps a private FrontierMath subset it both funds and
exclusively accesses. Prediction markets already trade on model scores
(Polymarket's FrontierMath markets) but resolve against a single conflicted
party's leaderboard. Every trusted party in the eval loop — the item author,
the benchmark operator, the scoring harness, the leaderboard — can leak the
data or rig the number. There is no credibly neutral referee for what a model
can do.

## technicalApproach

Sealed removes the trusted data party entirely: six Arcis circuits run
inside the Arcium MPC cluster. `gen_part` mints items inside the enclave —
specs from ArcisRNG, answers fingerprinted in-circuit; no answer key ever
exists. `gen_part_private` returns specs as `Enc<Shared>` — questions never
appear in plaintext on-chain either. `reshare_part` re-encrypts spec parts
to a delegate's key (recorded in `ShareGrant` PDAs; answers never move).
`score_chunk` compares a run's committed `outputs_root` Merkle proof
against sealed fingerprints inside MPC; the callback writes `Run.correct`.
`seal_part`/`reveal_part` cover authored banks + fingerprint audits.

A second program hosts parimutuel markets — score bands, duels, ladder
races, unseen-exam, and commit-reveal dark markets — resolving
permissionlessly on `Run.correct`; bets latch before the first scored
chunk. Verified: 13/13 E2E + 13/13 unit on a real MPC localnet. Real
open-weights models, zero external API: qwen2.5-1.5b 3/32 vs qwen2.5-0.5b
1/32 dueled on an MPC-minted exam — market opened and filled on pending
runs, settled straight off MPC scores; the 1.5b also scored 8/32 on a
private bank readable only via reshare grants.

## solanaIntegration

Two Anchor programs on Solana: `sealed` owns benchmark banks, item chunks,
sealed answer fingerprints, runs, share grants, and reveals; `market` hosts
parimutuel score-band, duel, ladder-race, unseen-exam, and dark
commit-reveal markets resolved from `Run.correct`. The
programs compose with the Arcium stack — MXE account, cluster, mempool/
execpool, comp defs, `queue_computation` + callback instructions — via six
Arcis circuits (seal/score/gen/gen_private/reveal/reshare). x25519 +
RescueCipher encrypt staged parts to the MXE key and shared grants to
delegates. Tooling: @solana/web3.js + @coral-xyz/anchor + arcium-anchor
client libs; `solana program deploy` for upgrades; a single-file explorer
reads program accounts or a committed snapshot and verifies Merkle proofs
against on-chain `outputs_root` in-browser.

## tractionMilestones

Hundreds of MPC computations executed on the committed evidence ledger —
11 banks minted (generated + private + authored), 39 runs created and 33
finalized by the cluster, 27 markets resolved on-chain across five
primitives (score-band, duel, ladder race, unseen-exam, dark
commit-reveal) paying pro-rata, 14 selective-disclosure grants,
2 fingerprint reveal audits — 0 plaintext answer keys anywhere. Real
open-weights models, no external API: qwen2.5-1.5b beat qwen2.5-0.5b
3–1 on an MPC-minted exam inside a live duel market (7p32UT6s), and
the 1.5b scored 8/32 on a private exam it could only read through
reshare grants (7S9ZmxrT — the exam was never published). Prior
gpt-oss-20b runs: 64/64 on MPC-minted bank 6932 (HW5H5bT7), 64/64 on
authored 25864 (4uns99WD) — and a stale-artifact claim scored 1/64
(3CKnMa8X), proving the chain never trusts self-reported scores.
`node scripts/verify.mjs` re-audits the whole bundle offline (10/10
checks); the hosted explorer runs the same audit in-browser.

## targetAudience

Three buyers today: (1) prediction-market operators and traders who need a
neutral resolver for "will model X clear T" — the market settles itself off
MPC output rather than a leaderboard's word; (2) AI labs and eval orgs that
need to prove a score without publishing a benchmark that instantly
contaminates — sealed-eval-as-a-service; (3) model providers and judges who
receive the exam through selective disclosure — they can be scored on
questions that were never public while the answer key remains cluster-sealed.
Adjacent: insurers, auditors, and DAOs pricing AI capability risk.

## businessModel

Per-run fees paid to the benchmark authority are live on-chain today
(`create_run` transfers `fee_lamports`), and market take-rate on settlement is
live too (`fee_bps` skimmed at resolution, authority-claimed via `claim_fee`).
The durable business is sealed-evaluation
infrastructure: fresh private banks minted on demand (no key custody to
sell), delegated scoring runs for labs and judges, and the settlement
layer every "AI capability" market resolves against. Five novel
settlement primitives ship: run duels (latch on either leg's first queue),
K-way ladder races (argmax, dead-heat pro-rata, dead legs forfeit),
unseen-exam markets (a market fills on a private-bank run — the priced
event is itself confidential), dark commit-reveal markets (sha256
commitments seal every side; no-shows forfeit), and committed-settle
expiry (a stalled run refunds unless the runner committed every chunk).
Unit economics: a 64-item exam ≈0.02 SOL total account rent; a bettor
seat ≈0.002 SOL, refunded on claim/close. Any venue composes on
`Run.correct` permissionlessly — the referee is infrastructure, not a
vendor.

## competitiveLandscape

Melee hides your position; Bench hides your stake; Epoch and Flew hide
your bets; Sealed hides the truth itself — the market settles on an
answer no human ever possessed. The other Arcium-market projects encrypt
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
eval that cannot be leaked because nobody ever held it. As confidential
inference (Arcium Blackthorn) matures, the runner's outputs can be sealed
end-to-end: questions, answers, and model replies all inside the encryption
boundary.

## teamBackground (fill before submitting — judges score it)

Colosseum scores founder-market fit; this field is machine-read by Cerebro
first. Fill in the bracketed bits — 2-3 lines per member, concrete ships
over adjectives:

```
[Name] — [role]. Shipped [protocol/product + chain + scale metric, e.g.
"a Solana program with $X TVL" / "infra used by N teams"]. [Domain
credibility: security audit background, applied crypto, ML eval work,
prior hackathon wins]. Built Sealed because [one line: the trusted-eval
problem you hit firsthand].
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
  auto-loads the bundled snapshot (no localnet needed). Served by
  `.github/workflows/pages.yml` on every push. Local fallback:
  `python3 -m http.server -d . 8788` →
  `http://localhost:8788/web/?snapshot=/docs/evidence/snapshot.json`.
- Repo must be public or judges invited — most common disqualifying mistake.
