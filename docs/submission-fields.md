# Submission form copy — Crypto World’s Fair

Prepared from the code and replay evidence. These are draft answer blocks; map them to the live Colosseum form. No fabricated customers, founder history, or market-size estimates.

## shortDescription

Proof before payout. Sealed helps evaluation sponsors set an evidence rule, reject weak model claims and export a decision another person can verify. Its Proof Room supports blind review, receipt-completeness attacks and a captured bounty replay over Solana accounts and Arcium MPC scores. The wallet-free demo uses localnet arithmetic evidence.

## problemStatement

A sponsor choosing a model needs to know whether its own task and evidence requirements were met. A high aggregate score can hide different exams, exposed answers, thin samples or duplicated receipts. Sealed binds the decision to one exact exam, checks all captured receipt membership, and reports missing proof. If nobody qualifies, it exports that refusal rather than recommending a winner. The first intended users are evaluation organizers and AI application teams funding a narrow, machine-checkable trial.

## technicalApproach

Six Arcis circuits support authored and MPC-generated banks, confidential scoring, controlled reveal, and selective question disclosure. Private generated questions are secret-shared at mint, encrypted to a viewer, and bound by a spec commitment. A run commits its output root before scoring. The MPC callback writes the aggregate result. A second Anchor program settles score-band markets, duels, ladders, dark commit-reveal markets, and capability bounties from Run.correct. The explorer replays the frozen evidence and deliberately forged cards. Python and TypeScript implementations independently check the same artifacts. MPC confidentiality depends on the executing committee; model identity remains runner-declared.

## solanaIntegration

Solana supplies PDA-bound bank/run/receipt accounts, output commitments, lamport escrow, permissionless resolution, and payouts. Two Anchor programs compose with Arcium’s MXE, computation definitions, queue, and verified callbacks. The capability registry is readable by another application without asking our server. x25519 and RescueCipher deliver questions to authorized viewers. The hosted explorer runs without a wallet using a frozen capture; a live RPC mode is available separately. The testnet programs exist, but the capture is localnet evidence and the latest Rust changes are not claimed as deployed. The TypeScript client uses @anchor-lang/core and @solana/web3.js.

## tractionMilestones

Engineering evidence, not customer traction: the merged localnet capture has 120 banks, 503 run accounts (406 finalized), 340 venues, 31 model records and 292 score receipts. Four local open-weights models exercised the scoring and settlement flow. A saved stale-artifact run claimed 64/64 locally and scored 1/64 in MPC; this is a controlled mismatch demonstration, not evidence of a dishonest provider. The calibration bank allows independent arithmetic rescoring. The evidence catalog has 216 entries plus its own index, and includes 57 tamper exhibits. We have no verified paying customers or independent production volume. Test results and deployment limits are recorded in docs/audit-2026-10-11.md.

## targetAudience

Start with an evaluation sponsor funding one measurable model capability: a competition organizer, evaluation organization or AI application team. The Proof Room defines a score/sample rule, filters post-reveal receipts, hides names for a blind review, explains evidence gaps and exports a complete policy certificate. The sponsor can attack that certificate and independently replay it. On-chain capability bounties are the separate payout rail. Demand remains unvalidated; the next commercial test is one useful sponsored evaluation.

## businessModel

The prototype implements two fee paths: a bank authority can charge a per-run lamport fee, and a market authority can set a bounded resolution fee. Amounts in the localnet capture are test activity, not sales. The initial business hypothesis is paid sponsored evaluations: charge for creating and operating private banks, with repeat run fees as sponsors compare candidates. A pilot should measure setup cost, time to a usable result, repeat evaluations and willingness to pay. We have not yet validated pricing, customer acquisition or real-money unit economics.

## competitiveLandscape

Private benchmarking is prior art: TRUCE describes confidential evaluation, and Gensyn Delphi has model-performance markets. Sealed does not claim to invent either. Its focused workflow makes an evaluation funding decision inspectable, including a no-qualifier refusal, complete record/receipt binding, generated decision forgeries and a separate payout proof. Solana supplies commitments and escrow; Arcium supplies confidential computation. The current arithmetic capture demonstrates protocol integrity, not validated customer utility or independently attested model identity.

## futureVision

Make an evaluation funding decision as inspectable as its payout. First validate one repeat sponsored evaluation on a useful machine-checkable task, measuring setup cost, time to a defensible decision, repeat usage and willingness to pay. Add independent runner attestation and richer confidential task families after that. The current product already exports both positive and negative policy decisions, flags exposed-answer evidence, explains when a new exam is needed and lets a sponsor test decision forgeries.

## teamBackground

Joseph is an 18-year-old AI/ML developer and second-year student based in Ilorin, Nigeria. He owns product direction and the submission. Devin and Codex provided substantial implementation and audit assistance. The public MIT repository contains two Anchor programs, six circuits and three replay implementations. Visible repository history begins September 15, 2026; work before the eligibility period is not inferred from that history.

## demoVideo

Public product: https://sealed-eval.netlify.app/ . Source: https://github.com/josepha-mayo/sealed . The authenticated form requires a separate pitch of at most two minutes and a live product demo of at most three minutes on YouTube, Loom or Vimeo. No explicit face requirement appeared. Video cuts show the exact-exam decision, a three-receipt refusal, decision-certificate forgery rejection and the captured bounty replay. Joseph records narration; public video links and final submission remain pending.
