# Demo video script — ~2.5 minutes

**Pre-recorded artifacts committed:** `docs/demo.cast` (asciinema),
`docs/demo.gif` (embedded in README), `docs/demo.mp4` (114s — the full
`scripts/demo.sh` run with MPC waits capped at 2s, upload-ready),
`docs/audit.cast` + `docs/audit.gif` (the ~19s keyless audit —
`scripts/judge-demo.sh`, zero localnet needed; now carries the
third-language decrypt + MPC rescore beats). To
re-record: `asciinema rec --idle-time-limit 2 docs/demo.cast -c "bash
scripts/demo.sh"` then `agg --speed 1.25 docs/demo.cast docs/demo.gif`.
For a narrated cut, play `docs/demo.mp4` under voiceover per the beat
table below — every beat shown is a real command with real output.

Recorded against `arcium localnet` (or devnet once callbacks recover). Every
beat is a real command with real output — no mockups. `scripts/demo.sh` runs
the whole arc end-to-end; this script splits it into narrated segments.

| Time | Beat | Show | Say |
|---|---|---|---|
| 0:00 | COLD OPEN — the cheat that got caught | bank 25864 leaderboard frozen on `openai` 64/64 above `openai` 1/64 | "Two runs on this bank both claimed 64 out of 64. The MPC cluster scored one of them 1 out of 64. Watch why that matters — and why nothing like it existed before." |
| 0:08 | The problem | `docs/pitch.md` table / README "why" | "Every AI leaderboard trusts an operator who could lie. Every benchmark answer key is a thing that can leak." |
| 0:15 | The fix in one line | `chain gen` minting (8 computations — 4 parts × 2 chunks) | "We mint the benchmark *inside* the MPC cluster. The questions come from the cluster's RNG; the answers are computed and fingerprinted in-circuit and born encrypted to the cluster key — the MXE key. There is no answer key anywhere on Earth — nothing to leak, sell, or subpoena." |
| 0:30 | Public minted items | `chain items --benchmark <pk>` + explorer items grid | "The item specs are public — anyone can re-render the prompts and re-fold the items_root commitment." |
| 0:40 | Private bank | `chain gen-private` then explorer's ciphertext-only card | "Or the specs stay encrypted to the authority's key. The chain holds ciphertext only — and items_root still commits to it, so the mint transcript is auditable without decrypting." |
| 0:55 | Selective disclosure | `chain reshare` ×4 → `chain grants` | "The authority hands a judge the exam — the MPC re-encrypts the questions to the judge's key. Grant PDAs record who can see which parts. The answers never move." |
| 1:08 | Delegate rebuild | `chain delegate-bank` (judge keypair) | "The judge rebuilds the whole bank from grants alone — questions stay private from the public chain, answers never existed in plaintext." |
| 1:18 | Real model scoring | `run --model openai` + `chain score` | "A real model answers the sealed items. The MPC cluster hash-compares its outputs against the sealed fingerprints and posts only a count." |
| 1:28 | The anti-cheat payoff | back to the 25864 leaderboard — resolve the cold open | "Back to that 1/64: both artifacts claimed a perfect score — but the second one answered a stale bank file. The clean run's 64/64 matched its claim exactly; the stale one scored 1. The chain doesn't care what your artifact *claims* — the cluster's count is the score." |
| 1:38 | Markets | explorer markets card: binary + 3-way + duel + ladder | "And the score is a settlement source: threshold markets, score bands, head-to-head duels — and K-way ladder races: three models, one pot, argmax takes it, ties split dead-heat. Bets close the moment ANY leg starts scoring, so nobody trades on a half-known result." |
| 1:52 | Resolution | `market resolve` → `claim` + leaderboard | "Permissionless settle straight off `Run.correct`. Winner withdraws. No oracle operator, no admin key." |
| 1:58 | Audit + decrypt beat | hosted explorer `?mega=1`: audit panel green checks → **the sealed exam decrypting in-browser** | "And you don't have to trust any of this: one link re-derives every account, replays every settlement — then decrypts the sealed exam *in your browser* — an exam that exists nowhere in plaintext. A second verifier in stdlib Python agrees, with zero clone." |
| 2:12 | The attack | forgery lab: press "forge a +1 score" — the mutated leaderboard card dies at the *aggregates* check, live | "Don't take our word for the checks — run the attack. Twelve canned attacks, twelve named catches — and the tamper/ exhibit pins eleven forged artifacts that verify by being REJECTED." |
| 2:22 | The one hash | `chain fingerprint` → `BUNDLE ROOT`, then the devnet anchor receipt | "The whole evidence base — every bank, run, settlement, artifact — is one sha256, and that root is timestamped on Solana devnet. Change one byte of our evidence and the hash breaks. This submission ends in a sha256 — not a promise." |
| 2:35 | Close | leaderboard + grant trail | "The exam nobody can leak, the score nobody can fake, the market that settles itself." |

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

0:00 cold open — two runs claimed 64/64; the MPC scored one of them 1/64
0:08 the problem — trusted evaluators can lie
0:15 `chain gen` — items minted inside MPC, answers born encrypted
0:30 public minted items — specs anyone can re-render and re-commit
0:40 `gen-private` — the bank is ciphertext on-chain, end to end
0:55 `reshare` — selective disclosure: the judge gets questions, not answers
1:08 delegate rebuild — the bank reconstructed from grant PDAs alone
1:18 real model scoring — MPC compares committed outputs, posts only a count
1:28 the anti-cheat payoff — the cold open resolved (stale artifact, honest 1/64)
1:38 markets — threshold, score bands, duels, K-way ladder races, dark
commit-reveal (sides stay sha256-sealed), capability bounties (escrow pays
the first operator to provably clear T — real-model claim in
`docs/evidence/real-bounty.txt`)
1:52 permissionless settle — resolve straight from `Run.correct`, claim
1:58 audit + decrypt — the page re-derives every account, replays every
settlement, then decrypts the sealed exam in-browser
2:12 the attack — the forgery lab runs a live attack, caught at a named check
2:22 one sha256 — the whole evidence base notarized on devnet
2:35 close — the exam nobody can leak, the market that settles itself

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
| 0:00 | One URL | https://josepha-mayo.github.io/sealed/?mega=1 | "One link — no wallet, no node, no RPC key. Watch the whole evidence base prove itself." |
| 0:02 | The cascade | megares rows landing: account audit → 142 artifacts → forgery sweep → the sealed exam decrypting | "Every account PDA re-derived, every committed proof replayed, every lab attack caught — and then the page decrypts the sealed exam, in your browser, ~8 seconds." |
| 0:08 | The scoreboard | EVERYTHING VERIFIED + the copyable verdict block — audit counts, root, anchor state | "Nothing trusted — including the page itself: it re-hashes its own bytes against the manifest. The verdict block copies straight into your notes." |
| 0:14 | The artifact | ?card= link: pick a bounty card, watch the account bind | "One JSON file is a whole claim — bounty, bettor, grant, exam — and it verifies itself against the chain bytes." |
| 0:20 | The second language | `python3 scripts/verify.py --all` | "Don't trust our TypeScript — ~2500 lines of stdlib Python re-derive every PDA with real curve math, unpack the raw account bytes, replay all 142 artifacts, run the forgery lab, decrypt the exam, and recount the MPC score. One flag runs all of it." |
| 0:26 | The zero-clone form | `curl -sL …/verify.py | python3 - --remote` | "Or don't even clone — one downloaded file re-verifies all 359 served bytes, straight off the hosted site." |
| 0:30 | The close | the audit card's ANCHOR VERIFIED line — devnet memo timestamp | "The whole evidence base is one sha256, notarized on devnet. Terminal, browser, and Python all agree — or it's dirty." |

**Tags:** solana, arcium, mpc, confidential computing, prediction markets,
ai evals, zero knowledge, anchor, colosseum, crypto worlds fair
