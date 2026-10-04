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
- 20s: numbers — 503 runs on the evidence ledger (most MPC-finalized), 340 venues posted (208 band/duel +
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

## Update 3 — "no operator needed" (post this week)

- 15s: `chain market board` on the live explorer — the keeper board
  rendered in-page over the bundled ledger: 36 actionable venues flagged
  (resolvable markets, a tallyable dark, expired bounties worth ~0.25 SOL
  back to sponsors) — the classification mirrors the on-chain
  `still_moving`/`proven`/`bounty_qualifies` gates exactly.
- 15s: `chain market sweep` — one command executes every permissionless
  action the board lists (claims pay the winning run's *operator*, never
  the sweeper); `chain market positions` — the bettor-side mirror with
  estimated payouts and prefilled claim commands.
- 15s: `chain gate --min-pct 60 --vouched --wilson` — a capability policy
  over the registry receipts, exit 0/1/2 — composability you can paste
  into a CI job or a venue admission check; same verdict in the explorer.
- 15s: `--snapshot web/snapshot.json` on every read command — `board`,
  `gate`, `history`, `compare`, `trail`, `records`, `banks`, `status`, `verify`, `grants`, `reveals`, `positions` all replay the committed
  evidence bundle keyless, no RPC. CLI = explorer parity, proven by a
  unit test that pins the 36-actionable classification. And `gate --all`
  applies a policy to every record — "which models provably clear
  pct≥70 + min-runs 2" is a ranked table, not a claim (8/31 on the
  bundled ledger).
- 15s: devnet status — **both** programs byte-verified MATCH against the
  committed build; the Arcium devnet callback outage is upstream and
  disclosed — the reproducible surface is the bundled localnet snapshot.
- Close: "Every feature this week is executable — a judge can run the
  audit, the gate, the board, and the rescore without installing
  anything."
