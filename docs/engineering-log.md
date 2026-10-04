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
- **Devnet claims stay honest.** Programs are deployed; the shared Arcium
  cluster's callback outage stalls bank flows upstream. The docs say
  exactly that — `verify-deployed.sh` reports STALE, not "deployed".
