# Engineering log — what broke, and what fixing it taught

A digest of the hardest failures this project hit and the fixes that
survived them. Judges score "evidence of grit"; this is the receipt trail.
Every entry here has a regression test, an evidence transcript, or both —
nothing is a claim.

## Adversarial design bugs (found in our own review, fixed before anyone hit them)

- **The JIT-commit freeze-win.** A runner could withhold all-but-one chunk
  past a market's expiry cap, then land commit+expire in one transaction to
  settle a truncation they chose. Fix: `all_queued_at` is write-once and a
  committed run settles only after `all_queued_at + 24h` — every queued
  chunk gets the same landing window, so no bundle can freeze a chosen
  partial. Committed-settle expiry exists *because* of this attack.
- **The dormant-runner free exit.** Ladder legs that land nothing forfeit
  at 0 — never cancel — because a cancellable dead leg hands every losing
  operator a refund veto. A landed partial still counts: `correct` is
  monotone under argmax so a partial can only understate.
- **Post-reveal stuffing.** After `reveal_part` declassifies fingerprints,
  a new run could commit to the now-public targets. Fix: `reveal_count`
  bumps in the callback, `create_run` stamps `post_reveal=1`, and all four
  market creators reject flagged runs — the market program *tail-reads*
  the byte so old-layout accounts still load.
- **The stale-artifact cheat.** A runner's artifact built on a re-minted
  bank file claimed 64/64 locally and scored **1/64** on-chain — MPC
  doesn't trust self-reports. Now `RunArtifact.itemsRoot` binds the
  artifact to the bank revision and the client refuses mismatches; the
  bypass still exists (`score-artifact-insecure.mts`) to prove the check
  is UX, not security — the cluster tallies honestly either way.
- **Claim-fee solvency ordering.** If the authority collects its fee
  *before* winners claim, a naive skim can strand the pot. Claims
  recompute the fee basis themselves, so collection order can't insolvent
  the tail — the regression test collects the fee first on purpose.
- **Bounty front-running.** `claim_bounty` is permissionless to *trigger*
  but `payee` is pinned to `run.runner` — a watcher who lands the claim
  tx can't redirect the pot. Plus `runner ≠ sponsor` (no self-dealing)
  and `run.created_at ≥ bounty.created_at` (no retroactive claims).
- **Leg reordering at resolve.** Ladder legs arrive as
  `remaining_accounts`; they're re-verified in-order on every read
  (`LegMismatch`), because order IS the outcome index.
- **Unbacked buckets.** A resolving market with any unbacked bucket cancels
  to gross refunds instead of stranding the pot (`expire_dark`'s
  empty-pool fast-path rides the same rule).

## Verifier-side findings (the audit auditing itself)

The forgery lab isn't decorative — running it against real inputs found
gaps in the verifiers, not just in the programs:

- **The trail card was consistency-only.** `verifyTrail` re-derived PDAs
  and replayed verdicts but never bound `run.correct` or the venue's
  escrow fields to decoded account bytes — the CLI dir sweep caught a
  forged bounty `amount` sailing through. Now every venue field binds to
  the raw account bytes in the CLI, the browser, AND the Python verifier,
  and the phantom `forfeitTotal` (a field that read a nonexistent account
  member — always 0) became real: stake on unrevealed dark positions,
  recomputed from DarkPosition bytes.
- **The `?card=`/`?forge=` headless pins rode on stale state.** The audit
  test reset `window.__auditKey` — but `__auditKey` is a module-level
  `let`, so the reset was a no-op and `maybeAudit` early-returned; the
  deep-link pins passed on leftover DOM without executing anything. The
  deep links now run once when `__audit` first appears, and the pins
  reset `__deepLinksDone` — they genuinely re-execute or they fail.
- **The exhibit verifier asked its inner verifier for JSON.** Machines
  parse JSON; the `died at:` extraction needed text-mode `FAIL <check>`
  lines — so exhibits verified with an empty `died` list until the inner
  call was forced to text output. A verdict isn't evidence if you can't
  show the check that fired.
- **The doc-freshness gate had blind spots in its own coverage.** It
  pinned "503 runs"-style account phrasings but not bundle totals —
  six stale artifact/file/stop counts survived in docs. The gate now
  pins those too, plus test-suite tallies derived from the test files
  themselves (a checker that can't see its own gaps gets strengthened,
  not trusted harder).
- **A doc "fix" almost shipped a lie.** promotion.md said "126
  positions" while the snapshot carried 137 Position accounts — an easy
  sed. But `market sharps` on the live bundle still prints "126
  surviving resolved bettors": the doc's number was right, the noun
  was wrong (bettors vs positions — exercised claims close their PDAs,
  so resolved survivors are a subset). Correction checked against the
  command output, not against my own arithmetic — the run of the
  command IS the source of truth, even for the docs about it.
- **Nobody had ever run the judge path cold.** Cloning the pushed repo
  to /tmp and following the README verbatim killed the flagship
  replay: `decodeSnapshotSection` required `target/idl/*.json` — a
  gitignored build artifact — so `trails/qwen3b-private-duel.json`
  FAILED on a clean checkout, and `--snapshot web/snapshot.json`
  ENOENT'd under `yarn --cwd` because paths resolved against the
  package dir. Both fixes shipped: `idl/` is committed as the
  replay floor (`loadIdl` prefers a real build), input paths fall
  back to repo-root resolution, and verify-all gained a cold-clone
  simulation stage (hides `target/idl`, replays a card) so it can't
  regress. The README's "~60 seconds" claim is now literally tested.

## Operational war stories (the parts docs never show)

- **Devnet write congestion + zombie buffers.** Every aborted
  `program deploy` strands a funded buffer account (~3.1 SOL each) — a
  deploy that "fails on funds" is usually blocked by its own zombies.
  `scripts/reclaim-buffers.sh` sweeps them; `deploy-market-retry.sh`
  self-reclaims between attempts, adds a priority fee, and runs detached
  because `wsl -d` session teardown silently kills children (`setsid`
  or it never happened).
- **The LockedOut wedge.** A validator killed mid-snapshot leaves a
  zero-byte `snapshot-*.tar.zst`; replaying it wedges the whole validator —
  Processed/Finalized frozen, TPU dead but stats still printing. No
  recovery: wipe and re-mint (the PDAs are seed-deterministic, so the
  calibration chain re-lands at the same addresses).
- **MXE keygen half-done.** Keygen completes at MPC level but
  `mxe_public_key` stays unset — the fix is
  `arcium finalize-mxe-keys`, not another requeue (`MxeKeysAlreadySet`
  when only finalization is missing).
- **Borsh strings are variable-length.** `#[max_len]` allocates max but
  serializes actual — every field past `model_id` shifts. That's why the
  market program reads `post_reveal` by walking the length prefix
  (`229 + model_id_len`) instead of mirroring the field.
- **The mask truncation.** `1u16 << 8 == 0` — an 8-leg ladder's
  result-mask silently dropped leg 8 until `full_leg_mask` was built in
  u16. Proven live by `scripts/ladder8.sh` (8 real legs, mask 0b1).
- **330-slot blockstore.** A localnet validator forgets blocks past ~330
  slots — `measure-cu.mjs` must read a tx's CU right after it lands, which
  is why the sweep scripts interleave `measure` calls.
- **Shared-wallet bank PDAs.** `chain score` derives the benchmark PDA
  from `--authority`, not the runner — legs under different wallets need
  `--authority <bank-authority-pk>` or the PDA doesn't exist.

## Deliberately not built (the honesty list)

- **No migration ix.** Pre-upgrade accounts EOF-brick under the new
  layout — disclosed, not hidden behind an unsafe upgrade path.
- **Uncommitted stalls refund, they don't settle.** A runner who picked
  where to stop doesn't get to freeze a favorable bucket.
- **`unbrick_pda`'s accepted risk.** A lamport-bearing uninitialized PDA
  is grief by definition — a parked honest prefund is indistinguishable
  and also gets swept. Documented, permissionless, sign-proven.
- **Devnet claims stay honest.** Programs are deployed and byte-verified
  (MATCH ×2 — the market upgrade ground through devnet congestion for
  days before a dedicated RPC landed it in minutes); the shared Arcium
  cluster's callback outage stalls bank flows upstream, and the docs
  said STALE-not-"deployed" the whole time it was true.
