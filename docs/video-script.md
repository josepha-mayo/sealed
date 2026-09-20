# Demo video script — ~2 minutes

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
| 1:15 | Real model scoring | `run --model openai` + `chain score` | "A real model answers the minted items. The MPC cluster hash-compares its outputs against the sealed fingerprints and posts only a count." |
| 1:25 | The anti-cheat beat | bank 25864 leaderboard: `openai` 1/64 above `openai` 64/64 | "This bank holds two runs from the same model id. One artifact claimed 64/64 locally — but it answered a stale bank file, so MPC scored it 1/64. The clean run scored 64/64. The chain doesn't care what your artifact *claims* — the enclave's count is the score." |
| 1:35 | Markets | explorer markets card: binary + 3-way + duel | "And the score is a settlement source: threshold markets, score bands — and head-to-head duels. 'Does run A outscore run B?' — bets close the moment either side starts scoring, so nobody trades on a half-known result." |
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
