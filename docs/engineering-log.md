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
- **The fresh-ladder insta-cancel.** `resolve_ladder` gated on
  `still_moving` per leg — and a never-queued leg is never "still moving",
  so a race whose legs had ALL never started passed the gate immediately.
  argmax on all-zero forfeits produces a full mask → wash cancel — meaning
  anyone could permissionlessly cancel a just-created ladder in the next
  slot, repeatably, for one tx. Found by a parallel security audit of the
  market program; `ladder_resolvable` now additionally requires
  `now > resolve_by` when no leg ever started — the same call past the
  deadline stays the ladder's expiry path (all-forfeit → refund all).
  Regression test `ladder_resolve_gate_blocks_unstarted_race` pins the
  gate both sides of the deadline plus the started-leg escape.

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
- **Nobody had ever run the judge path cold — and CI had been red for
  15 commits without anyone noticing.** Cloning the pushed repo to /tmp
  and following the README verbatim killed the flagship replay:
  `decodeSnapshotSection` required `target/idl/*.json` — a gitignored
  build artifact — so `trails/qwen3b-private-duel.json` FAILED on a
  clean checkout, and `--snapshot web/snapshot.json` ENOENT'd under
  `yarn --cwd` because paths resolved against the package dir. The same
  missing IDL had been failing `harness:test` in CI ever since the
  trail verifier learned to bind DarkPosition bytes (that check calls
  `decodeSnapshotSection`); the badge sat red through ~15 pushes while
  local runs stayed green on the stale `target/` build. Both fixes
  shipped: `idl/` is committed as the replay floor (`loadIdl` prefers
  a real build), input paths fall back to repo-root resolution, and
  verify-all gained a cold-clone simulation stage (hides `target/idl`,
  replays a card) so it can't regress. CI went green at the same
  commit. The README's "~60 seconds" claim is now literally tested —
  and the deeper lesson stands: a green local gate can't see a
  gitignored dependency it secretly leans on.
- **Four parallel read-only audits found what solo passes kept missing.**
  A claim-vs-output sweep verified 26/26 documented numbers against
  live command output — and caught the ones that weren't: judges.md
  claimed "35/35" on a bank that can't exist (banks mint 32 items per
  chunk; the run was 32/32), judges.md's step labels were scrambled
  (two steps each named 3m/3n/3o/3p), `chain stats` printed 140 bettor
  wallets where `market sharps` printed 139 (stats summed per-kind sets,
  double-counting wallets holding plain AND dark positions — now a
  union). A verifier-coverage audit found the sharpest hole: claim and
  match cards bound receipts to decoded ScoreLog bytes but never to
  the NAMED model record — a card could say "gpt-5 vs llama" while
  embedding qwen's receipts and every check passed. All three
  implementations now bind receipts → record → on-chain modelId; the
  forged rename dies at "snapshot binding — MODEL ID MISMATCH". Same
  audit: the browser's renderAll silently dropped unknown account
  discriminators (now counted like verify.mjs), Python's tamper
  catchall called unknown kinds "rejected" without running a check
  (now fails loudly), and trail cards re-argmaxed ladder legs from
  card-declared scores instead of decoded Runs. An explorer audit
  found the demo-killer: the 15s RPC repoll re-rendered the page on
  every poll, wiping the decrypted exam and verdict mid-demo — the
  bundled-snapshot fallback now renders once. Plus nine smaller
  dead-ends (ladder-position deep links throwing, a copy button that
  claimed success with no clipboard, "null" leaking into file://
  verdict links). The audit-of-the-audit also turned up stale counts
  docs never could have caught alone: 123→138 artifacts, a 12→16 grant
  panel on the private-duel bank, anomaly severities 1/6/3 → 2/8/2.
- **Bit-parity ≠ bit-parity-on-hostile-inputs.** A five-way consistency
  audit (Python/TS/browser/Rust/arcis) proved the transcript identical
  on every committed byte — then found five edges where hostile inputs
  diverged. All closed: Python's x25519 now rejects non-canonical u and
  low-order peers like noble (a zero shared secret would derive the
  publicly-known Rescue key `[1,0,5]` — the decryption path now raises
  instead of returning a world-readable key); the vendored Rescue
  decrypt reduces ciphertext limbs before the conditional-add so
  c ≥ p can't survive unreduced; the policy-cert pct boundary is now
  `<= 0.01` on both sides (was pass-at-boundary in Python, fail in TS);
  board-card deltaPp compares exact like the TS JSON.stringify —
  which required a real `toFixed(4)` port (Decimal half-up), because
  Python's banker's `round()` drifts in the last decimal. And the
  latent protocol one: `reshare_part` took any 32-byte viewer — a
  zero key would encrypt the grant under a shared secret anyone can
  compute. `viewer != [0u8;32]` (and `author_pubkey !=` in stage_part)
  now gate both. The verifier's job is to agree on LIES too.
- **The whole-ledger checks only ever saw honest snapshots.** The
  census/invariant checks passed 1,796 accounts — all of them good.
  Now `verify.mjs` takes a snapshot path and `verify.py` takes
  `SEALED_SNAPSHOT`, and a subprocess test feeds both a mutated
  ledger (a flipped `Run.correct` byte; an alien discriminator) and
  asserts a nonzero exit with a named FAIL — not just "something
  failed", the right check fired.

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

## Judge-experience findings (competitive audit, round four)

- **The verdict block drifted from the README.** The copyable verdict the
  page emits (the block judges are told to paste) still said "all 138
  replayed" after the catalog grew to 142 — the audit's regexes pinned
  the count, but the emitted string was literal. Now the artifact total
  is parsed back from the replay output; the verdict counts itself, so
  it can't drift again. Same fix class for og:description + buttons.
- **Spelled-out counts evaded the freshness gate.** freshness.mjs pins
  `(\d+)` claims; "eleven sealed-tamper cards" / "twelve canned attacks"
  / "351 pinned bytes" lived in prose the gate never saw. Swept by hand;
  a word-number claim rule would catch the class (WORDS map exists for
  the tour-stop count).
- **No repo-side differentiation vs the Arcium market cohort.** The
  README trust table compared to HELM/Kalshi but never named Pythia,
  Epoch, or Bench — the exact projects a Cypherpunk judge pattern-
  matches first. Added as a row: they encrypt positions; Sealed encrypts
  the resolution truth. competitiveLandscape + pitch script now name
  Pythia explicitly.
- **Devnet proof was asserted, not linked.** Program IDs + the anchor
  memo tx now sit in the README status block as clickable explorer URLs;
  the repo header (homepage + topics) was unset until now.
- **The wow artifact didn't exist in embeddable form.** verified.svg is
  generated by gen-verified-svg.mjs from the audit's dumped verdict text
  — an image that can't lie, because it renders real output, not a
  mock-up. Regenerating it requires re-running the audit.
