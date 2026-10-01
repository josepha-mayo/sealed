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
  `gen_part_private` / `score_chunk` / `reveal_part` / `reshare_part`
  under MPC and posts results back via callback transactions.
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
- **Callback delivery binding** — the score/reveal/reshare callbacks rely on
  the Arcium program's registered-account-list enforcement (queue-time
  `CallbackInstruction` accounts are replayed verbatim at delivery) plus
  deterministic inputs — every possible callback output for a queued
  computation is honest by construction. Defense-in-depth shipped: every
  mutating data account in all six callbacks now carries **self-canonical
  PDA seeds** (`seeds` re-derived from the account's own stored fields —
  `run`/`chunk`/`reveal`/`grant`/`items` must each be THE PDA their contents
  describe, not merely an account of the right type). The remaining
  contingent risk is narrower still: if upstream list enforcement weakened,
  a validly-signed output could only be misrouted to a same-bank,
  canonically-seeded `(run, chunk)`. Full closure needs a layout change
  (store the queued computation offset per pending chunk) — noted for the
  next account-version bump.
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
  hold the questions but still cannot produce answer plaintext). Markets on
  private-bank runs ("unseen-exam" markets, `scripts/unseen.sh`) inherit a
  second disclosed assumption: bettors can verify *that* an exam exists,
  is ciphertext-bound (`items_root` folds the ciphertext), and was scored
  by MPC — but cannot audit item quality, so they price the authority's
  reputation plus the cluster-rendered count. This is the same shape as
  betting on a sealed grading process in the real world, and it is why
  grant-based selective disclosure (`reshare_part`) exists as the escape
  hatch for judges who do need to read items.
- **Prefunded-PDA grief** — Solana's `create_account` rejects accounts that
  already carry lamports, so any `init`/`init_if_needed` PDA can be bricked
  by transferring 1 lamport to its seed-derived address first. The worst
  target was the shared `sign_pda_account` (one brick stalls every queue
  path). **Mitigation shipped**: `init_signer_pda` drains prefunds via
  `invoke_signed` (the program owns the seeds) then `create_account`s —
  it *un-bricks* the singleton even after a successful grief, and
  `chain init` calls it eagerly on every setup. Per-user lazy inits
  (benchmarks, runs, grants) remain griefable in theory; the blast radius
  is one bank/run id at a time and the fix is a salt/id rotation, so the
  residual is documented rather than engineered.
- **Cluster liveness** — sealing and scoring depend on the MPC cluster
  executing computations and submitting callbacks. If the cluster stalls, runs
  stay pending; `void_market` lets the authority refund bettors on dead runs
  (only while the run is pending AND unscored — no free-look cancels),
  `expire_market` lets anyone settle or reclaim stake once `resolve_by`
  passes, and `reset_sealing` frees a stuck chunk. Callbacks
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
  second escape hatch. Honest semantics — pending bits CANNOT distinguish
  "in flight" from "dead" (swept/stale computations can still land), so
  expiry is a policy bound, not a proof. `first_pending_at` is write-once
  on the first score queue and never refreshed, so a refresh-cycling
  runner cannot extend it. Past `resolve_by`, expiry acts as:
  (a) run never queued (`first_pending_at == 0`) → cancel + refund;
  (b) in-flight inside `EXPIRE_HARD_CAP_SECS` (24 h from first queue)
      → expiry blocked;
  (c) **committed** run whose landing window fully elapsed with ≥1 landed
      chunk → **settle on the proven partial score**. Commitment is
      proven by `ever_queued_mask` covering every chunk AND
      `all_queued_at` (write-once, set the moment the mask fills) being
      older than the cap — i.e. every queued chunk had a full 24 h to
      land. A queued computation executes regardless of later bit sweeps,
      so a committed stall is the cluster's fault and the partial is an
      honest sample;
  (d) past the cap on an UNCOMMITTED run (the runner withheld unqueued
      chunks — they chose where to stop), a committed run still inside
      its post-commit window, or one where nothing ever landed → cancel +
      refund. The post-commit window is load-bearing: without it a runner
      could queue chunk 0, wait past the cap, then atomically bundle
      `score_chunk` on the rest + `expire_market` — the run reads
      "committed" while the truncation point was still theirs to choose,
      and they freeze whichever bucket the partial lands in. With it, no
      transaction can both complete commitment and satisfy the window, so
      the JIT-commit is impossible. Settling a chosen truncation is never
      allowed — refunding is the only safe answer; the residual wash is
      documented below.
  For duels a leg contributes its `correct` only when finalized or a
  committed-stall past its landing window; any never-queued, uncommitted,
  or still-in-window leg cancels the whole duel — forfeiting it at 0
  would let a sybil'd ringer leg steal the other side's stake.
  A computation landing into an already-settled-or-refunded market still
  posts its score on-chain — the record stays honest either way.

- **Ladder races (`create_ladder` / `resolve_ladder`, 3–8 legs — pairs
  belong in duels, which carry an explicit tie bucket and the proven-leg
  veto).** Argmax settlement: the highest leg score takes the pot and
  co-leaders split it dead-heat pro-rata (`result_mask`). Unlike duels, a
  dead leg does NOT cancel the race — a leg with nothing landed contributes
  0 and the race resolves among the rest, because cancelling on a dead leg
  would hand every losing leg operator a free exit (poison one leg → refund
  a losing bet). A stalled leg that DID land chunks contributes its honest
  partial: `correct` is monotone non-decreasing in landed chunks, so under
  argmax a partial can only understate a leg, never inflate it (unlike
  score-band truncation, which can land a chosen low bucket). Resolution is
  gated by the unified `still_moving` check — a leg inside either window
  (first-queue `first_pending_at + 24h`, or post-commit `all_queued_at +
  24h`, both write-once) blocks rather than forfeits, before AND after
  `resolve_by` — `resolve_by` advertises the end to bettors, it is not a
  forfeit switch. Bets latch at `closes_at` (required — an open-ended board
  on a public leg list invites sniping) or the first leg leaving pending,
  whichever is earlier. Disclosed residual: an authority can pack the board
  with dormant-runner "ringer" legs whose backers' stake flows to live legs
  — forfeiture is the correct anti-exit rule, so leg-runner diligence is
  priced by bettors (the CLI prints each leg's runner/model).

- **Dark markets (`create_dark` … `claim_fee_dark`) — commit-reveal sealed
  positions.** A bettor posts `sha256("sealed/dark" ‖ market ‖ bettor ‖
  outcome ‖ amount ‖ salt)` at bet time; the outcome never touches the
  wire. Amounts are public by design (a hidden-amount market needs
  confidential SPL — noted below) — what is hidden is WHICH SIDE each
  stake sits on, so the pool, positions, and refund floor are all
  auditable while directional interest stays sealed. Winners must reveal
  within `reveal_secs` of resolution (floored at 60 s, capped at the same
  90-day horizon as `resolve_by` — an unbounded window would lock the
  pool); a no-show winner forfeits into the pot for revealed winners.
  Zero reveals cancels the market — every position refunds its public
  amount in full, no preimage needed, because a commitment nobody can
  open must not burn stake. Disclosed residuals: (a) preimage custody is
  the bettor's problem — losing the salt is equivalent to a no-show
  forfeit; the CLI prints it at bet time and on-chain data cannot
  recover it. (b) A short `reveal_secs` is visible bait — bettors see it
  before staking; markets wanting trust use 24 h+. (c) Reveals are
  public, so a whale whose side is already winning may choose not to
  reveal small positions rather than expose them — rational, priced by
  the forfeit. (d) The authority can still `void_dark` only while the
  run is untouched by scoring, and `claim_fee_dark` is gated on
  `tallied` — a resolved market that cancels pays gross refunds, so no
  fee can be skimmed from a market that owes stake back.

## What is *not* protected (yet)

- **Expiry is a bounded tradeoff, not a guarantee** — every market must set
  `resolve_by` at creation (at least 60 s out, at most `now + 90d`), so
  bettors always have a permissionless exit: refund for never-queued or
  uncommitted/early stalls, settlement on the proven partial for
  committed stalls past the landing window. Residual — a runner who never
  commits every chunk can always force a refund by withholding the rest
  (the stall-veto wash), denying winners their payout. Killing the wash
  requires distinguishing "chose to stop" from "cluster died" —
  impossible on-chain for unqueued chunks — or a slashable runner bond,
  which we deliberately left out of scope. What the commitment + window
  gate DOES kill is the theft direction: no path — including a bundled
  just-in-time commit — lets a runner convert a chosen truncation into a
  pot win.
- **Partial-settle trusts `Run.correct` mid-flight** — chunks only ever
  add, so a partial score is a strict lower bound of the true final; the
  market settles on it as the best proven truth, and only when the runner
  committed to all chunks AND that commitment aged past a full landing
  window (`all_queued_at + 24h`). Bettors accept that an MPC outage >24 h
  converts "final score" into "score at cap", and that a cancelled book
  (any empty bucket) still refunds even a committed stall — the
  `all_backed` guard is load-bearing.
- **`pending_since` is a permanent latch** — once a run queues even one
  scoring computation, `pending_since`/`first_pending_at` stay set forever
  (sweeps clear only `pending_mask`; swept callbacks can still land, so a
  zeroed mask cannot prove idleness). Consequence: a once-queued-then-
  fully-swept run can never host a market again even though its state is
  fresh — the conservative choice, since zombie risk can't be ruled out.
- **Granular answer disclosure** — `reveal_part` declassifies 8 fingerprints at
  a time at the authority's discretion. A per-item variant and threshold-gated
  reveal (e.g. after a market resolves, or multi-sig) are small extensions.
- **A reveal permanently spoils those items for scoring — now enforced
  on-chain.** The declassified `Reveal.hashes` *are* the values `score_chunk`
  compares, so after a reveal anyone can mint a run whose outputs are stuffed
  to match on those items (8 guaranteed points per revealed part). The
  protocol now closes that surface end-to-end: a landed reveal bumps
  `benchmark.reveal_count` inside `reveal_part_callback`, `create_run` stamps
  `post_reveal` on every run minted afterwards, and **all four market
  creators (`create_market`/`create_duel`/`create_ladder`/`create_dark`)
  reject flagged runs** (`PostRevealRun`) — no stake can ever be priced
  against a spoiled score. Runs committed *before* the reveal stay clean:
  their `outputs_root` predates the disclosure, which is why the flag is a
  creation-time stamp rather than a score-time check. The explorer reads the
  on-chain byte directly (timestamp inference remains as a fallback for
  pre-upgrade accounts), and `scripts/verify.mjs` cross-checks flags against
  reveal times. Residual: a run can still be *created and scored* on a
  spoiled bank — the flag makes that self-evident — and only the authority
  can reveal (public, timestamped, `PartRevealed` event). The honest
  reading: `reveal_part` is an *audit-and-burn* primitive — the authority
  publicly sacrifices those items' future scoring value to let anyone verify
  what was counted, and the burn is now machine-enforced.
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

## Adversarial market analysis — the attacks this class usually dies to

Every documented failure mode of "markets on evals" maps to a concrete
mechanism here — not a promise.

| Attack | How it plays out elsewhere | Why it fails here |
|---|---|---|
| **Oracle capture** — the resolver is bought or sybiled | UMA whale force-resolved a $7M Polymarket market wrong (Mar 2025); LMArena-style leaderboards are a website somebody controls | There is no resolver. `Run.correct` is written by the Arcium MPC callback; `resolve`/`resolve_duel`/`resolve_ladder`/`resolve_dark` are pure functions of that field. Buying the oracle means corrupting an MPC cluster, not a multisig. |
| **Benchmark gaming via selective submission** | "Leaderboard Illusion" (arXiv 2504.20879): vendors test many private variants, publish only the flattering one | The run binds `outputs_root` at `create_run` — the committed output set is pinned *before* scoring, and the score is MPC-computed over the full bank. Selective disclosure is still possible at the *submission* level (don't submit bad runs) — that's honest; the bank can be re-run and the answer-vector fingerprint makes replay detectable. |
| **Insider trading by the submitter** | The runner knows their score before the market resolves | Real and acknowledged — but bounded: (a) positions on dark markets are sha256-sealed, so an informed runner can't see the tape they're pushing against; (b) commit-reveal blocks last-block sniping — reveals must land inside a window that closes before resolution; (c) informed flow is also *signal* (Hanson & Oprea, Economica 2009): a manipulator trading on a true private score moves the price toward the truth. |
| **Wash trading** | ~25% of Polymarket volume flagged as wash in the Columbia study | The sealed layer cuts both ways: fake volume is invisible on dark markets (no public tape to fake convincingly) — but so is real manipulation. Mitigations live at the edges: creation fees, the `all_backed` rule (a market with unbacked buckets cancels rather than mis-resolving), and claim accounting that only ever pays from recorded pot lamports. |
| **Thin-market manipulation** | Low-liquidity books make price signals cheap to move | Parimutuel, not order books: there is no price to spoof, only pot share. The residual lever is last-minute pool dominance — bounded by `resolve_by` windows and by dark positions hiding *which* side is thin. |
| **Answer-key leakage after resolution** | Once the eval is public, the bank is burned forever | Audit-and-burn is *enforced*, not advisory: a landed `reveal_part` bumps `reveal_count`; every later run on that bank stamps `post_reveal=1`; all four market creators reject flagged runs (`PostRevealRun`). Spoiled exams can never silently price again. |
| **Question provenance** ("who writes the exam?") | Every private-eval incumbent (Scale SEAL, vendor self-reports) resolves to a human holding the key | On generated and private banks nobody holds a key — specs are ArcisRNG output encrypted to the MXE key at birth. Authored banks are the trust point and are labeled as such; `ShareGrant`s make the trust auditable. |

The residual trust set, stated plainly: the Arcium cluster executes the
circuits honestly (the MPC assumption), the question generator is fair
(the circuits are inspectable), and market spam is a real cost of
permissionless creation — a curated registry or creation bond is the
honest answer if spam ever materializes.

## Capability bounties — FCFS, payout to the operator, not a bettor

`create_bounty` / `claim_bounty` / `expire_bounty` escrow a sponsor-funded
pot against "first run on this bank to score ≥ threshold before deadline."
The bounty oracle is the same `Run.correct` the markets settle on — the
sponsor buys a *demonstrated* capability, not a prediction.

| Attack | Defense |
|---|---|
| **Retroactive claim** — attach a bounty to a bank that already has a qualifying run, confederate instantly claims | `bounty_qualifies` requires `run.created_at >= bounty.created_at`; a pre-existing run is ineligible forever. |
| **Window-stretch claim** — a run launched late stretches the bounty past its announced window | The deadline is total: `claim_bounty` requires `now <= deadline`, so `run.created_at <= now <= deadline` transitively bounds entry too. Past the deadline the only transition is `expire_bounty` → refund. The sponsor can quote an exact end time; there is no tail risk of a slow run sniping an un-expired pot. |
| **Wrong-bank claim** | `run.benchmark == bounty.bank` is part of the same pure gate. |
| **Bait bounty** — threshold above the bank's max (unclaimable pot used as fake marketing) | `create_bounty` reads the sealed bank's `chunk_count` and rejects `threshold > chunk_count * 32` (`InvalidThreshold`); `threshold == 0` also rejected — a landed 0 score is honest. |
| **Sponsor self-deal** — post bounty, run own model, claim own pot, advertise "X beat the bounty" | `run.runner != bounty.sponsor` — a sponsor's own run can never claim; the winner evidence is third-party or nothing. |
| **Front-run the claim tx** — MEV the permissionless claim and redirect payout | `payee` is constrained to the run's stored `runner` field (`WrongPayee`); the trigger is never the recipient. |
| **Claim on a pending/fresh run** | `bounty_qualifies` requires `RUN_FINALIZED` or the proven-partial standard (committed run past its 24h landing window with landed score evidence) — identical to market settlement. |
| **Claim on a post-reveal run** | `run_post_reveal` check — runs created after the bank's fingerprint disclosure are ineligible (`PostRevealRun`), same as markets. |
| **Double claim** | `status` flips `OPEN → RESOLVED` atomically in the claim ix; a second claim hits `MarketNotOpen`. |
| **Sponsor griefs runners** — bounty expires mid-flight | `expire_bounty` requires `now > deadline`; before that the pot is locked. Expiry `close`s the account to the *stored* sponsor — the refund can't be redirected. |
| **Score inflation** — claim needs a real score | There is no self-reported score path anywhere in the program; `correct` arrives only via the Arcium callback. |

FCFS is the deliberate scope cut: a highest-score auction needs a
nominate/contest phase and a second deadline dimension. First-qualifying-
proven-run wins is the honest version that needs no challenge state.
Live transcript: `docs/evidence/bounty-local.txt` (three on-chain bait
rejections + claim + refund).
