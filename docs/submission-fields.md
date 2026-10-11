# Submission form copy — Crypto World’s Fair

Prepared from the code and replay evidence. These are draft answer blocks; map them to the live Colosseum form. No fabricated customers, founder history, or market-size estimates.

## shortDescription

Private exams. Public scores. Markets that settle themselves. Sealed uses Arcium MPC to score committed model outputs on Solana, then pays capability bounties and resolves markets from the result account.

## problemStatement

An evaluation sponsor wants to pay for a model that meets a target without publishing the exam or trusting a runner’s score. A market pricing that target needs a precise settlement source. A private spreadsheet protects the exam only while its custodian stays honest; a public leaderboard discloses data and still relies on its operator. Sealed separates the questions, the committed outputs, and the public result. Our concrete starting point is sponsored evaluations for a narrow, machine-checkable task, with a bounty paid to the first qualifying run.

## technicalApproach

Six Arcis circuits support authored and MPC-generated banks, confidential scoring, controlled reveal, and selective question disclosure. Private generated questions are secret-shared at mint, encrypted to a viewer, and bound by a spec commitment. A run commits its output root before scoring. The MPC callback writes the aggregate result. A second Anchor program settles score-band markets, duels, ladders, dark commit-reveal markets, and capability bounties from Run.correct. The explorer replays the frozen evidence and deliberately forged cards. Python and TypeScript implementations independently check the same artifacts. MPC confidentiality depends on the executing committee; model identity remains runner-declared.

## solanaIntegration

Solana supplies PDA-bound bank/run/receipt accounts, output commitments, lamport escrow, permissionless resolution, and payouts. Two Anchor programs compose with Arcium’s MXE, computation definitions, queue, and verified callbacks. The capability registry is readable by another application without asking our server. x25519 and RescueCipher deliver questions to authorized viewers. The hosted explorer runs without a wallet using a frozen capture; a live RPC mode is available separately. The testnet programs exist, but the capture is localnet evidence and the latest Rust changes are not claimed as deployed. The TypeScript client uses @anchor-lang/core and @solana/web3.js.

## tractionMilestones

Engineering evidence, not customer traction: the merged localnet capture has 120 banks, 503 run accounts (406 finalized), 340 venues, 31 model records and 292 score receipts. Four local open-weights models exercised the scoring and settlement flow. A saved stale-artifact run claimed 64/64 locally and scored 1/64 in MPC; this is a controlled mismatch demonstration, not evidence of a dishonest provider. The calibration bank allows independent arithmetic rescoring. The evidence catalog has 216 entries plus its own index, and includes 57 tamper exhibits. We have no verified paying customers or independent production volume. Test results and deployment limits are recorded in docs/audit-2026-10-11.md.

## targetAudience

Start with a sponsor choosing a model for one measurable task: an evaluation organization, AI application team, or model competition organizer. They need a sealed test, a reproducible result, and a payout condition. Runners get a defined target and a receipt; judges get delegated question access and verifiable evidence. Prediction-market builders are a follow-on integration because they can consume the same result account. We will validate the sponsor workflow before expanding to general AI capability markets.

## businessModel

The prototype implements two fee paths: a bank authority can charge a per-run lamport fee, and a market authority can set a bounded resolution fee. Amounts in the localnet capture are test activity, not sales. The initial business hypothesis is paid sponsored evaluations: charge for creating and operating private banks, with repeat run fees as sponsors compare candidates. A pilot should measure setup cost, time to a usable result, repeat evaluations and willingness to pay. We have not yet validated pricing, customer acquisition or real-money unit economics.

## competitiveLandscape

A hosted evaluator keeps a private exam but owns the scoring service. A public benchmark is easy to inspect but can become available to runners in advance. An encrypted-position market protects bets while still depending on its resolution source. Sealed’s combination is a confidential exam, committed outputs, an MPC-written score and contracts that settle from that score. It removes a single scoring operator from the result path under the MPC committee’s assumptions. It does not eliminate insider knowledge, prove model identity, or certify general intelligence. The shipped arithmetic tasks demonstrate custody and settlement integrity; harder task families are future work.

## futureVision

Make a funded capability target as inspectable as a token transfer: define the bank and threshold, disclose only the necessary questions, commit outputs, compute the result and pay from escrow. First validate repeat sponsored evaluations with a narrow task family. Then add independent model-runner attestation and more useful confidential task families. Confidential inference could later extend the trust boundary, but it is not shipped. Our near-term distribution is an open result-account interface and shareable proof cards that an evaluation sponsor or market can integrate.

## teamBackground

Joseph Mayo owns and leads Sealed. The repository contains two Anchor programs, six Arcis circuits, a TypeScript harness, Python replay verifier and browser explorer. Development and audit work used Devin and Codex assistance; the security and product claims are tied to reproducible artifacts rather than agent assurances. The visible repository history begins on September 15, 2026. Relevant experience, time commitment, prior work outside this repository and other founder details must be supplied by Joseph where the form requests them; they are not inferred from the code.

## demoVideo

Public product: https://josepha-mayo.github.io/sealed/ . Audit deep link: https://josepha-mayo.github.io/sealed/?mega=1 . Source: https://github.com/josepha-mayo/sealed . Video URLs remain pending. Colosseum’s public FAQ asks for a presentation of up to two minutes and a separate product demo of no more than three minutes. The live Colosseum form confirms separate pitch and demo URLs. It states no face-on-camera requirement. The product demo can show the case file, receipt-cloning rejection, delegated question decrypt and complete replay. The presentation covers the sponsor problem, commercial hypothesis, evidence and honest limits.
