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
| 1:55 | Audit beat | `chain reveal` + `chain verify` | "Need to audit a score? The authority declassifies answer *fingerprints* — never plaintext — and the client recomputes the run's committed outputs against them." |
| 2:00 | Close | leaderboard + grant trail | "A benchmark nobody can read, scored by nobody in particular — and a market that settles itself." |

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
1:35 markets — threshold, score bands, duels, K-way ladder races
1:50 permissionless settle — resolve straight from `Run.correct`, claim
1:55 audit beat — fingerprint reveal without plaintext
2:00 close — a benchmark nobody can read, a market that settles itself

Also shipped: dark commit-reveal markets (bettor sides stay sha256-sealed
until reveal — `docs/dark.cast`) and a head-to-head duel market
(`docs/duel.cast`).

Everything shown is a real run on `arcium localnet` — transcripts and
account snapshots are in `docs/evidence/`. Source:
https://github.com/<ORG-OR-USER>/sealed (program IDs + explorer link in
README). Devnet note: the shared Arcium cluster currently withholds callback
transactions; the full loop is proven on localnet.

**Tags:** solana, arcium, mpc, confidential computing, prediction markets,
ai evals, zero knowledge, anchor, colosseum, crypto worlds fair
