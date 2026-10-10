# Promotion drafts

Copy-paste material for build-in-public + Arcium outreach. The hosted
explorer is live at https://josepha-mayo.github.io/sealed/ (GitHub Pages,
auto-deployed on every push).

## X / Twitter thread (build in public)

1/ Sealed: prediction markets on AI models whose benchmark questions and
answer keys *do not exist in plaintext anywhere*.

Benchmarks are minted inside the Arcium MPC cluster — the bank is born
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
> On the evidence ledger: **503 runs · 340 venues across six settlement
> primitives · 4 real open-weights models** (a dead-heat ladder paid both
> co-leaders pro-rata; a stale-artifact "64/64" claim scored **1/64** —
> the chain does not trust self-reports) **· a sealed private exam**
> readable only by delegate grant — and all of it folds to **one sha256
> notarized on devnet**.
>
> Verify it in seconds, not trust: the explorer's **`?mega=1`** link runs
> the entire audit in your browser (~8s) — every account's PDA re-derived,
> all 176 artifacts replayed, 12 forgeries dying at named checks, the
> sealed exam decrypted in-page. Or `curl …/verify.py | python3 - --remote`
> — one stdlib file re-verifies all 351 served bytes, zero clone. The
> forgery lab lets you run the attacks yourself.
>
> The depth is real: `market sharps` reports the 125-wallet anonymity set
> honestly, `market escrow` reconciles every lamport, `chain anomalies`
> runs twelve hostile checks on our own bundle and prints the warns,
> `chain gate --sweep` maps every model's surviving policy frontier, and
> portable `sealed-*/v1` evidence cards cover every actor — claims,
> matches, trails, positions, bounties, grants, the board itself.
>
> Honest status: both programs live on devnet and byte-verified
> (`verify-deployed.sh` — MATCH, MATCH); the shared Arcium devnet
> cluster's callback outage stalls new flows upstream — everything is
> proven on the committed localnet evidence bundle.
>
> Repo: github.com/josepha-mayo/sealed · Explorer:
> josepha-mayo.github.io/sealed · Judge guide: docs/judges.md

### Command inventory (reference — the detail behind the post)

- On-chain surface: six settlement primitives — score-band, head-to-head
  duels, K-way ladder races (dead-heat pro-rata, 3-8 legs), unseen-exam
  markets, dark commit-reveal (bettor side is a sha256), escrowed
  capability bounties paying the winning run's operator. All settled
  real-model MPC scores.
- Model registry: `ModelRecord` + `ScoreLog` receipts → `chain gate`
  policy evaluation (min-accuracy/min-items/vouched-only/Wilson/no-post-
  reveal, exit 0/1/2), `chain history` as regression detector.
- Keeper ops: `chain market board` (36 actionable venues on the bundle),
  `chain market sweep --watch` keeper daemon, `market positions`,
  `market unclaimed` names every owed claimant.
- Analytics: `market odds`/`sentiment`/`champions`/`divergence`
  (evidence-vs-conviction), `market calibration` (Brier vs uniform),
  `matrix` capability grid, `compare --all --wilson` (392/465 pairs
  share no bank — paired ranking != aggregate), `banks --depth`.
- Verifier chain: `chain stats` replays 31 aggregates + 201 resolutions
  inline, `chain items` regenerates an MPC-minted exam from raw chunks,
  `chain artifact docs/evidence --recursive` replays all 176 artifacts,
  `chain fingerprint` folds everything to one BUNDLE ROOT. `chain prove`
  mints `sealed-claim/v1` cards (31 committed, `--verify claims/`
  replays 279 checks; `--min-pct N` re-grades against caller policy);
  `chain gate --cert` mints `sealed-policy/v1` (two committed); trails,
  reports, positions, bounties, grants, bank, digest, catalog cards all
  replay keyless. `chain tour` narrates the ledger; `watch` ticks it
  live; `chain search` resolves any pubkey to its dossier.
- Explorer mirrors all of it in-page plus: the 24-stop tour, per-kind
  card verifiers, policy sweep, escrow ledger, diff-any-bundle button,
  and the tamper exhibits.

Numbers must stay in sync with web/snapshot.json — re-check against
`node scripts/verify.mjs` output before posting.
