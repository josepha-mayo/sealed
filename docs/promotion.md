# Promotion drafts

Copy-paste material for build-in-public + Arcium outreach. The hosted
explorer is live at https://josepha-mayo.github.io/sealed/ (GitHub Pages,
auto-deployed on every push).

## X / Twitter thread (build in public)

1/ Sealed: prediction markets on AI models whose benchmark questions and
answer keys *do not exist in plaintext anywhere*.

Benchmarks are minted inside Arcium MPC enclaves — the bank is born
encrypted, stays encrypted, and is scored by the cluster itself.
🧵

2/ AI leaderboards today: a lab submits a score, or an operator runs the
eval and posts a number. Both are trusted claims.

Sealed inverts it: the answer key never leaves MPC. Runners can't see it.
The bank owner can't see it. The score on-chain is the only score.

3/ The primitive stack, all live:

- MPC-minted banks (items born inside the enclave, fingerprinted answers)
- Private banks (ciphertext-only specs on-chain)
- Selective disclosure — show a judge the questions, not the answers
- MPC scoring — run.correct is written by the cluster, not an oracle

4/ On top: six market primitives resolving straight from
Run.correct — no oracle multisig:

- binary over/under on a score
- N-way score bands
- duels: model A vs model B
- ladder races: 3–8 runners, argmax wins, dead-heat splits
- unseen-exam markets: the priced event is itself ciphertext
- dark commit-reveal markets: bettor sides stay sha256-sealed until reveal
Plus a non-parimutuel primitive — capability bounties: a sponsor escrows
SOL on "first MPC-proven run ≥ threshold", pot pays the winning run's
operator.

5/ The security story is adversarial-reviewed: JIT-commit attacks,
landing-window expiry, committed-settle semantics, strict ordered leg
accounts. Every edge has a regression test.

Evidence: 503 runs on the merged evidence ledger (8 localnet epochs), 340
market+bounty venues across six primitives, 201 resolutions re-verified by
the offline audit — every artifact and Merkle proof in the repo,
replayable bit-for-bit.

6/ Headline run: gpt-oss-20b scored 64/64 on a bank minted inside MPC —
no answer key ever existed outside the enclave. A stale-artifact cheat
attempt on the same pipeline scored 1/64 honestly.

The model can't cheat what it can't see.

7/ Explorer: https://josepha-mayo.github.io/sealed/ — banks, runs, markets,
ladders, Merkle-proof verification, all rendered from on-chain data.
Zero backend.

Built for @colosseum Crypto World's Fair on @arcium.

## Arcium outreach (Discord / DM to team or judges channel)

> Hey — building Sealed for CWF: prediction markets on AI benchmark
> results where the answer key never exists outside MPC. Banks are minted
> by gen_part inside the enclave, scored by score_chunk callbacks, and
> markets resolve directly from the Run accounts your nodes finalize —
> no oracle. Also shipped a novel K-way "ladder race" market primitive on
> top (argmax + dead-heat mask), which lines up with the novel-mechanisms
> ask. 503 runs on the evidence ledger, most MPC-finalized; the sealed
> program is devnet-deployed and byte-verified
> (scripts/verify-deployed.sh sha256-compares the on-chain
> ELF to the repo build) but the shared cluster's callback outage is
> blocking flows — flagging in case it helps. Would love a pointer if
> there's a recommended workaround or a mainnet-cluster path for the demo.

## Colosseum forum post (if a project channel exists)

Title: Sealed — benchmark answer keys that never exist in plaintext

Body (paste-ready; numbers verified against web/snapshot.json):

> Every "will model X beat score T" market today resolves on a promise —
> a lab's self-report, a leaderboard's screenshot, an oracle committee.
> Sealed removes the promise. Benchmarks are minted inside Arcium MPC, the
> answer fingerprints never leave the encrypted boundary, models answer
> blind or through selective-disclosure grants, MPC tallies the score, and
> Solana markets resolve permissionlessly off the number it writes.
>
> What's on-chain now: 503 runs across 120 banks, 340 venues over six
> settlement primitives — score-band, head-to-head duels, K-way ladder
> races (dead-heat pro-rata, 3–8 legs), unseen-exam markets that price a
> run on a bank nobody can read, dark commit-reveal markets where the
> bettor's side is a sha256 commitment, and escrowed capability bounties
> that pay the first MPC-proven run over a threshold. Every primitive has
> settled a real open-weights model's score — four local models raced an
> MPC-minted exam (qwen2.5-3b and 1.5b dead-heated at 6/32; the ladder
> paid pro-rata), gpt-oss-20b scored 64/64 on a bank whose answer key
> never existed in plaintext, and a stale-artifact "64/64" claim scored
> 1/64 — the chain doesn't trust self-reports. A persistent model registry
> (`ModelRecord` + `ScoreLog` receipts) turns those runs into a
> capability record any program can gate on — `chain gate` evaluates a
> policy (min accuracy / min items / vouched-only / Wilson lower bound /
> no-post-reveal) with exit 0/1/2, and `chain history` replays a model's
> receipt trajectory (a regression detector). Operations are
> permissionless end-to-end: `chain market board` inventories what a
> keeper can act on (claimable bounties, resolvable venues, tallyable
> darks, sweepable expiries — mirroring the on-chain
> still_moving/proven gates), `chain market sweep --watch` is the
> keeper daemon that executes all of it, and `chain market positions`
> is the bettor-side book with estimated payouts. The explorer renders
> the same keeper board in-page — on the bundled ledger it flags 36
> actionable venues. And every read surface — `board`, `gate`,
> `history`, `compare`, `records`, `banks`, `positions` — takes
> `--snapshot web/snapshot.json` to replay the committed evidence bundle
> keyless: the CLI and the explorer agree bit-for-bit on a file you can
> download and diff. `chain compare` goes further than a leaderboard:
> it joins receipts by benchmark — "does A beat B on the SAME exams?"
> — and `compare --all` tallies every pair's shared-bank result into a
> W-L-T table where disjoint coverage counts as unranked, not assumed
> (on this ledger: 392/465 pairs share nothing — the paired ranking
> tells a different story than aggregate accuracy, which is the point).
> `chain stats` compresses the honesty story into one screen: ledger
> counts, escrow, MPC latency p50/p95 — and two verdicts recomputed
> inline, all 31 registry aggregates bit-exact from receipts and all 201
> resolutions matching `Run.correct`, exit 1 on a violation. `chain runs`
> is the substrate index underneath it, and `chain items` regenerates an
> entire MPC-minted exam from raw on-chain chunks — items_root fold
> re-verified, keyless. `chain tour` narrates all of it in one command —
> seven stops through live-picked exhibits, ending on what the stakes
> believe: `chain market odds`/`sentiment`/`champions` pool the books
> into per-model implied probabilities, expected scores, and settlement
> records, `chain market divergence` shows where the money disagrees
> with the receipts (the flagship: a model 0W-8L on evidence still
> priced #3), `chain market calibration` grades the closing books
> (87% favorite hit-rate, Brier better than uniform), `chain matrix`
> renders the capability grid — models × most-run banks — `chain market
> live` is the bettor's board of venues still taking positions, `chain
> market quote` simulates a stake before it exists (the program's own
> parimutuel math), `chain search` resolves any pasted pubkey to its
> dossier, `chain model` fuses all four model lenses plus matrix
> coverage into one page, `compare --all --wilson` ranks by 95% lower
> bound instead of raw wins, and `chain watch` ticks the ledger live.
> Then the surfaces nobody else has: `chain market sharps` ranks bettor
> track records on realized P&L and reports the book's anonymity set
> honestly (126 positions, almost all one-position wallets — no repeat
> records survives); `chain market escrow` reconciles every staked
> lamport to its obligation bucket, balanced to the lamport (76.075◎ in,
> in-play / owed / contingent / bounty / settled-out, zero dead money);
> `chain anomalies` runs twelve hostile checks on its own bundle (the
> disclosed post-reveal runs are the one warn); `chain gate --sweep`
> drops the single-threshold assumption — every record's "frontier" is
> the strictest line it survives; and `chain prove` mints the actual
> deliverable — a portable `sealed-claim/v1` card per model where every
> PDA re-derives keyless and every verdict replays. `chain prove --all`
> ships the entire registry that way: 31 committed cards, `chain prove
> --verify claims/` replays all 279 checks — and `--verify <card>
> --min-pct N` re-grades a card against the *caller's* policy (authentic
> AND sufficient in one verdict). The governance artifact follows the
> same pattern: `chain gate --all --cert` mints `sealed-policy/v1`
> certificates (two committed: a 60%-3runs admission and a strict
> vouched 70% — the strict one honestly returns 27 no-evidence),
> `chain report` prints the dossier as a card-hash-pinned document,
> `chain gate <model> --why` autopsies the binding constraint,
> `chain market unclaimed` names every owed claimant, and
> `chain banks --depth` sorts exams by lamports moved. The capper:
> `chain artifact docs/evidence --recursive` replays all 115 committed
> artifacts in one pass (claims, matches, policies, trails, reports —
> five portable kinds, one universal verifier), and `chain fingerprint`
> folds every manifest-pinned byte into a single `BUNDLE ROOT` sha256
> the terminal and the explorer agree on.
>
> Verify it yourself in three minutes: the hosted explorer replays the
> entire ledger in your browser — PDA derivation, Merkle folds, all 201
> market resolutions re-derived from `Run.correct`, the 31-record
> registry replayed bit-exact from 292 receipts — plus a public
> calibration exam where the page recomputes the MPC score per item,
> an in-page claim-card verifier (pick any of the 31 committed cards, set YOUR policy thresholds on it,
> all sha256-pinned in the bundle MANIFEST), a skeptic's-checklist
> panel, the policy sweep, the escrow ledger, and a "diff…" button that
> shows added/removed/mutated accounts when you drop any bundle.
> Or don't run anything: `docs/evidence/replay.txt` is a captured
> transcript of the same commands.
> No install, no trust in us.
>
> Honest status: both programs live on devnet and byte-verified against
> this repo (`verify-deployed.sh` — MATCH, MATCH); the shared Arcium devnet
> cluster's callback outage stalls new bank flows upstream — every flow
> is proven on the committed localnet evidence bundle.
>
> Repo: github.com/josepha-mayo/sealed · Explorer:
> josepha-mayo.github.io/sealed · Judge guide: docs/judges.md

Numbers must stay in sync with web/snapshot.json — re-check against
`node scripts/verify.mjs` output before posting.
