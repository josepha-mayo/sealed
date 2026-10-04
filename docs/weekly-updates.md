# Weekly update videos — 1 min each, posted to the project page

Colosseum staff confirm they watch these; most teams skip them, and silent
teams read as abandoned to track judges (Arcium staff judge the Solana
track). Phone-camera to-face or screen + voiceover. Post 1–2 before the
deadline.

## Update 1 — "the exam nobody can leak" (record now)

- "Built Sealed for Crypto World's Fair — a referee for AI scores where
  the answer key literally never exists."
- 15s: private bank card in the explorer — ciphertext where questions
  would be, `items_root` commitment over the ciphertext.
- 15s: `scripts/dark.sh` tail — a market that filled while positions AND
  the exam were both sealed, settled by MPC.
- 20s: numbers — 503 MPC-scored runs, 340 venues posted (208 band/duel +
  48 ladders + 47 dark + 37 bounties), 6 settlement primitives, 17/17 E2E
  on a real MPC localnet; a real qwen2.5-3b claimed a live SOL bounty via
  MPC proof; gpt-oss-20b scored 64/64 on a bank whose key never existed,
  and 32/32 on an exam it could only read through on-chain grants; the
  capability registry now keeps persistent per-model score records.
- Close: "Repo's public now — github.com/josepha-mayo/sealed — and the
  live explorer audits the whole ledger in your browser."

## Update 2 — "why confidential AI needs this" (post after repo is public)

- 20s: Arcium's confidential-AI push (Inpher acquisition, Blackthorn
  inference) — Sealed is the onchain eval layer that settles what
  confidential AI computes.
- 20s: the wedge vs prior Arcium-market hacks — Pythia/Epoch hide the
  position; Sealed hides the resolution truth.
- 20s: live evidence — devnet deployment + hosted explorer URL + the
  grant-only real-model run.
