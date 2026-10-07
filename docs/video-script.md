# Demo video script — ~2 minutes

**Pre-recorded artifacts committed:** `docs/demo.cast` (asciinema),
`docs/demo.gif` (embedded in README), `docs/demo.mp4` (114s — the full
`scripts/demo.sh` run with MPC waits capped at 2s, upload-ready). To
re-record: `asciinema rec --idle-time-limit 2 docs/demo.cast -c "bash
scripts/demo.sh"` then `agg --speed 1.25 docs/demo.cast docs/demo.gif`.
For a narrated cut, play `docs/demo.mp4` under voiceover per the beat
table below — every beat shown is a real command with real output.

Recorded against `arcium localnet` (or devnet once callbacks recover). Every
beat is a real command with real output — no mockups. `scripts/demo.sh` runs
the whole arc end-to-end; this script splits it into narrated segments.

| Time | Beat | Show | Say |
|---|---|---|---|
| 0:00 | The problem | `docs/pitch.md` table / README "why" | "Every AI leaderboard trusts an operator who could lie. Every benchmark answer key is a thing that can leak." |
| 0:10 | The fix in one line | `chain gen` minting (8 computations — 4 parts × 2 chunks) | "We mint the benchmark *inside* the MPC cluster. The questions come from enclave randomness; the answers are computed and fingerprinted in-circuit and born encrypted to the cluster key. There is no answer key anywhere on Earth — nothing to leak, sell, or subpoena." |
| 0:25 | Public minted items | `chain items --benchmark <pk>` + explorer items grid | "The item specs are public — anyone can re-render the prompts and re-fold the items_root commitment." |
| 0:35 | Private bank | `chain gen-private` then explorer's ciphertext-only card | "Or the specs stay encrypted to the authority's key. The chain holds ciphertext only — and items_root still commits to it, so the mint transcript is auditable without decrypting." |
| 0:50 | Selective disclosure | `chain reshare` ×4 → `chain grants` | "The authority hands a judge the exam — the MPC re-encrypts the questions to the judge's key. Grant PDAs record who can see which parts. The answers never move." |
| 1:05 | Delegate rebuild | `chain delegate-bank` (judge keypair) | "The judge rebuilds the whole bank from grants alone — questions stay private from the public chain, answers never existed in plaintext." |
| 1:15 | Real model scoring | `run --model openai` + `chain score` | "A real model answers the sealed items. The MPC cluster hash-compares its outputs against the sealed fingerprints and posts only a count." |
| 1:25 | The anti-cheat beat | bank 25864 leaderboard: `openai` (= gpt-oss-20b) 64/64 above `openai` 1/64 | "This bank holds two runs from the same model — gpt-oss-20b, shown as `openai` on-chain. The clean run scored 64/64 — MPC matching its local claim exactly. The other artifact also claimed 64/64, but it answered a stale bank file, so MPC scored it 1/64. The chain doesn't care what your artifact *claims* — the enclave's count is the score." |
| 1:35 | Markets | explorer markets card: binary + 3-way + duel + ladder | "And the score is a settlement source: threshold markets, score bands, head-to-head duels — and K-way ladder races: three models, one pot, argmax takes it, ties split dead-heat. Bets close the moment ANY leg starts scoring, so nobody trades on a half-known result." |
| 1:50 | Resolution | `market resolve` → `claim` + leaderboard | "Permissionless settle straight off `Run.correct`. Winner withdraws. No oracle operator, no admin key." |
| 1:55 | Audit beat | `chain reveal` + `chain verify`, then the hosted explorer's audit panel auto-running — green checks ending on the calibration rescore | "Need to audit a score? The authority declassifies answer *fingerprints* — never plaintext. And you don't have to trust this page: the hosted explorer re-derives every PDA, replays every resolution, and recomputes the MPC's arithmetic on a public calibration exam — in your browser, right now." |
| 2:00 | Specimen beat | explorer calibration card: 32 rows, canonical answer vs two models' outputs, discrimination line | "This is a real exam the enclave sealed then revealed on purpose: qwen-3b scored 7 of 32, the 1.5b scored 2 — and the matrix shows exactly which five items separate them. Every hash on this table was recomputed live." |
| 2:10 | Close | leaderboard + grant trail | "A benchmark nobody can read, scored by nobody in particular — and a market that settles itself." |

## Cut points if you only have 60s

Keep beats: problem (0:00), MPC mint (0:10), private bank (0:35),
reshare (0:50), duel market (1:30), resolve (1:45). Skip items/delegate-bank/
audit close.

## Honesty footnote (say it, don't hide it)

Devnet: the shared Arcium devnet cluster currently finalizes computations but
withholds callback transactions — the full loop is proven on localnet and the
devnet retry watchers land the moment callbacks resume.

## YouTube upload — paste-ready metadata

**Title:**
Sealed — a benchmark the MPC cluster wrote, scored, and settled (Solana ×
Arcium, Crypto World's Fair)

**Description:**

Every AI score you trust was made by a party who could fake it. Sealed
removes that party: benchmark questions are minted *inside* an Arcium MPC
cluster, the answers are computed and fingerprinted in-circuit — no answer
key ever exists in plaintext — and a second program settles parimutuel
markets straight from the MPC-written score. No oracle operator, no admin
key, nothing to leak.

0:00 the problem — trusted evaluators can lie
0:10 `chain gen` — items minted inside MPC, answers born encrypted
0:25 public minted items — specs anyone can re-render and re-commit
0:35 `gen-private` — the bank is ciphertext on-chain, end to end
0:50 `reshare` — selective disclosure: the judge gets questions, not answers
1:05 delegate rebuild — the bank reconstructed from grant PDAs alone
1:15 real model scoring — MPC compares committed outputs, posts only a count
1:25 the anti-cheat beat — gpt-oss-20b 64/64 vs a stale artifact's honest 1/64
1:35 markets — threshold, score bands, duels, K-way ladder races, dark
commit-reveal (sides stay sha256-sealed), capability bounties (escrow pays
the first operator to provably clear T — real-model claim in
`docs/evidence/real-bounty.txt`)
1:50 permissionless settle — resolve straight from `Run.correct`, claim
1:55 audit beat — fingerprint reveal; the hosted explorer's 13-check audit
panel (it even verifies its own served bytes against web/MANIFEST)
2:00 calibration specimen — the exam the enclave sealed then revealed:
3b 7/32 vs 1.5b 2/32, per-item discrimination recomputed in-browser
2:10 close — a benchmark nobody can read, a market that settles itself

Also shipped: dark commit-reveal markets (`docs/dark.cast`), a
head-to-head duel market (`docs/duel.cast`), and the prefund-grief
reclaim demo (`docs/evidence/unbrick-demo.txt`).

Everything shown is a real run on `arcium localnet` — transcripts and
account snapshots are in `docs/evidence/`. Source:
https://github.com/josepha-mayo/sealed — hosted explorer:
https://josepha-mayo.github.io/sealed/ (runs the full audit in-browser).
Devnet note: the shared Arcium cluster currently withholds callback
transactions; the full loop is proven on localnet.

## The 30-second keyless cut (judge-facing)

For a judge who will never run a validator — the verification story is
the demo. Screen-record the hosted explorer only:

| Time | Beat | Show | Say |
|---|---|---|---|
| 0:00 | One URL | https://josepha-mayo.github.io/sealed/ loading `web/snapshot.json` | "No wallet, no node, no RPC key — the whole ledger replayed from one committed file." |
| 0:05 | The audit | audit panel auto-running — PDAs re-derived, roots re-folded, 201 resolutions replayed | "Every claim on this page is re-computed in your browser right now — nothing is trusted." |
| 0:12 | The artifact | claim-card verifier: pick `qwen2.5-3b-instruct`, 9/9 checks pass | "One file is a model's entire reputation — and it verifies itself." |
| 0:18 | The replay | "replay the whole bundle" — 117 artifacts through their own verifiers, per-kind tallies | "One click replays every committed proof — 117 artifacts, seven kinds, in your browser." |
| 0:24 | The attack | forgery lab: press "forge a +1 score" — the mutated board dies at the *aggregates* check, live | "Don't trust the checks — run the attack. Every forgery dies at a named check." |
| 0:30 | The close | the audit card's bundle-root line — the same sha256 `chain fingerprint` prints | "The whole evidence base is one sha256 — terminal and browser agree, or it's dirty. Nobody else ends in a hash." |

**Tags:** solana, arcium, mpc, confidential computing, prediction markets,
ai evals, zero knowledge, anchor, colosseum, crypto worlds fair
