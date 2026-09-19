# Sealed — threat model

What each participant can and cannot do. The whole point of the design is that
nobody — including the operator — ever sees the plaintext benchmark answers
after sealing, and nobody can fabricate a score.

## Actors

- **Benchmark author** (authored banks only) — holds the plaintext bank and the
  shared encryption key until the last `seal_part` lands. After that the key can
  be discarded; the onchain state only carries MXE-encrypted ciphertexts.
  **Generated banks have no author at all** — items are minted inside MPC and
  the answer fingerprints are born as MXE ciphertext.
- **Runner** — submits a model's outputs as public hashes (`outputs_root` +
  per-chunk hashes), pays the run fee.
- **Arcium MPC cluster** — executes `seal_part` / `gen_part` /
  `gen_part_private` / `score_chunk` / `reveal_part` under MPC and posts
  results back via callback transactions.
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
| A generated bank has no answer key to leak | `gen_part` draws item specs from `ArcisRNG` inside MPC, computes answers in-circuit, fingerprints them (SHA3-256 over raw i64 bytes), and returns them `Enc<Mxe>`. Plaintext answers never exist on any machine. |
| A private bank's questions stay confidential | `gen_part_private` returns the specs as `Enc<Shared, Pack<GenPart>>` to a viewer x25519 key (the authority's, derived from their Solana keypair). `PrivItemChunk` stores ciphertext + nonce + the recipient pubkey only — a public RPC reader sees encrypted bytes. The `items_root` fold commits to the ciphertext itself (`sealed/v1/privitems` over cts‖nonce), so the mint transcript is verifiable by anyone without the key. Only the authority decrypts (`DH(viewer_priv, mxe_pub)`); a wrong key yields garbage that fails the spec range check. |
| Generated items can't be planted or pre-leaked | Specs are drawn at mint time from cluster randomness — after the benchmark is created, after models trained. No operator authored them, so nothing was cherry-picked for a favored model. |
| Generated specs are auditable | Every spec lands publicly in an `ItemChunk` account; the benchmark's `items_root` is a running SHA-256 fold over the exact spec bytes — anyone can re-render prompts and re-fold to verify. |
| A score can be spot-checked without a key | `reveal_part` declassifies one part's eight answer *fingerprints* at the authority's request — the circuit decrypts inside MPC and returns hashes, never plaintext. `chain verify` compares them to a run's committed output hashes, so anyone can recompute what `score_chunk` counted on the revealed positions. The authority chooses what to declassify; MPC mediates so even it never receives answers. |
| Questions can be disclosed selectively without publishing | `reshare_part` decrypts a private bank part inside MPC and re-encrypts the specs to a *delegate's* x25519 key — the grant lands in a per-(chunk, part, viewer) `ShareGrant` PDA, so who-can-see-what is onchain evidence. Disclosure is one-directional: the delegate decrypts with their own wallet (`DH(delegate_priv, mxe_pub)`) while the authority's key cannot open the delegate's grant, and a stranger cannot queue a reshare (`NotAuthority`). Answers never move — only the questions. The chain records *that* disclosure happened, not *what* was disclosed. |

## Trust assumptions

- **Arcium MPC honesty model** — Sealed inherits Arcium's security assumptions
  (t-of-n honest nodes for the executing cluster). A fully-malicious cluster
  could forge `correct`; that's the same trust model every Arcium app inherits.
- **Benchmark author honesty** — *authored banks only*. The author chooses the
  questions and answers; Sealed prevents *leakage* and *score forgery*, not a
  bad-faith bank. Reputation + published `items_root` are the mitigation.
  **Generated banks have no author**: the residual trust is in `ArcisRNG` — a
  malicious-but-below-threshold cluster cannot bias the draw without the
  honest nodes aborting the computation.
- **Generated-item derivability** — a *deliberate* trade-off on **public**
  generated banks only: generated specs are public, so anyone can render an
  item and compute its answer. What the construction buys is *provable
  freshness and zero key custody*, not answer secrecy at inference time (a
  "model" that evaluates specs is a calculator — markets can price that).
  **Private generated banks close the gap**: `gen_part_private` delivers the
  specs `Enc<Shared>` to the authority — prompts are then confidential to
  whoever holds that wallet, while answers remain MXE-sealed. The residual
  trust is that the authority doesn't publish the decrypted prompts (they
  hold the questions but still cannot produce answer plaintext).
- **Cluster liveness** — sealing and scoring depend on the MPC cluster
  executing computations and submitting callbacks. If the cluster stalls, runs
  stay pending; `void_market` lets the authority refund bettors on dead runs
  (only while the run is pending AND unscored — no free-look cancels),
  `expire_market` lets anyone reclaim stake once `resolve_by` passes on a run
  that never finalized, and `reset_sealing` frees a stuck chunk. Callbacks
  are bound to the recorded `sealing_offset`, so a stale computation landing
  after a reset cannot overwrite re-queued staging. (Observed live: devnet
  cluster 456 finalized our computations but withheld callback txs during an
  outage.)
- **Market settlement economics** — `claim_fee` is safe to call in any order:
  `claim` recomputes the fee from `fee_bps` rather than the zeroed
  `fees_accrued`, so early fee collection cannot strand bettor claims.
  Losing positions close for their rent; cancelled markets refund in full;
  resolved markets with any unbacked bucket cancel instead of letting dust
  lock the pot.
- **Stuck computations** — a `score_chunk` that never lands leaves
  `pending_mask` set, which freezes betting, voiding, and resolution on every
  market for that run. The runner can always `reset_pending`; once the bit is
  stale (`PENDING_TIMEOUT_SECS` = 15 min since the last queue) ANYONE may
  sweep it — a runner who disappears cannot permanently hold market stake.
  Late callbacks are idempotent (`scored_mask` rejects a second count).
  Markets also carry `resolve_by` + permissionless `expire_market` as a
  second escape hatch: expiry requires every unfinished run to be idle.
  Honest semantics — pending bits CANNOT distinguish "in flight" from
  "dead" (swept/stale computations can still land), so expiry is a policy
  bound, not a proof: a run counts idle once (a) nothing was ever queued,
  (b) `first_pending_at` — monotone, set on the first score queue, never
  refreshed — is `EXPIRE_IDLE_SECS` (1 h) past AND no pending bit is fresh
  (< `PENDING_TIMEOUT_SECS`), or (c) `EXPIRE_HARD_CAP_SECS` (24 h) elapsed
  since the first queue unconditionally. A refresh-cycling runner can
  therefore hold a market open at most one day at real computation cost
  per cycle; a computation landing into an expired market still posts its
  score on-chain (bettors are refunded, never robbed).

## What is *not* protected (yet)

- **Expiry is a bounded tradeoff, not a guarantee** — every market must set
  `resolve_by` at creation (`resolve_by <= now` is rejected, and it is capped
  at `now + 90d`), so bettors always have a permissionless refund path. But
  expiry still requires the run to be *idle* — the 24h
  `EXPIRE_HARD_CAP_SECS` is the only unconditional exit, because nothing
  on-chain can prove a computation is dead (swept/stale callbacks still
  land), so a freshly-queued computation can extend lockup up to 24h from
  the first queue before a refund opens even if it never lands. Residual:
  `resolve_by == 0` means "no deadline" to `bet` yet "never expirable" to
  `expire_market` — creation rejects it, so any future path that admits it
  would produce a pot with no refund hatch.
- **Granular answer disclosure** — `reveal_part` declassifies 8 fingerprints at
  a time at the authority's discretion. A per-item variant and threshold-gated
  reveal (e.g. after a market resolves, or multi-sig) are small extensions.
- **Private-bank prompt custody** — the authority wallet decrypts private
  specs; key compromise leaks the prompts (but never answer plaintext, which
  stays MXE-sealed). `reshare_part` already narrows exposure — the authority
  can delegate individual parts to a judge's key rather than handing over its
  own — and the `ShareGrant` trail makes every disclosure auditable. A true
  multi-viewer mint (`Enc<Shared>` to n keys at once) and threshold release
  remain small extensions.
- **Generated item families** — the mint circuit currently covers arithmetic
  expressions only. The construction generalizes to any family where the
  answer is a pure function of public spec fields; richer families are
  circuit work, not new trust assumptions.
- **Insider foresight by bank kind** — a market is only as honest as its
  outcome's pre-resolution secrecy. On *authored* and *private* banks no
  on-chain role knows both halves: the authority holds the answer key (or
  the prompts), the runner holds only their committed outputs, so neither
  can compute `correct` alone. On *generated* banks the item specs are
  public plaintext, so anyone can compute the true answers — and the runner,
  who committed `outputs_root`, can compute their final score before anyone
  bets. Generated-bank markets therefore demonstrate the resolution
  machinery but offer the runner a structural edge; markets with real stakes
  belong on authored/private banks, and duels additionally require two
  distinct runner keys (`RunnersMustDiffer`) so one runner can't control
  both legs.
- **PDA pre-funding (Solana-generic)** — sending ≥1 lamport to a
  not-yet-created PDA makes its `init` fail ("account already in use"). An
  attacker could pre-fund the *next* `["run", benchmark, run_count]` PDA and
  block that index forever. Mitigation is a known ecosystem wart (no clean
  on-chain fix); salt-based PDAs (markets, benchmarks) have workarounds.
- **Market dust + rent** — pro-rata integer division leaves remainder
  lamports, and there is no `close_market`, so a resolved market's rent +
  dust stay locked. Deliberate for now: sweeping unclaimed stake would be
  the bigger evil. A claim-window + `close_market` that sweeps only the
  remainder is a small extension.
- **Fee/griefing economics** — run fees are collected but not yet distributed.
- **Multi-authority benchmarks** — the bank has a single authority today.
