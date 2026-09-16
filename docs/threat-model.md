# Sealed — threat model

What each participant can and cannot do. The whole point of the design is that
nobody — including the operator — ever sees the plaintext benchmark answers
after sealing, and nobody can fabricate a score.

## Actors

- **Benchmark author** — holds the plaintext bank and the shared encryption key
  until the last `seal_part` lands. After that the key can be discarded; the
  onchain state only carries MXE-encrypted ciphertexts.
- **Runner** — submits a model's outputs as public hashes (`outputs_root` +
  per-chunk hashes), pays the run fee.
- **Arcium MPC cluster** — executes `seal_part` / `score_chunk` under MPC and
  posts results back via callback transactions.
- **Market participants** — bet on `run.correct` outcomes.
- **Anyone** — can call `resolve` on a market once the run finalizes, can
  verify output proofs against `outputs_root`, can read every account.

## Guarantees

| Claim | Mechanism |
|---|---|
| Answers never appear onchain as plaintext | Author encrypts locally (Rescue, shared key) → `stage_part`; MPC re-encrypts to the MXE key → `seal_part` callback overwrites the author-key ciphertext with MXE-key ciphertext |
| A run cannot inflate its score | Scoring happens inside MPC on sealed ciphertext; the callback writes `correct` directly on the `Run` account — the runner never touches the score path |
| A run cannot swap outputs after seeing the score | `outputs_root` is committed at `create_run`; chunk hashes are fixed at `score_chunk` submission; the MPC only compares hashes — a changed output just scores 0 |
| A market cannot resolve early or wrongly | `resolve` reads `run.status == FINALIZED` and `run.correct` directly from the Sealed program's account (owner + discriminator checked) |
| An operator cannot steal the pot | Parimutuel payout is pro-rata of `amounts`/`totals`; the market account only pays `position` PDAs belonging to real bettors; no admin withdraw |
| Bets are placed without leaked score info | `bet`/`create_market` reject runs where `scored_mask != 0` — once MPC scoring starts, partial scores could leak information |
| Judges can audit a run without trusting us | `sealed prove --item i` emits a Merkle proof against the onchain `outputs_root`; the web verifier recomputes it in-browser |

## Trust assumptions

- **Arcium MPC honesty model** — Sealed inherits Arcium's security assumptions
  (t-of-n honest nodes for the executing cluster). A fully-malicious cluster
  could forge `correct`; that's the same trust model every Arcium app inherits.
- **Benchmark author honesty** — the author chooses the questions and answers.
  Sealed prevents *leakage* and *score forgery*, not a bad-faith bank (e.g.
  ambiguous questions). Reputation + published `items_root` are the mitigation;
  a public item bank can be audited out-of-band against the committed root.
- **Cluster liveness** — sealing and scoring depend on the MPC cluster
  executing computations and submitting callbacks. If the cluster stalls, runs
  stay pending; `void_market` lets the authority refund bettors on dead runs
  and `reset_sealing` frees a stuck chunk. (Observed live: devnet cluster 456
  finalized our computations but withheld callback txs during an outage.)

## What is *not* protected (yet)

- **Selective answer disclosure** — no mechanism to reveal a single contested
  item after a run. Planned: `reveal_item` circuit for dispute resolution.
- **Fee/griefing economics** — run fees are collected but not yet distributed.
- **Multi-authority benchmarks** — the bank has a single authority today.
