# Pitch video script — ~2:30 (narrative, NOT a demo)

Colosseum requires TWO videos: this pitch (≤3 min — problem, insight,
traction, team, vision) and the technical demo (`video-script.md`,
2–3 min — architecture + commands). Judges usually watch the pitch
first; narrative beats production value. Face-to-camera or voiceover
over light product b-roll (explorer, `demo.sh` tail) — no slides
beyond one architecture card if needed.

| Time | Beat | Say (paraphrase, keep it human) |
|---|---|---|
| 0:00 | The lie | "Every AI leaderboard number you have ever read was produced by a party who could have made it up. Labs self-report. Benchmark answer keys leak into training data. And the prediction markets already trading on model scores settle against whichever leaderboard they trusted that week." |
| 0:15 | The insight | "We asked: what if the answer key simply didn't exist? Not hidden — nonexistent. We mint the benchmark INSIDE an MPC enclave. The questions come from enclave randomness; the answers are computed and fingerprinted in-circuit and born encrypted to the cluster key. There is no key to leak, sell, or subpoena — anywhere on Earth." |
| 0:35 | The inversion | "Every private-market project — Epoch, Flew, Bench — hides what users BET. Sealed hides the truth the market resolves ON. Insider knowledge isn't discouraged; it's cryptographically impossible." |
| 0:50 | What it is | "Sealed is a referee protocol on Solana + Arcium. Six circuits run inside MPC: banks minted in the enclave, private banks whose questions are ciphertext-only, selective disclosure that hands a judge the exam without publishing it, and scoring that writes only a count. A second program settles four parimutuel market types — binary, score bands, head-to-head duels, and K-way ladder races — permissionlessly off the MPC-written score." |
| 1:20 | Proof | "This isn't a deck. A real model — gpt-oss-20b — scored 64/64 through the full MPC pipeline on a bank whose answer key never existed; the on-chain count matched its local claim exactly. A stale artifact claiming 64/64 was honestly scored 1/64 — the chain never trusts self-reports. 61 finalized runs, 39 settled markets, 11/11 E2E on a real MPC localnet — every artifact and Merkle proof in the repo." |
| 1:45 | Who pays | "Three buyers today: prediction-market venues that need a neutral resolver; eval orgs and labs that need provable scores without publishing a contaminatable benchmark; judges and insurers who need the exam delegated without a key changing hands. Per-run fees and a settlement take-rate are live on-chain." |
| 2:05 | Why Solana | "Arcium MXEs coordinate on Solana — per-computation fees and 400ms finality are what make confidential market settlement economically viable at all. The programs are deployed on devnet today; the Arcium devnet cluster has a transient callback outage upstream — the full loop runs on localnet and lands on devnet the moment callbacks resume." |
| 2:20 | Vision + close | "Every future claim about what a model can do is addressable market surface. The resolution layer for AI capability — a number nobody can rig. Sealed: the exam nobody can leak, the score nobody can fake, the market that settles itself." |

## Recording notes

- Lead the demo-video link at the end of the pitch description.
- Keep one hard number on screen at 1:20 (64/64, run HW5H5bT7…).
- If using b-roll: explorer leaderboard (the two `openai` runs 64/64 vs
  1/64), the ciphertext-only private-bank card, `demo.sh` leaderboard tail.
- Team background: name yourself on camera — judges score founder-market fit.
