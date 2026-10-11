# World’s Fair builder review — 11 October 2026

Read through Joseph’s personal Brave session: Colosseum’s worlds-fair-hackathon, the-arena and show-and-tell channels. No posts, replies or DMs were sent. This is a focused product review, not a complete competitor census or independent security audit of other entries.

| Project | What I actually inspected | Lesson applied to Sealed |
|---|---|---|
| [CredaVer](https://www.credavernetwork.xyz/) | Public homepage and live-demo entry points: scoped mandates, six scenarios, verifiable receipts and explicit devnet/simulation labels. | Keep a specific buyer and action visible. Distinguish replay from transaction execution. |
| [Afterbell](https://afterbell-nine.vercel.app/try) | Rendered four-step test-money onboarding. The builder’s nine-settlement claim was read, not independently verified. | Give a judge a short route to the useful result without installation or wallet setup. |
| [Camalote](https://camalote.vercel.app/) | Rendered landing page, three-step setup, editable percentage calculator, visible fee/limits. No investment or wallet action performed. | Let the visitor change one decision variable and understand its effect. Sealed now has a clearly labeled score-target scenario. |
| [chaotic.markets](https://www.chaotic.markets/data) | Rendered token data table with reading timestamp, price comparison, purchase-size costs and explicit “No market”/missing values. Data providers and mainnet claims were not independently audited. | Make the verified score, required threshold and captured account state prominent. Keep uncertainty visible. |
| [Fianto](https://fianto.xyz/) | Rendered homepage: a specific subscription buyer, wallet-free sample checkout, displayed caps, security boundaries and “soon” labels. No sign-in/payment performed. | Put the business action before infrastructure details; separate claimed-account replay from original payment amount. |
| [PrivateDAO](https://github.com/x-pact-pro/PrivateDAO) | Current public README and Discord update. The README distinguishes historical devnet from current testnet, and capability-specific payment rails. Its claimed nine-chain E2E results were not reproduced. | Privacy alone is too broad a differentiator. Sealed should own one exact decision: whether a committed model run qualifies for a sponsor’s bounty. |

Other current show-and-tell posts read: Tnega, Ksha, Neon Memoir, Frenlock and Monolith. These posts are useful evidence of positioning, not proof of adoption or functional quality. A limited “benchmark” channel search mostly found earlier events; it does not establish Sealed’s uniqueness.

## Changes shipped from the review

- Sponsor → runner → contract path at the top of the explorer, after the historical score-mismatch case.
- One-click captured bounty replay using the existing account-binding verifier.
- A compact outcome: 20/32 winner score, 4/32 threshold, claimed state and zero remaining lamports, with detailed checks expandable.
- An interactive target scenario. Equal score qualifies for the score comparison; a higher requirement fails it. The scenario never modifies the historical bounty or authorizes a claim.
- Clear limits: localnet evidence, runner-declared identity, no fresh devnet MPC claim, no inferred original payout amount or customer traction.

## Why this is more tailored

The hackathon judges can inspect an actual failure, attempt an actual forgery and replay the contract’s qualification inputs. The product’s initial customer is an evaluation sponsor, and the first proposed commercial test is one useful, sponsored confidential evaluation. Sponsor demand, pricing and useful task families remain unvalidated; these are the next product experiments, not existing traction.

The broad AI-oracle framing is less memorable than “which score gets to move the money?” MPC protects the scoring path under its committee assumptions. It does not identify the model, make public arithmetic unsolvable, or prevent an authorized question viewer from deriving or leaking answers.


## Proof Room rebuild

The first pass applied these patterns too narrowly. The release now changes
the buyer's actual interaction: exact-exam requirements, missing-proof
explanations, a portable positive or negative decision, blind name display,
forgeries of that newly generated decision and a separate payout gate.
Five task tabs, mobile navigation, proof-kind/card selectors and paginated
ledger evidence replace the long default explorer. See proof-room.md for the
implemented scope, relevant prior art and the remaining commercial gaps.
