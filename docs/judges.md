# Judge's path — evaluating Sealed at your chosen depth

Every claim below is verifiable. Nothing here requires trusting us.

## The one-line pitch

A benchmark whose items are **minted inside an MPC cluster** — questions drawn
from the cluster’s RNG, answers computed and fingerprinted in-circuit — so
**no answer key exists anywhere on Earth**, and (in the private variant) **the
questions never exist in plaintext on-chain either**. Models are scored inside
the cluster; only the count leaves it — and markets settle on that count directly. No referee, no oracle operator.

## Rubric → evidence

| Official criterion | What to look at | Where |
|---|---|---|
| **Novelty** | The eval-honesty problem is that every trusted party in the loop can leak or rig. Sealed removes the trusted *data* party entirely: the questions are born in MPC, the answers never leave it, and disclosure is selective and recorded. | `docs/pitch.md`, README "Why" table |
| **Functionality — does it work?** | `yarn test` — 17/17 mocha E2E on a real MPC localnet (seal, score, score-band + duel + ladder + dark markets, capability bounties, generated banks, private banks, reshare delegation, delegated-runner scoring). `yarn harness:test` — 69/69 unit. Plus the whole evidence bundle replays offline (below). | `tests/sealed.ts`, `packages/harness/test/harness.test.ts` |
| **UX** | The explorer is the product's front door: `?mega=1` self-audits in ~8s ending on a copyable verdict, the forgery lab lets a skeptic run the attack in-page, `?card=` deep links re-verify any artifact, and the whole thing ships as a single offline `standalone.html`. Zero wallet, zero RPC, zero setup. | `web/index.html`, hosted `?mega=1` |
| **Product / execution** | Six Arcis circuits (reviewed line-by-line in docs/circuits.md) + two Anchor programs + TS harness + web explorer, all live: `seal_part`, `score_chunk`, `gen_part`, `gen_part_private`, `reveal_part`, `reshare_part`. | `encrypted-ixs/src/lib.rs`, `programs/sealed/src/lib.rs` |
| **Real model evidence** | **Every market primitive has settled a real open-weights model's MPC-written score** — four models raced one MPC-minted exam ending in a dead-heat that paid both co-leader backers; duels, dark markets, and a real bounty claim all detailed below. | snapshot + `docs/evidence/*-local.txt` |

| **Open-source / composability** | MIT-licensed, and the output is a credibly-neutral public good (the on-chain capability registry any venue can compose on — Public Goods Award territory): `Run.correct`, `ScoreLog`, and the `ModelRecord` registry are permissionless read surfaces — no CPI, no vendor key. `docs/integrate.md` gives the byte-accurate consumer guide (owner+discriminator gate, `post_reveal` tail-read, PDA seeds, honesty-flag semantics); the bundled `market` program IS the reference third-party consumer — it never sees items or ciphertext, only `Run.correct`. And `chain gate --min-pct 60 --vouched` is composability made executable: a capability policy over the registry, exit 0/1/2, pure `evalGate` so the same verdict replays off the committed snapshot — `--all` turns it into the registry filtered by policy, ranked. | `docs/integrate.md`, `programs/market/src/lib.rs` (`load_run`), `packages/harness/src/gate.ts` |
| **Why crypto is load-bearing** | Solana = the commitment layer (roots, PDAs, market settlement). Arcium MPC = the only reason data can be on-chain yet unreadable. Without either, this is a database + a promise. | `docs/threat-model.md`, `docs/arcium.md` (primitive-by-primitive map — and why not ZK/TEE/hashes) |
| **Privacy depth** | Three disclosure levels, all proven: public specs (generated), delegate-only specs (`reshare_part` → `ShareGrant` PDAs — one-directional, grant trail on-chain), sealed answers (MXE-only, fingerprints declassifiable via `reveal_part`). | `docs/threat-model.md` tables |
| **Business plan / viability** | Per-run fees to the benchmark authority are live (`create_run` transfers `fee_lamports`); market take-rate is live too (`fee_bps` at resolution, `claim_fee`). Six novel settlement primitives ship here: **run duels** (head-to-head "does A outscore B", bets latch on either leg's first scoring queue, `RunnersMustDiffer` anti-sybil), **ladder races** (K-way argmax over 3–8 bound runs — dead-heat pro-rata ties, legs that land nothing forfeit at 0 while landed partials count, any-leg betting latch), **unseen-exam markets** (a market opens and fills on a private-bank run — the event being priced is itself confidential: specs are ciphertext-only before, during, and after settlement, `scripts/unseen.sh`), **dark commit-reveal markets** (a bettor's side is a `sha256` commitment — sealed until they choose to reveal; no-show winners forfeit into the pot, zero-reveals cancel to gross refunds, `scripts/dark.sh`), **capability bounties** (a sponsor escrows SOL against "first proven run ≥ threshold" — the pot pays the winning run's *operator*, not a bettor; permissionless claim, `runner ≠ sponsor` anti-self-deal, `scripts/bounty-local.sh`), and **committed-settle expiry** (`all_queued_at` + 24h landing window — a stalled run refunds only if the runner never committed every chunk; no transaction can both commit and expire). Any venue resolves permissionlessly off `Run.correct` — the referee is infrastructure, not a vendor. And `chain market board`/`sweep` makes no-operator liveness executable: a read-only scan lists claimable bounties, resolvable venues, tallyable darks and sweepable expiries — `sweep` executes every permissionless action it finds (bounty pots still pay the winning run's *operator*, never the sweeper), and the explorer renders the same classification in-page over the bundled ledger (36 actionable venues flagged). | `programs/market`, `docs/submission.md`, `packages/harness/src/board.ts` |
| **Honesty / craft** | `docs/engineering-log.md` is the adversarial-review receipt trail — the JIT-commit freeze-win, dormant-runner free exit, post-reveal stuffing, stale-artifact 1/64, claim-fee solvency ordering, leg reordering — each found in our own review, each with a regression test. The devnet note is recorded truthfully: the shared Arcium devnet cluster finalizes computations but is withholding callback txs during an outage. Both hardened builds ARE deployed — `scripts/verify-deployed.sh` dumps each on-chain ELF and shows sha256-match against this repo's `target/deploy/*.so` (MATCH ×2). Every localnet flow is reproducible meanwhile. | `docs/submission.md` "Devnet note" |

**The flagship ledger, in bullets** (all live in the bundled snapshot — every PDA re-derives, every score replays):

- **Four real open-weights models, one MPC-minted exam, zero external API**: `qwen2.5-3b` 6/32, `qwen2.5-1.5b` **6/32 (a real dead-heat)**, `llama-3.2-1b` 1/32, `qwen2.5-0.5b` 0/32. Ladder `A4fMA7eK…` filled while all legs were *pending*, argmax resolved `result_mask=0b11` paying both co-leader backers pro-rata, plus a dark commit-reveal market on leg 0's run with sealed positions and a live forfeit (`scripts/ladder-local.sh`, `ladder-local.txt`).
- **Duels**: `qwen2.5-1.5b` 3/32 vs `qwen2.5-0.5b` 1/32 — market `7p32UT6s…` (`duel-local.txt`).
- **Unseen exam**: the 1.5b scored **8/32 on a private bank** read only through `reshare_part` grants (`7S9ZmxrT…`, `unseen-local.txt`).
- **Double-sealed**: private bank `8HHm4HgA…` (specs ciphertext-only) hosted a dark market `7TVjSaFD…` on the 3b's pending run — exam sealed + positions sealed + MPC score — resolved `>=5` on 5/32 with a sealed forfeit; a full-book score-band `497kuApd…` resolved `1–7` on the 0.5b's 2/32; a live `all_backed` cancel `H3RGMd3N…` refunded gross (`dark-local.txt`, `band-local*.txt`).
- **A real bounty claim**: sponsor escrowed **0.1 SOL against "first proven run ≥ 6/32"** — an independent runner keypair ran qwen2.5-3b for real (local pre-score 7/32, MPC-agreed 7/32) and the permissionless claim paid the operator, while the 1.5b's honest 2/32 sat below threshold on the same bank (`real-bounty.txt`). A second real-model band resolved bucket-0 on llama-3.2-1b's MPC-confirmed **0/32** — the exam flunking a model is evidence too.
- **The anti-cheat boundary**: gpt-oss-20b runs — 64/64 on MPC-minted bank 6932 (`HW5H5bT7…`), 64/64 on authored 25864 (`4uns99WD…`), and a stale-artifact claim scored **1/64** (`3CKnMa8X…`), plus 32/32 on grant-only private material — the chain doesn't care what your artifact claims.

## Reproduction & deep-dive — pick your depth

**Genuinely three steps, no repo needed:**

1. Open [the hosted explorer's `?mega=1`](https://josepha-mayo.github.io/sealed/?mega=1) — the whole audit runs itself in ~8s.
2. `curl -sL https://raw.githubusercontent.com/josepha-mayo/sealed/main/scripts/verify.py | python3 - --remote` — re-verify all 359 pinned bytes from one stdlib file.
3. Read the verdict — if you want the full localnet rebuild, continue below.

**Cloned the repo instead?** The two load-bearing commands are
`yarn --cwd packages/harness cli chain artifact ../../docs/evidence --recursive --snapshot ../../web/snapshot.json`
(all 142 artifacts replayed keyless — step 3p) and
`python3 scripts/verify.py --all`
(every third-language proof in one shot — step 3u).

---

**Full localnet reproduction** (the steps below are the deep-dive —
lettered a–v, expect ~40 minutes plus toolchain setup).

Prereqs: Solana CLI, Docker (runs the Arcium MPC nodes locally), Anchor + the arcium toolchain
(`scripts/setup-wsl.sh` provisions all of it), and a wallet:
`solana-keygen new --no-bip39-passphrase -s -o ~/.config/solana/id.json`
(add `--force` if the file exists). Fund it AFTER the localnet is running:
`solana airdrop 5 "$(solana address)" --url http://127.0.0.1:8899`.
Then `yarn install && arcium build && anchor build -p market --ignore-keys`
once — `arcium build` compiles circuits + the sealed program/IDL; the market
program builds separately (its declared ID intentionally differs from any
generated keypair — `--ignore-keys` keeps it; do NOT run `anchor keys sync`).

```bash
# 0. chain env (localnet cluster offset — both vars are required)
export SEALED_CLUSTER_OFFSET=0 ARCIUM_CLUSTER_OFFSET=0 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899

# 1. see the whole thing work on localnet (MPC mint -> private bank -> delegate
#    -> model -> score -> markets)
arcium localnet &              # first bootstrap; if it times out on backup
                               # nodes, re-run it or use scripts/localnet-up.sh
scripts/demo.sh                 # full arc: mint → disclose → 3 runners → 4 market types → settle
scripts/ladder8.sh              # optional: maximum-width 8-leg race (the full result-mask path)
scripts/unseen.sh               # optional: a market on an exam that is never published (private-bank run)
# real-model flagships (need local llama.cpp endpoints — scripts/serve-local.sh):
scripts/duel-local.sh           # two real models duel on an MPC-minted exam
scripts/ladder-local.sh         # four real models race + dark leg (dead-heat fired naturally)
scripts/dark-local.sh           # double-sealed: dark market on a private exam's real-model run
scripts/duel-private.sh <bench> # blind duel: two grant-delegates race models on a ciphertext-only bank
scripts/bounty-local.sh         # capability bounty: sponsor escrows SOL, first MPC-proven run >= threshold pays its operator (no bettors); bait rejections + expiry refund included
scripts/unbrick-demo.sh         # grief dust → permissionless reclaim → init lands on the same PDA (docs/evidence/unbrick-demo.txt)

# 2. eyeball the chain state — ciphertext-only private chunks, grant trail,
#    minted specs, scores, resolved markets
#   HOSTED (zero setup): https://josepha-mayo.github.io/sealed/
#   ONE LINK, EVERY PROOF: https://josepha-mayo.github.io/sealed/?mega=1 —
#   opens the page and runs the whole skeptic's suite while you watch:
#   account audit → all 142 artifacts through their verifiers → every
#   forgery attack in the lab → the sealed exam decrypting in-browser,
#   landing "EVERYTHING VERIFIED" in ~8s — with a copyable verdict block
#   (counts, bundle root, anchor state) you can paste straight into
#   review notes.
#   GUIDED: https://josepha-mayo.github.io/sealed/?tour=1 — the explorer
#   demos itself: an auto-walk through all twenty-four stops with one-line
#   captions (the in-page mirror of `chain tour`; "▶ tour" in the nav too).
#   TERMINAL: bash scripts/judge-demo.sh — the 90-second keyless audit
#   (verify.py → all 142 artifacts → forgery lab → tamper exhibits →
#   fingerprint). docs/audit.gif is a real recording of it.
#   On the hosted page, in order — the audit panel auto-runs (expect
#   "13 pass · 0 fail" — the page adds a calibration rescore as its
#   13th check), then scroll: the public calibration specimen (a real
#   32-item exam rendered row-by-row), the capability registry, all 503
#   runs (filter: post-reveal only → 29 rows), the disclosure trail,
#   the flagship races (ladder A4fMA7eK… mask=0b11 dead-heat, dark
#   market on leg 0), and the nav search box that resolves ANY pubkey
#   to its dossier card (?pk=<key> shares it).
python3 -m http.server -d . 8788
#   → http://localhost:8788/web/?rpc=http://127.0.0.1:8899
#   offline (no localnet): http://localhost:8788/web/?snapshot=/docs/evidence/snapshot.json

# note: --run means an artifact FILE for run/score/prove, but a run PDA
# for attest/record/reset-pending/market open (verify-proof.mjs also takes --run-pda)

# 3. verify the suites yourself
yarn test                      # 17/17 E2E
yarn harness:test              # 69/69 unit

# 3a. or don't pick: `bash scripts/verify-all.sh` runs the whole offline
#     audit — the crypto checks below, the headless in-page audit, the
#     third-language replay + forgery lab + decrypt + rescore, both
#     manifests, submission preflight — ending on the one BUNDLE ROOT
#     sha256. (The suites above need a running localnet; everything in
#     verify-all replays the committed bundle, no chain required.)

# 3b. cryptographic audit of the evidence bundle — fully offline:
#     re-derives every account's PDA, replays items_root commitment folds
#     bit-exact, re-checks that every market resolution is a pure function
#     of the MPC-scored run, and re-verifies the Merkle proofs.
#     The same suite also runs IN-BROWSER on the hosted explorer — the
#     "cryptographic audit" panel auto-executes against the loaded snapshot.
node scripts/verify.mjs        # 12 PASS / 0 FAIL on the committed snapshot

# 3c. prove the deployed bytes ARE this repo (not just "trust the deploy"):
#     dumps each program's on-chain ELF and sha256-compares it against
#     target/deploy/*.so — BOTH programs MATCH the committed build
#     (sealed 2026-10-03, market 2026-10-04).
scripts/verify-deployed.sh     # MATCH per program only when bytes match

# 3d. THE calibration check — recompute the MPC's arithmetic yourself.
#     The calibration bank's plaintext answers ship in the repo (public on
#     purpose). rescore.mjs recomputes every fingerprint from plaintext,
#     checks them against the on-chain Reveal accounts, re-binds the run
#     artifact to Run.outputs_root, and recounts the score — the result is
#     bit-identical to what the MPC wrote (7/32). Zero trust required.
node scripts/rescore.mjs --bank docs/evidence/calibration/bank.json \
  --run docs/evidence/calibration/run-artifact.json \
  --benchmark CSnhf6QySv3BszDkJ47KGooUx86PBpLxxi2iDz42S8fp \
  --run-pubkey GnrRt5GUu6pUQXi7gyXLn7mXMbhXDdneiXbaV6LFFHvi \
  --snapshot ../../web/snapshot.json      # 7 PASS / 0 FAIL — no RPC needed

# 3e. replay the CLI's own read surfaces off the committed bundle —
#     keyless, connection-free: the same commands judges would run
#     against an RPC answer from the snapshot alone (snapshot.ts decodes
#     through the same discriminator-keyed layouts). 36 actionable
#     venues, 31 model records, a gate verdict — all offline.
#     docs/evidence/replay.txt is a captured transcript of exactly this.
yarn --cwd packages/harness cli chain tour --snapshot ../../web/snapshot.json
#     ↑ ONE command, seven stops: stats → search → a run's custody trail →
#       its filtered feed → a venue's book → an actor's P&L → what the
#       stakes believe — and the top divergences where money disagrees
#       with receipts. Objects picked live (the most-venue'd run, the
#       biggest book), nothing hardcoded. Read nothing else, read this.
yarn --cwd packages/harness cli chain stats --snapshot ../../web/snapshot.json   # dashboard: 31/31 records + 201/201 resolutions re-verified
yarn --cwd packages/harness cli chain banks --snapshot ../../web/snapshot.json   # index → pick a benchmark pk
yarn --cwd packages/harness cli chain market board --snapshot ../../web/snapshot.json
yarn --cwd packages/harness cli chain gate dark/model-a --min-pct 80 --min-runs 5 --snapshot ../../web/snapshot.json
yarn --cwd packages/harness cli chain gate --sweep --snapshot ../../web/snapshot.json
#     ↑ the policy-sensitivity grid: every record re-evaluated across
#       10–90% — each model's "frontier" is the strictest line it
#       survives. gate --all says who clears THIS line; the sweep says
#       who is robustly good (no single threshold can be gamed)
yarn --cwd packages/harness cli chain gate qwen2.5-3b-instruct --why --snapshot ../../web/snapshot.json
#     ↑ the policy autopsy — survivable ceiling per evidence scope, and
#       the binding constraint named. The explorer's gate panel runs the
#       same autopsy via its "why" button.
yarn --cwd packages/harness cli chain records --snapshot ../../web/snapshot.json
#     the dossier set — `chain search <pk>` resolves ANY key to its
#       dossier, or pick directly:
#       chain bank <pk|name> · chain wallet <pk> · chain trail <run-pk> ·
#       chain market venue <pk> · chain market position <pk>
#       (subject / actor / run / instrument / stake — every axis, keyless)
#     simulation + pulse — the last two surfaces aren't reads at all:
#       chain market quote <venue> --outcome <i> --lamports <n>
#         → the program's own parimutuel math run locally: est payout,
#           ROI, pool-implied share — before a transaction exists
#       chain watch --snapshot ../../web/snapshot.json
#         → the ledger's ticker: the bundle's latest events, then a live
#           poll (drop --snapshot on a healthy RPC for the real pulse)
yarn --cwd packages/harness cli chain items --benchmark 2cwT4xY7e6UDFePX7tB5PoiihJDfFT2kEqefayVtMVxZ \
  --snapshot ../../web/snapshot.json --out /tmp/gen-bank.json
#     ↑ regenerates an entire MPC-minted exam offline — item specs decoded
#       from raw ItemChunk bytes, items_root fold re-verified

# 3f. the bundle is REPRODUCIBLE — don't take the committed snapshot on
#     faith: re-dump the live devnet ledger yourself (no wallet needed,
#     getProgramAccounts is permissionless) and digest both. Counts,
#     per-record replay verdicts, and per-venue Run.correct checks
#     should match (the devnet ledger has grown since the bundle was
#     cut, so a fresh dump may be a superset — every committed account
#     still re-derives inside it).
node scripts/snapshot.mjs --rpc https://api.devnet.solana.com --out /tmp/fresh.json
yarn --cwd packages/harness cli chain diff ../../web/snapshot.json /tmp/fresh.json
#     ↑ one command: per-type account deltas (added/removed/mutated),
#       both bundles' sha256 + integrity verdicts side by side
#     ↑ or skip the CLI: the explorer's "diff…" button (top toolbar)
#       takes any dumped bundle and shows the same added/removed/mutated
#       table in-page against whatever's loaded

# 3g. THE DELIVERABLE — a portable claim card. Prove mints a
#     self-contained sealed-claim/v1 bundle for one model; verify
#     re-checks it with NOTHING but the program IDs — every account's
#     PDA re-derives from its seeds (identity is cryptographic, not
#     claimed), the record replays bit-exact, every venue resolution
#     re-derives from Run.correct. Tamper with one field and it fails
#     exactly there. This is what a model provider hands a customer.
yarn --cwd packages/harness cli chain prove qwen2.5-3b-instruct --snapshot ../../web/snapshot.json --out /tmp/claim.json
yarn --cwd packages/harness cli chain prove --verify /tmp/claim.json
#     ↑ or verify the card we already committed — or ALL of them at once.
#       docs/evidence/claims/ ships one card per registry record (31):
yarn --cwd packages/harness cli chain prove --verify ../../docs/evidence/claims
#         → ALL CARDS VERIFIED — 31 cards, 9 checks each: a REAL
#           open-weights model's claim (qwen2.5-3b: 23/96 across 3
#           MPC-scored runs) plus every test/mock/duel/ladder record —
#           every address re-derives, every verdict replays
#         → or verify ANY of them IN THE EXPLORER: open the hosted page,
#           scroll to "verify a claim card", pick from the 31-card dropdown
#           (each sha256-pinned in the bundle MANIFEST), verify — the same
#           10 checks run in-page (PDA checks need the vendored web3.js bundle)

# 3h. THE GOVERNANCE ARTIFACT — a policy certificate. Claim cards prove a
#     model; a sealed-policy/v1 certificate proves a DECISION: the policy
#     plus every record's verdict AND the receipt evidence each verdict
#     was computed from. A DAO proposal, an insurer's memo, an admission
#     decision — replayable keyless, tamper fails at verdict replay.
yarn --cwd packages/harness cli chain gate --certify-verify ../../docs/evidence/policies/min60-3runs.json
#         → CERT VERIFIED — 31 records, PDAs re-derived, every verdict
#           recomputed bit-exact from embedded receipts
yarn --cwd packages/harness cli chain gate --all --min-pct 60 --min-runs 3 --cert /tmp/mypolicy.json --snapshot ../../web/snapshot.json
#         → same replay in the explorer: scroll to "verify a policy
#           certificate", load min60-3runs — 3 checks run in-page

# 3i. THE PRINTABLE DELIVERABLE — a capability report. `chain report` fuses
#     the dossier + claim card into sealed-report/v1 markdown with a stable
#     canonical card hash you can re-mint and compare. A committed example:
cat docs/evidence/reports/qwen2.5-3b-instruct.md
yarn --cwd packages/harness cli chain report qwen2.5-3b-instruct --snapshot ../../web/snapshot.json
#     and the binding is checkable, not just readable:
yarn --cwd packages/harness cli chain report --verify ../../docs/evidence/reports/qwen2.5-3b-instruct.md --snapshot ../../web/snapshot.json
#         → REPORT VERIFIED — record PDA re-derives, the printed
#           canonical sha256 equals the re-minted card's digest, and the
#           bound card itself replays (9 claim checks)

# 3j. THE HEAD-TO-HEAD ARTIFACT — a sealed-match/v1 card makes a
#     paired-evidence verdict portable: every pair of records sharing
#     ≥1 exam's receipts ships as a committed card (73 of them — the
#     whole pairwise ledger), each replayable offline.
yarn --cwd packages/harness cli chain compare --match-verify ../../docs/evidence/matches/qwen2.5-3b-instruct-vs-qwen2.5-1.5b-instruct.json
#         → MATCH VERIFIED — both record PDAs, all bank/run/receipt
#           PDAs re-derived, 2-0-0 bank wins and the pooled verdict
#           recomputed from the embedded receipts
yarn --cwd packages/harness cli chain compare --match-verify ../../docs/evidence/matches
#         → ALL MATCHES VERIFIED — 73 cards batch-replayed, exit 1 on
#           any violation (index.json skipped)
#         → same replay in the explorer: scroll to "verify a match
#           card", pick from the 73-card dropdown — 10 checks in-page

# 3k. THE MONEY TRAIL — a sealed-trail/v1 card binds one run's whole
#     lifecycle: bank commitment → MPC score → receipt → every venue
#     that priced it. Verification proves the money followed the
#     MPC-written score, not a client's say-so. Four committed cards
#     cover every venue kind — the flagship: qwen2.5-3b's 6/32 that
#     settled a dark market AND won a 4-model ladder dead-heat.
yarn --cwd packages/harness cli chain trail --verify ../../docs/evidence/trails --snapshot ../../web/snapshot.json
#         → ALL TRAILS VERIFIED — run/bank/receipt/venue PDAs
#           re-derived, every card FIELD bound to decoded account
#           bytes (run score, escrow amounts, leg runs, forfeit sums),
#           settlements replayed vs the decoded Run.correct, ladder
#           argmax mask + pool accounting recomputed

# 3l. THE EXAM CARD — a sealed-bank/v1 card binds one benchmark's whole
#     footprint: bank/chunk/run/reveal/grant PDAs re-derive, and the
#     items_root commitment RE-FOLDS from the pinned chunk bytes in
#     mint_order landing order. Three committed cards — one per
#     commitment regime. The private one is the sharp proof: the
#     commitment verifies from ciphertext+nonce alone — no key needed.
yarn --cwd packages/harness cli chain bank --verify ../../docs/evidence/banks \
  --snapshot ../../web/snapshot.json
#         → ALL VERIFIED — 3 bank card(s): authored (merkle commitment),
#           generated (spec fold), private (ciphertext fold)
#         → same replay in the explorer at "verify an exam card"

# 3m. THE BETTOR'S RECEIPT — sealed-position/v1 proves a stake and its
#     settlement without trusting the book: the position PDA re-derives
#     ([position, venue, bettor] — dark venues add a bettor-chosen
#     pos_salt as a fourth seed), stake binds to the decoded account,
#     and the payout/live verdict replays from Run.correct.
yarn --cwd packages/harness cli chain market position --verify \
  ../../docs/evidence/positions/winning-band.json --snapshot ../../web/snapshot.json
yarn --cwd packages/harness cli chain market position --verify \
  ../../docs/evidence/positions/sealed-dark.json --snapshot ../../web/snapshot.json
#         → POSITION VERIFIED — payable 0.10 SOL card + sealed dark card
#         → same replay in the explorer at "verify a bettor card"

# 3n. THE SPONSOR'S CERTIFICATE — sealed-bounty/v1 proves a pot and its
#     payout without trusting the keeper: the bounty PDA re-derives
#     ([bounty, bank, sponsor, salt]), every account field binds to the
#     decoded Bounty, and a claimed card replays the on-chain
#     bounty_qualifies gate leg by leg — same bank, postdates,
#     runner≠sponsor, score≥threshold, score==winningScore,
#     finalized-or-proven, !post_reveal. The open card proves the
#     escrow is still there waiting for a qualifying run.
yarn --cwd packages/harness cli chain market bounty card --verify \
  ../../docs/evidence/bounties/claimed-20of32.json --snapshot ../../web/snapshot.json
yarn --cwd packages/harness cli chain market bounty card --verify \
  ../../docs/evidence/bounties/open-sealed-test.json --snapshot ../../web/snapshot.json
#         → BOUNTY VERIFIED — claimed (pot paid to runner, 20/32 beat
#           threshold 4) + open (0.2 SOL still escrowed)
#         → same replay in the explorer at "verify a bounty card";
#           the forgery lab's "steal the bounty" attack dies at
#           account binding

# 3o. THE VIEWER'S CERTIFICATE — sealed-grant/v1 proves questions moved
#     without publishing them: the grant PDA re-derives from five seeds
#     ([grant, bank, chunk, part, viewer] — the viewer seed is raw
#     x25519 bytes, not a wallet), the encryption_key echo proves the
#     MPC re-encrypted to the key it was asked for, and the panel
#     tally — who else was shown the exam — re-derives from the
#     snapshot. The answers never moved.
yarn --cwd packages/harness cli chain grant --verify \
  ../../docs/evidence/grants/sealed-priv-panel.json --snapshot ../../web/snapshot.json
#         → GRANT VERIFIED — sealed-priv part 3 → viewer … ·
#           2 viewer(s) saw this exam · the answers never moved
#         → same replay in the explorer at "verify a disclosure card";
#           "redirect a disclosure" in the forgery lab dies at grant PDA

# 3p. THE ONE COMMAND — `chain artifact` is the universal verifier:
#     point it at the WHOLE evidence tree and it replays every
#     artifact in one pass — kind auto-detected, non-artifacts
#     skipped. A judge never needs to know which flag goes with
#     which artifact.
yarn --cwd packages/harness cli chain artifact ../../docs/evidence --recursive \
  --snapshot ../../web/snapshot.json
#         → ALL ARTIFACTS VERIFIED — 138 replayed, 28 skipped ·
#           31× claim, 73× match, 3× policy, 4× report, 4× trail,
#           3× bank, 2× position, 2× bounty, 2× grant,
#           1× evidence-digest, 1× board, 1× catalog,
#           11× sealed-tamper/v1 — the lie exhibit
yarn --cwd packages/harness cli chain artifact ../../docs/evidence/trails/qwen3b-ladder-deadheat.json
#         → detected sealed-trail/v1 — routed, all checks pass
#         → the explorer's "verify anything" panel does the same
#           routing in-page for pasted artifacts — and its
#           "replay the whole bundle" button is the recursive
#           verifier in-browser: all 142 committed artifacts
#           through their own check lists, live progress

# 3q. THE FORGERY LAB — don't trust the checks, run the attack. The
#     explorer's "forgery lab" section hands you thirteen canned attacks:
#     forge a +1 score, swap the #1 rank, un-vouch an attested receipt,
#     flip a head-to-head verdict, mint a phantom receipt, inflate a
#     settled pool, re-age the ledger, mint a phantom run, erase an
#     artifact from the index, inflate a winning stake, steal the
#     bounty, redirect a disclosure grant to another viewer. Each
#     mutates a committed artifact
#     and hands it to the same in-page verifier — every forgery dies at
#     a named check (aggregates · ranking · snapshot binding · verdict
#     replay · receipt PDAs · pool accounting · counts · run surface ·
#     completeness · stake binding · account binding · grant PDA). The
#     headless audit pins all twelve.

# 3r. THE LIE EXHIBIT — we committed the forgeries themselves.
#     docs/evidence/tamper/ holds fifteen sealed-tamper/v1 cards — each
#     IS a forged artifact (oracle substitution, settled-money rewrite,
#     rank swap, bounty theft, viewer redirect, phantom receipts, stake
#     inflation) wrapped with the check(s) it died at, recorded when it
#     was minted. Verifying an exhibit replays the inner forgery against
#     the REAL verifier and asserts it still dies at the same named
#     check — the evidence base ships proof of its own skepticism:
yarn --cwd packages/harness cli chain artifact ../../docs/evidence/tamper --snapshot ../../web/snapshot.json
#         → ALL 15 EXHIBITS VERIFIED — every committed forgery still
#           rejected; the CLI mints them too:
#           chain artifact <card> --tamper --exhibit <dir> --snapshot <f>
#         → the explorer's "lie exhibit" section replays them in-page
#           (verifyTamper routes the inner card through the real
#           verifier and requires the rejection)
#         → python3 scripts/verify.py --tamper covers the same ground
#           in stdlib-only Python — six attacks, all caught

# 3s. THE ONE HASH — `chain fingerprint` re-hashes every manifest-
#     pinned file and prints BUNDLE ROOT: a single sha256 covering
#     every byte of evidence. The in-page bundle replay ends on the
#     SAME root — terminal and browser agree, or the bundle is dirty.
#     And the URL can carry the claim: append ?root=<that sha256> to the
#     hosted link and the page re-checks it on open — "LINK CLAIM
#     VERIFIED" means the bytes served recompute to the shared hash. A
#     verdict you can paste in chat, not a screenshot you have to trust.
#     Sibling param: ?card=<path> makes every committed artifact a
#     shareable self-verifying link — the page fetches the named card,
#     routes it to its verifier, and lands on the check list. e.g.
#       https://josepha-mayo.github.io/sealed/?card=banks/sealed-priv.json
#     lands on the private exam card with the ciphertext fold replayed.
#     The catalog itself is an artifact: ?card=artifacts.json replays
#     sealed-catalog/v1 — the index proves it lists EVERY artifact
#     (completeness + hash-pinning vs SHA256SUMS). Two more params:
#     ?forge=<attack> runs a live lab attack and lands on FORGERY CAUGHT;
#     ?tamper=<exhibit> replays a committed sealed-tamper/v1 lie, e.g.
#       https://josepha-mayo.github.io/sealed/?tamper=qwen3b-ladder-deadheat.substitute-the-oracle-rewrite-the-mpc-s-score.json
#     opens on EXHIBIT VERIFIED — the oracle-substituted trail card died
#     at run binding, exactly as recorded when it was minted. And
#     ?decrypt=1 is the payoff as a URL — the sealed private exam
#     materializes in-page, decrypted by the committed throwaway
#     delegate key (questions only — answers never move). CLI parity:
yarn --cwd packages/harness cli chain catalog --dir ../../docs/evidence --check
#         → CATALOG COMPLETE — 137 artifact(s), every sealed-*/v1 file listed
#           (the catalog doesn't list itself — 137 entries + the index = 138)
yarn --cwd packages/harness cli chain fingerprint
#         → re-hash check PASS — 351/351 · BUNDLE ROOT <64-hex sha256>
#           (the root moves whenever evidence moves — that's the point;
#           verify-all prints the current one at the end of the audit)

# 3t. THE TIMESTAMPED ROOT — the bundle root is notarized on Solana
#     devnet itself: docs/evidence-anchor.json holds a memo tx whose
#     payload IS the root ("sealed-fingerprint/v1 <hash>"). Verify with
#     zero tooling — open the explorer link in the file and read the
#     memo — or replay it:
yarn --cwd packages/harness cli chain fingerprint \
  --check-anchor ../../docs/evidence-anchor.json \
  --evidence ../../docs/evidence --web ../../web
#         → ANCHOR VERIFIED — memo on-chain ✓ root in memo ✓
#           anchor-vs-current ✓ (a DRIFT note just means evidence moved
#           after notarization — we re-anchor at freeze)
#     Notarize it yourself: `--anchor` signs the memo with YOUR devnet
#     wallet (default `~/.config/solana/id.json`, or pass a keypair
#     path) — the ledger then carries your independent attestation of
#     the same root, timestamped under your key, not ours:
yarn --cwd packages/harness cli chain fingerprint \
  --anchor ../../my-anchor.json --wallet ~/.config/solana/id.json
#         → your signature · your slot · same BUNDLE ROOT

# 3u. THE SECOND-LANGUAGE VERDICT — don't trust our TypeScript? Re-run
#     the whole integrity chain in stdlib-only Python (~2,500 lines —
#     every check, zero deps): re-hash both manifests, recompute the
#     BUNDLE ROOT, match the devnet anchor doc, re-derive every
#     artifact's PDAs with real ed25519 curve math (bump iteration +
#     off-curve rejection) — and it unpacks every raw account layout
#     itself (Benchmark/Run/ScoreLog/ModelRecord/Reveal/ShareGrant/
#     ItemChunk/PrivItemChunk on sealed; Market/DarkMarket/Ladder/
#     Bounty/Position/DarkPosition on market), so field binding checks
#     the bytes, not our decoder. EVERY committed artifact kind replays:
#     board, match, claim, trail, position, bounty, grant, tamper
#     exhibits, reports (canonical claim-hash), policy certs (evalGate
#     ported + receipt↔ScoreLog binding), the catalog's own index,
#     bank dossiers (the items_root MPC fold re-derived — private banks
#     fold ciphertexts+nonces), and the whole-ledger digest (keeper
#     classification and all).
python3 scripts/verify.py
#         → BUNDLE ROOT cfeb7eea… (same as the TypeScript — or the
#           bundle is dirty) · all 142 artifacts replayed in Python ·
#           anchor carries root PASS
#
#     …and watch the verifier catch its own lie — --tamper forges each
#     card kind (bounty theft, stake inflation, viewer redirect, pool
#     rewrite, oracle substitution, leaderboard inflation) and asserts
#     every forgery dies at a named check:
python3 scripts/verify.py --tamper
#         → ALL FORGERIES CAUGHT — the Python verifier rejects its own lies
#
#     The TypeScript CLI has the same lab — kind-aware mutations, each
#     asserted to die:  `chain artifact <card> --tamper`
yarn --cwd packages/harness cli chain artifact ../../docs/evidence/board.json \
  --tamper --snapshot ../../web/snapshot.json
#         → 3 attacks on the leaderboard card (score/rank/vouch),
#           ALL FORGERIES CAUGHT — the verifier rejects its own lies
#
#     …and the deepest cut: --decrypt ports the WHOLE disclosure stack
#     into stdlib Python — the RFC7748 x25519 exchange, Rescue-Prime over
#     Fp25519 (SHAKE256-sampled round constants, Cauchy MDS, key-schedule
#     permute, CTR mode), plus the hash-mode KDF. The committed throwaway
#     delegate key opens its ShareGrants a THIRD way — and re-encrypting
#     the recovered plaintext reproduces the on-chain ciphertext bytes
#     bit-exact, so a wrong port cannot pass:
python3 scripts/verify.py --decrypt
#         → all four grants decrypt · 32 item specs recovered · sha256 of the
#           spec set matches the JavaScript pin — the sealed exam is
#           readable by three implementations that must agree
#
#     and --check-anchor fetches the devnet notarization back over plain
#     JSON-RPC (stdlib urllib — no Solana SDK): the memo tx must carry
#     the claimed BUNDLE ROOT, at the claimed slot, paid by the claimed
#     wallet — then compared against the CURRENT tree:
python3 scripts/verify.py --check-anchor
#         → ANCHOR VERIFIED — memo, slot, blockTime, and fee payer all
#           echo the anchor doc; the anchored root IS the current root
#
#     and --rescore re-derives the MPC's own arithmetic on the public
#     calibration bank: plaintext answers → answerHash fingerprints →
#     on-chain Reveals, model outputs → chunkOut merkle → Run.outputs_root,
#     then an independent recount vs the MPC-written Run.correct — BOTH
#     committed artifacts, runs found by scanning for the root itself:
python3 scripts/verify.py --rescore
#         → RESCORED — 7/32 (qwen2.5-3b) and 2/32 (qwen2.5-1.5b)
#           reproduced from plaintext + decoded account bytes
#
#     and --card verifies YOUR file — download any artifact (or forge
#     one yourself) and the same check block replays it in Python:
python3 scripts/verify.py --card docs/evidence/board.json
#         → the leaderboard card replays solo: PDAs, aggregates,
#           pairwise matrix, Wilson ranking, receipt↔account binding —
#           a forged copy dies at its named check

#     and --remote runs the same verdict with NO CLONE: mirrors every
#     manifest-pinned byte — web/* from the hosted Pages site (what a
#     browser actually downloads), docs/evidence/* from raw.githubusercontent
#     — then runs the identical pass on served bytes. Composes with the
#     modes above, e.g. `--remote --decrypt` reads the sealed exam off
#     the served bundle. The truly-zero-install form:
curl -sL https://raw.githubusercontent.com/josepha-mayo/sealed/main/scripts/verify.py | python3 - --remote
#         → one downloaded stdlib file verifies all 359 pinned bytes
#           itself — no git, no pip, nothing but python3

# 3v. THE CAPSULE — web/standalone.html is the entire submission as ONE
#     6.6MB file: the page, the snapshot, all 142 artifacts, both
#     manifests, the vendored crypto deps, and the devnet anchor doc,
#     plus a fetch() shim so every in-page verifier runs OFFLINE.
#     Download it, disconnect, open it in any browser — the audit, the
#     recursive replay, and the forgery lab all still pass. Regenerate
#     byte-identically: `node scripts/gen-standalone.mjs` (--check in CI),
#     and CI re-runs the entire in-page audit INSIDE the capsule
#     (SEALED_PAGE=standalone.html) — the offline claim is tested, not
#     assumed.

# 4. verify a committed output independently (two-level Merkle proof)
#    — the PDA below lives on the author's current localnet; after demo.sh
#    substitute YOUR run PDA (printed by `chain score` / `chain status`).
node scripts/verify-proof.mjs docs/evidence/prove-item0.json \
  --run 4uns99WDqEFZCzNXa7KhW361CKd4XB5x7CLDX8THfJZ1 --rpc http://127.0.0.1:8899
```

## Who proves what — every load-bearing claim, three implementations that must agree

| Claim | TypeScript CLI | Explorer (in-browser JS) | stdlib Python |
|---|---|---|---|
| Bundle integrity — 359 pinned files → one BUNDLE ROOT | `chain fingerprint` | auto-audit §bundle | `verify.py` §1–3 |
| PDA custody — every account re-derives, vaults provably keyless | `artifact --verify` | audit §PDA | `verify.py` §5–8 |
| All 138 artifact cards replay | `artifact --recursive` | `?mega=1` cascade | `verify.py` §9–17 |
| MPC score arithmetic (fingerprints → Reveals → outputs_root → recount) | `rescore.mjs` | audit §calibration | `verify.py --rescore` |
| Selective disclosure — grants decrypt, ciphertext round-trips | `decrypt-grants-test` | ⑤ read the sealed exam | `verify.py --decrypt` |
| Forgeries die at named checks | `artifact --tamper` | forgery lab + forge-your-card | `verify.py --tamper` |
| Devnet notarization carries the root | `fingerprint --check-anchor` | audit §anchor | `verify.py --check-anchor` |

Nothing in the middle column trusts the left column — Python re-derives
the curve math, unpacks the raw account bytes, and re-runs the MPC's
arithmetic itself. If two columns disagree, the discrepancy is a finding,
not a rounding error (see `docs/engineering-log.md` §verifier-side).

## The 30-second wow moment

On-chain, a private benchmark holds **only ciphertext** — see it in the
explorer's private-bank card, or `solana account <priv-item-chunk-pda>`;
`chain pitems` is the only thing that can read it (authority key only). Then
`chain reshare --to <judge-pubkey>` + (as the judge) `chain delegate-bank`
rebuilds the exam **entirely from grants** — byte-identical to the authority's
decryption, and nobody else on the network ever saw a single question. That is
an evaluation the exam's own author can't leak, because there is no author.

**Or just click.** On the hosted explorer, the private bank card has a
*decrypt with demo delegate key* button — a throwaway localnet delegate
keypair is committed (`web/demo-delegate.json`), and the page vendors the real
`RescueCipher` (`web/vendor/rescue.mjs`, noble-only — no Node builtins), so the
shared-secret derivation, Rescue/x25519 decryption, and spec unpacking all run
in your browser. You see the 32 sealed questions nobody else can read;
`node scripts/decrypt-grants-test.mjs` regression-tests the exact same code
path offline against the harness' own reconstruction (32/32 identical).
