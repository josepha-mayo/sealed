# Slide deck outline — Colosseum Crypto World's Fair

Colosseum's guidance: concise slides, each title a takeaway (not a topic).
~10 slides, under 60 seconds of skimming. Drop each row into a slide;
the "evidence" column is what goes on-screen.

| # | Title (the takeaway) | On-screen |
|---|---|---|
| 1 | Every AI score you trust was made by a party who could fake it | 3 logos: lab self-report, leaked benchmark, leaderboard — each crossed out |
| 2 | Sealed deletes the trusted party — the answer key never exists | One-line architecture: items minted INSIDE Arcium MPC → answers born encrypted to the cluster key |
| 3 | The exam is ciphertext end-to-end | Explorer private-bank card: `PrivItemChunk` ciphertext blobs, `items_root` commitment, "questions never in plaintext" |
| 4 | Real models get real scores — verifiably | Leaderboard: gpt-oss-20b **64/64** MPC-minted bank (run `HW5H5bT7`); 32/32 grant-only exam (`9nfKSXnM`); stale artifact 64→**1/64** anti-cheat |
| 5 | Markets settle themselves off the MPC count | Market board: 5 settlement primitives (score bands, duels, ladder races, unseen-exam, dark commit-reveal) resolving on `Run.correct` — no oracle multisig |
| 6 | The wedge: the TRUTH is encrypted, not just the bet | Competitive grid — Pythia/Epoch/ArxPredict hide the *position*; Sealed hides the *resolution truth*; insider edge is cryptographically impossible |
| 7 | Confidential AI needs an onchain referee — now | Arcium × Inpher/Blackthorn confidential-inference narrative; Sealed is the settlement layer underneath it |
| 8 | Live business: fees + take-rate on-chain today | `create_run` fee_lamports + `fee_bps` skim; buyers: market venues, eval orgs, judges/insurers |
| 9 | Proven, not promised | Numbers strip: 61 finalized runs, 39 settled markets, 38 disclosure grants, 13/13 E2E, 6 Arcis circuits, devnet deployed |
| 10 | The resolution layer for AI capability | Roadmap: confidential stakes, quorum disclosure panels, TEE-attested runners, private banks-as-a-service; team line + repo/Pages QR |

## Regulatory posture (keep as a backup slide or appendix)

- Sealed markets resolve **verifiable events** (deterministic computation
  outputs), not opinions or off-chain votes — the closest analog is a
  parametric payout, not a securities bet.
- The protocol has **no custody engine**: positions are PDAs paying
  parimutuel pro-rata from a pool the program itself holds; there is no
  operator wallet in the payout path, no order book, no matching.
- The dark-market primitive hides *direction*, not *identity* — bettors
  are on-chain signers; this is game-theoretic privacy, not anonymity.
- Non-custodial + permissionless-exit (`expire`/`void` refund paths) are
  the structural mitigations; jurisdiction gating is a venue-layer choice
  for market operators composing on `Run.correct`.

## Competitive analysis (appendix or slide 6 expansion)

| Project | What they hide | What resolves the market | Sealed's edge |
|---|---|---|---|
| Pythia (Cypherpunk, Arcium) | positions | ordinary event outcomes | resolution truth is MPC-computed, not reported |
| Epoch / ArxPredict | bets/positions | external resolution | the event itself is confidential + self-settling |
| Melee / Bench / Flew | stake or side | external resolution | same — plus our truth never existed in plaintext |
| LMArena / Epoch AI | n/a (leaderboards) | trusted operator | the referee is infrastructure, not a vendor |
| CrunchDAO | submissions | coordinator holds answer key | no key exists to hold |
| TEE harnesses (Phala, CC) | execution | hardware vendor trust | MPC threshold trust, no single-vendor root |
