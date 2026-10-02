# Slide deck outline — Colosseum Crypto World's Fair

Colosseum's guidance: concise slides, each title a takeaway (not a topic).
~10 slides, under 60 seconds of skimming. Drop each row into a slide;
the "evidence" column is what goes on-screen.

| # | Title (the takeaway) | On-screen |
|---|---|---|
| 1 | Every AI score you trust was made by a party who could fake it | 3 logos: lab self-report, leaked benchmark, leaderboard — each crossed out |
| 2 | Sealed deletes the trusted party — the answer key never exists | One-line architecture: items minted INSIDE Arcium MPC → answers born encrypted to the cluster key |
| 3 | The exam is ciphertext end-to-end | Explorer private-bank card: `PrivItemChunk` ciphertext blobs, `items_root` commitment, "questions never in plaintext" |
| 4 | Real models get real scores — verifiably | Leaderboard screenshot: FOUR open-weights models raced one MPC-minted exam — `qwen2.5-3b` **6/32** tied `qwen2.5-1.5b` **6/32**, `llama-3.2-1b` 1/32, `qwen2.5-0.5b` 0/32 — every digit written by the cluster, zero external API; stale-artifact claim scored **1/64** anti-cheat (`3CKnMa8X`) |
| 5 | Markets settle themselves off the MPC count | Ladder `A4fMA7eK`: dead-heat `result_mask=0b11` paid both co-leaders; dark market on a ciphertext-only private bank resolved blind (`7TVjSaFD`) — exam sealed + positions sealed + MPC score; private-bank duel between two grant-delegates. 6 primitives (incl. capability bounties — pot pays the winning run.s operator, not a bettor), all settling real-model scores |
| 6 | The wedge: the TRUTH is encrypted, not just the bet | Competitive grid — Pythia/Epoch/ArxPredict hide the *position*; Sealed hides the *resolution truth*; insider edge is cryptographically impossible |
| 7 | Confidential AI needs an onchain referee — now | Arcium × Inpher/Blackthorn confidential-inference narrative; Sealed is the settlement layer underneath it |
| 8 | Live business: fees + take-rate on-chain today | `create_run` fee_lamports + `fee_bps` skim; buyers: market venues, eval orgs, judges/insurers. Unit economics: a 64-item exam ≈0.02 SOL total rent; a bettor seat ≈0.002 SOL (refunded on claim/close) |
| 9 | Proven, not promised | Numbers strip: 153 runs on the merged evidence ledger (4 localnet epochs), 118 markets + bounties across 6 primitives (73 band/duel · 15 ladder · 17 dark · 13 bounty), 60 disclosure grants, 16/16 E2E + 13/13 unit + 11/11 market Rust tests, 6 Arcis circuits, offline + in-browser audit 11/11 & 10/10, CI green on every push, devnet deployed |
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
