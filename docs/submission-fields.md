# Submission form copy — Crypto World's Fair

Colosseum's Cerebro engine machine-reads these fields before human judges see
anything. Keep each field crisp, concrete, and verifiable. This file is the
canonical copy to paste; update it when claims change.

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

Sealed is a Solana + Arcium protocol that removes the trusted data party
entirely. Six Arcis circuits run inside the MPC cluster:

- `gen_part` mints items inside the enclave — specs from ArcisRNG, answers
  computed and fingerprinted in-circuit, born `Enc<Mxe>`. No answer key is
  ever materialized outside the cluster.
- `gen_part_private` returns specs as `Enc<Shared>` to the authority — the
  questions never appear in plaintext on-chain either.
- `reshare_part` re-encrypts spec parts to a delegate's key — selective,
  one-directional, recorded in `ShareGrant` PDAs; answers never move.
- `score_chunk` compares a run's committed `outputs_root` Merkle proof
  against sealed fingerprints inside MPC; the callback writes `Run.correct`.
- `seal_part` + `reveal_part` cover authored banks and fingerprint audits.

A second program hosts parimutuel markets — binary, N-way score bands,
head-to-head duels — resolving permissionlessly on `Run.correct`, with
fees, deadlines, void, and expiry; bets latch shut before the first scored
chunk. Verified: 9/9 E2E + 13/13 unit on a real MPC localnet; a real model
(gpt-oss-20b) finalized 64/64 on the current evidence ledger — on-chain
score == local pre-score (run 4uns99WD).

## solanaIntegration

Two Anchor programs on Solana: `sealed` owns benchmark banks, item chunks,
sealed answer fingerprints, runs, share grants, and reveals; `market` hosts
parimutuel score-band and duel markets resolved from `Run.correct`. The
programs compose with the Arcium stack — MXE account, cluster, mempool/
execpool, comp defs, `queue_computation` + callback instructions — via six
Arcis circuits (seal/score/gen/gen_private/reveal/reshare). x25519 +
RescueCipher encrypt staged parts to the MXE key and shared grants to
delegates. Tooling: @solana/web3.js + @coral-xyz/anchor + arcium-anchor
client libs; `solana program deploy` for upgrades; a single-file explorer
reads program accounts or a committed snapshot and verifies Merkle proofs
against on-chain `outputs_root` in-browser.

## tractionMilestones

30+ sealed evaluations executed on the evidence ledger (generated, private,
and delegated runs), incl. real models — gpt-oss-20b 64/64 (fresh,
MPC-finalized), ling-3.0 58/64, nemotron-3.5 59/64 — every MPC score
identical to the local pre-score. `scripts/demo.sh` reproduces the full arc
(mint → disclose → run → market → settle) in one command; the explorer
renders everything from a committed snapshot — no localnet needed.

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
infrastructure: fresh private banks minted on demand (no key custody to sell),
delegated scoring runs for labs and judges, and the settlement layer every
"AI capability" market resolves against. Every future claim about what a
model can do is addressable surface area.

## competitiveLandscape

Melee hides your position; Bench hides your stake; Sealed hides the truth
itself — the market settles on an answer no human ever possessed. Lab
self-reports and leaderboard operators (LMArena, Epoch AI) hold the truth and
can leak or bias it; trusted-oracle committees just redistribute the trust;
TEE harnesses (Phala, NVIDIA CC) trust a hardware vendor; zkML/opML prove
inference transcripts, not the benchmark itself — and the operator still
holds the key. CrunchDAO (an Arcium partner) runs eval competitions but the
coordinator holds the answer key. Sealed's primitive is different in kind:
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

<TODO: 2-3 lines per member — prior ships, domain credibility, why this team.
Colosseum's criteria explicitly include founder-market fit; omitting team
background is a listed submission mistake.>

## demoVideo / publicDemo

- Demo video (≤3 min, product running — not a pitch): record `scripts/demo.sh`
  per `docs/video-script.md`; every beat is a real command with real output.
- Public URL: serve the explorer with its committed snapshot so judges can
  click without a localnet — `python3 -m http.server -d . 8788` →
  `http://localhost:8788/web/?snapshot=/docs/evidence/snapshot.json`
  (the bundled `web/snapshot.json` also auto-fallbacks when RPC is down).
  For a hosted link, deploy `web/` + `web/snapshot.json` + `web/sample-proof.json`
  to any static host — the page needs no backend.
- Repo must be public or judges invited — most common disqualifying mistake.
