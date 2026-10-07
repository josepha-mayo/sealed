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
- 15s: `chain stats` — one command recomputes the honesty story: all 31
  registry aggregates bit-exact from receipts, all 201 resolved-venue
  scores matching `Run.correct` (exit 1 on violation); `chain runs` is
  the 503-run substrate index; `chain items` regenerates a whole
  MPC-minted exam from raw chunks offline; and `docs/evidence/replay.txt`
  commits the captured transcript for judges who won't run anything.
- 15s: devnet status — **both** programs byte-verified MATCH against the
  committed build; the Arcium devnet callback outage is upstream and
  disclosed — the reproducible surface is the bundled localnet snapshot.
- Close: "Every feature this week is executable — a judge can run the
  audit, the gate, the board, and the rescore without installing
  anything."

## Update 4 — "the market has opinions" (post this week)

- 15s: `chain tour` — the project demos itself: seven stops through the
  live ledger (stats → a key resolved → a run's custody trail → its
  filtered feed → a venue's book → a bettor's P&L → what the money
  learned), exhibits picked live — nothing hardcoded.
- 15s: `chain market quote` + the in-page simulator — type a stake next
  to any open venue and get the program's own parimutuel math back:
  est payout, ROI, implied share. `chain market odds` is the sibling —
  the implied-probability board itself, what the books believe.
- 15s: `chain market sentiment` + `chain market champions` — two more
  lenses on the same models: stake-weighted belief pooled per model
  (duel tie books split half, bands imply expected score), and the
  settlement record (duel W-D-L, ladder leg wins counting dead-heat
  co-winners, bounty claims). `chain model <id>` fuses all four lenses
  — registry, evidence, settlement, belief, runs — into one dossier.
- 15s: `chain watch` — the live pulse: feed events as they land,
  dedup'd, oldest-first; snapshot mode makes it a replay ticker so the
  demo works without an RPC at all.
- Close: "Four ways to rank a model — receipts, paired evidence,
  settlement, belief — and none of them are a leaderboard's word."

## Update 5 — "the evidence is portable" (post this week)

- 15s: `chain artifact docs/evidence --recursive` — ONE command replays
  all 127 committed artifacts: 31 claim cards, 73 match cards, 3 policy
  certificates, 4 custody trails, 4 capability reports, the ledger
  digest, the leaderboard card, 3 exam cards (one per commitment
  regime — authored, generated, private), 2 bettor-position cards
  (a payable band stake + a sealed dark position), two bounty cards, two disclosure cards
  (a claimed pot + an open escrow), and the catalog
  itself. Every PDA
  re-derived, every verdict replayed, every settlement recomputed from
  `Run.correct`. Non-artifacts skipped, tamper fails at the exact check.
- 15s: the artifact families — `sealed-claim/v1` (a model's whole
  evidentiary record), `sealed-policy/v1` (a governance decision +
  the receipts behind it), `sealed-match/v1` (a portable head-to-head),
  `sealed-trail/v1` (proof the money followed the MPC score),
  `sealed-report/v1` (the printable dossier, hash-bound to its card),
  `sealed-evidence-digest/v1` (the whole ledger as one replayable
  document — snapshot-bound, every row field-compared), and
  `sealed-board/v1` (the leaderboard itself — ranking, receipts, and
  all 73 pairwise verdicts replayed from one card), and
  `sealed-bank/v1` (the exam itself — the items_root commitment
  re-folded from pinned chunk bytes; the private bank's commitment
  verifies from ciphertext alone, no key needed), and
  `sealed-position/v1` (the bettor's receipt — stake and settlement
  proven from the position PDA, dark venues carry a fourth
  bettor-chosen salt seed), and `sealed-bounty/v1` (the sponsor's
  certificate — the `bounty_qualifies` gate replayed leg by leg over
  the winner run: same bank, postdates, runner≠sponsor,
  score≥threshold, finalized-or-proven, !post_reveal), and
  `sealed-grant/v1` (the viewer's certificate — five-seed PDA over an
  x25519 viewer key, `encryption_key == viewer` echo, and the panel
  tally re-derived: the questions moved, the answers never did).
- 15s: `chain fingerprint` — the entire evidence base as ONE sha256:
  324 manifest-pinned files re-hashed, then `BUNDLE ROOT`. The
  explorer's "replay the whole bundle" button drives all 127 artifacts
  through the in-page verifiers and ends on the SAME root — terminal
  and browser agree, or the bundle is dirty.
- 15s: `?tour=1` — the hosted explorer demos itself: a captioned
  auto-walk through twenty-two sections, ending on the forgery lab —
  "try to break it": twelve canned attacks (forge a score, swap a rank,
  un-vouch a receipt, flip a verdict, mint a phantom receipt, inflate
  a pool, re-age the ledger, plant a phantom run on an exam, erase an
  artifact from the index itself, inflate a winning bettor's stake,
  steal the bounty pot, redirect a disclosure)
  each die at a named check in-browser —
  and `?forge=<attack>` makes any of them a shareable link that runs
  the attack on open.
- 10s: the table of contents is evidence too — `artifacts.json` is a
  `sealed-catalog/v1` card; `chain catalog --check` proves the index
  lists EVERY artifact (completeness vs a fresh scan + sha256 pinning),
  so the 124-card set can't be silently edited down.
- Close: "Other submissions ask you to trust a folder of screenshots.
  Ours ends in a sha256 — timestamped on Solana itself."
