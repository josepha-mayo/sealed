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
entirely. Six Arcis circuits run inside the Arcium MPC cluster:

- `gen_part` mints benchmark items inside the enclave — specs drawn from
  ArcisRNG, answers computed and SHA3-fingerprinted in-circuit, born encrypted
  to the MXE key. No answer key is ever materialized outside the cluster.
- `gen_part_private` returns the specs themselves as `Enc<Shared>` ciphertext
  to the authority's x25519 key — questions never appear in plaintext on-chain.
- `reshare_part` re-encrypts individual spec parts to a delegate's key —
  selective, one-directional, recorded in on-chain `ShareGrant` PDAs. A judge
  or model provider rebuilds the exam from grants alone; answers never move.
- `score_chunk` compares a run's committed output hashes against sealed
  fingerprints inside MPC and reveals only the count; the cluster's callback
  writes `Run.correct` on-chain.
- `seal_part` (authored banks) and `reveal_part` (fingerprint spot-check
  audits) round out the pipeline.

A second Anchor program hosts parimutuel markets — binary, N-way score bands,
and head-to-head duels — that resolve permissionlessly by reading
`Run.correct` itself. Betting closes before the first scored chunk, so nobody
trades on leaked information. Solana carries commitments, fees, and
settlement; Arcium carries everything that must exist but must not be
readable. Verified: 8/8 E2E + 12/12 unit tests on a real MPC localnet, and a
real model (gpt-oss-20b) finalized 32/32 with the on-chain score identical to
the local pre-score.

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
(`create_run` transfers `fee_lamports`). Market take-rate on settlement is a
one-line `claim` extension. The durable business is sealed-evaluation
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
quorum/timed disclosure for judge panels, market take-rate on settlement,
on-chain verification of output Merkle proofs inside the market program, and
private banks as a service — any lab, insurer, or market can commission an
eval that cannot be leaked because nobody ever held it. As confidential
inference (Arcium Blackthorn) matures, the runner's outputs can be sealed
end-to-end: questions, answers, and model replies all inside the encryption
boundary.
