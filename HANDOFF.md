> Historical handoff from October 11, superseded by the published Proof Room and completed Colosseum submission. Its mid-flight tree and unfinished-video notes describe that earlier session. Current product scope: `docs/proof-room.md`; current judge path: `docs/judges.md`.

> Current status (2026-10-11): the inherited in-flight work has been audited and repaired. See docs/audit-2026-10-11.md for the frozen checks and remaining limits. The original transfer notes below describe the earlier handoff state.

> Historical Devin handoff, captured mid-audit. For the subsequent Codex repairs and verification, read docs/audit-2026-10-11.md. Do not treat the old in-flight list or test counts as current.

# Sealed — Handoff Document

**Purpose:** complete context transfer for continuing this project with a new agent. The repo is a hackathon submission; the standing goal from the owner is *"make it less generic, more creative, more prod-ready, more tailored to the hackathon, more likely to win — use subagents as many as they help."*

---

## 0. Where things live

| Thing | Path |
|---|---|
| Repo (WSL) | `/home/joseph/code/sealed` |
| Repo (Windows view) | `\\wsl.localhost\Ubuntu-24.04\home\joseph\code\sealed` |
| Hosted explorer | https://josepha-mayo.github.io/sealed/ |
| Capsule (single-file offline site) | https://josepha-mayo.github.io/sealed/standalone.html |
| Devnet programs | `sealed` = `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` · `market` = `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN` |
| Current commit | `a010385` "Second audit round…" (pushed to `main`) |
| **Uncommitted work** | **~74 modified + ~20 new files — third audit round, mid-flight (see §7)** |

IMPORTANT: `git status` currently shows a large uncommitted third-round changeset. It is **intentional and known-good work in progress**, not damage. Do not `git checkout .` or discard it. See §7 for what remains before the freeze/commit.

---

## 1. What the project is

**Sealed** — a privacy-preserving AI benchmark oracle + prediction-market protocol on **Solana + Anchor + Arcium MPC**.

**The one-line differentiation (lead with this):**
> Other Arcium/Solana market projects hide what users bet. **Sealed hides the truth it resolves on.**
> They encrypt *positions*. Sealed encrypts the *resolution truth* — the answer key the market settles against.

**Core architecture:**

- **Benchmarks** (`sealed` program): exam "banks" hold item specs + answer fingerprints on-chain, sealed under the Arcium MXE key.
  - **Generated banks (kind 1):** items minted *inside* MPC — specs drawn as secret shares via `ArcisRNG`, answers computed in-circuit, only ciphertext + a per-part SHA3-256 `spec_commitment` revealed. **No plaintext answer key ever exists.**
  - **Authored banks (kind 0):** an authority supplies answer material; sealing means no one *else* can read it (author custody caveat, documented honestly).
  - **Private banks:** ciphertext-only specs end-to-end; delegated disclosure via `reshare_part` (MPC re-encrypts to a delegate's x25519 key — questions readable by the delegate only, answers stay sealed).
- **Scoring:** runners submit model outputs → MPC `score_chunk` circuits compare them to sealed answer fingerprints → callback writes only a count to `Run.correct`. The item data never touches chain plaintext.
- **Markets** (`market` program): six parimutuel primitives settle permissionlessly off `Run.correct` — **score-band, duels, K-way ladders, unseen-exam markets, dark commit-reveal markets, capability bounties**. No referee exists to overrule.
- **Capability registry:** `record_score` folds finalized runs into persistent `ModelRecord` PDAs keyed by `sha256(model_id)`, with `ScoreLog` receipt PDAs making each run countable exactly once.
- **Evidence:** everything above is replayed offline in **three independent implementations** — TypeScript (`packages/harness`), in-browser JS (`web/index.html`), and stdlib-only Python (`scripts/verify.py`). Artifacts are `sealed-*/v1` JSON cards that re-derive every PDA and re-check every field against a committed account snapshot. The whole bundle reduces to one sha256 fingerprint, anchored in a Solana devnet memo tx.

**Honest threat model (never soften this):** Arcium confidentiality depends on an honest-majority cluster assumption — documented in `docs/threat-model.md`. The claim is "no *single* party holds the answer key", not magic trustlessness.

---

## 2. The judge experience (what the hackathon sees)

Fast paths, in order of depth:

1. **Browser, zero setup:** open the hosted explorer with `?mega=1` — the page self-replays the entire evidence bundle (203+ checks), runs the forgery lab in-page, and can **seal a verdict on devnet** (a real memo tx from a committed throwaway funded key `web/demo-anchor.json`).
2. **One line, no clone:** `curl -sL https://raw.githubusercontent.com/josepha-mayo/sealed/main/scripts/verify.py | python3 - --remote` — one stdlib Python file re-verifies every pinned byte off the hosted site, re-derives all PDAs with real ed25519 math, lands on the devnet-anchored hash.
3. **Full gate:** `scripts/verify-all.sh` — 8 stages: offline verify → headless browser audit → grant-decrypt regression → calibration rescore → recursive artifact replay → manifests → doc-count freshness → submission preflight, ending on the BUNDLE ROOT hash.
4. **Interactive moments:** `?quiz=1` lets a judge *sit the sealed exam* (their answers graded under the same fingerprint the MPC used); the forgery lab (`?tamper=`) lets them run the attacks themselves; the private-exam decrypt button ports the Rescue cipher + x25519 in-browser.

---

## 3. Build / verify commands (canonical — from AGENTS.md)

```bash
# always run from repo root (or use --cwd / relative paths shown)
anchor build                              # sealed program
anchor build -p market --ignore-keys      # market (keypair addr intentionally differs — do NOT anchor keys sync)
yarn harness:test                         # 75/75 unit tests
npx tsc -p packages/harness --noEmit      # typecheck (exclude build/)
scripts/verify-all.sh                     # THE gate — must end ALL GREEN
python3 scripts/verify.py                 # second-language replay (stdlib only)
python3 scripts/verify.py --remote        # zero-clone mode against hosted bytes
node scripts/gen-standalone.mjs --check   # capsule freshness gate
node scripts/freshness.mjs                # doc-count drift gate (24 docs scanned)
cargo check -p sealed && cargo check -p market   # fast Rust compile check
yarn --cwd packages/harness -s cli chain <cmd>   # the evidence CLI
```

Key CLI forms: `yarn --cwd packages/harness -s cli chain artifact <file|dir> [--recursive] [--tamper] [--exhibit <dir>] --snapshot ../../web/snapshot.json`. The harness CLI must run with cwd `packages/harness` when using `../../` relative paths (that's why `--dir ../../docs/evidence` appears in commands).

---

## 4. Verification philosophy (the rules this codebase enforces)

1. **Fail closed.** A card that can't bind to the account snapshot must FAIL, not verify "self-consistently". Every `if (snapPath && card.snapshotSha256)` conditional needs a corresponding missing-field failure branch.
2. **Completeness = exact set equality, never counts.** A duplicated real receipt can inflate a summed verdict while passing count checks — this was the *critical* bug found this round (§6). Multiset semantics: `want.size === got.size && got.size === list.length`.
3. **Three-language parity.** Every verifier check must exist in TS (`packages/harness/src/chain.ts`), browser (`web/index.html`), and Python (`scripts/verify.py`). A fix in one without the others is a security hole dressed as a fix — the Python `--tamper` suite and browser audit assert exhibits die at named checks in all three.
4. **Every new check ships with the attack that would have beaten the old code.** Tamper exhibits (`docs/evidence/tamper/`) are committed forgeries that MUST be rejected; `chain artifact <card> --tamper` runs the canned attacks; `--exhibit <dir>` mints new `sealed-tamper/v1` cards recording the named checks they died at.
5. **Artifact-controlled text never reaches innerHTML unescaped** (browser) and never mints fake "died-at" names (died-name extraction is anchored `^\s*(?:FAIL\b|✗)` — no `m` flag, so injected `\n✗` lines can't fake a check name).
6. **Docs can't drift.** `scripts/freshness.mjs` replays the audit's own counts (banks/runs/venues/records/receipts/artifacts/exhibits/pinned/tests/tour-stops) and fails if any of 24 docs contradicts them — including spelled-out numbers (table generated to 99).
7. **Localnet snapshot ≠ devnet execution.** `web/snapshot.json` is a frozen merged-localnet epoch (eight epochs merged); devnet has since rotated. Always state provenance — the snapshot is *replayable evidence*, the devnet anchor proves *when* it existed.

---

## 5. Audit history (three rounds, all subagent-driven)

### Round 1 (commit `e360279`) — baseline hardening
- **Critical:** private-bank mint leaked — `gen_part_private` drew item specs through *public* circuit RNG so cluster nodes saw questions+answers at mint. Fixed: specs as secret shares end-to-end, per-part `spec_commitment` on chunks + ShareGrants; delegates re-hash decrypted specs to prove they got THE committed exam.
- Six artifact kinds verified "self-consistently" without snapshot → all fail closed now.
- `sealed-ledger/v1` census card (all 1,796 raw accounts classified).
- 15 new forgery exhibits (43 total); freshness gate created.

### Round 2 (commit `a010385`) — bytecode binding + browser hardening
- Circuit card upgraded: binds actual **1.3MB deployed bytecode** (RawCircuit PDAs `[RAW, compdef, u8(idx)]`), sha256+len for all 14 Arcium accounts, BN254 BLS committee pubkey proven byte-present, node count, authority. `web/arcium-infra.json` pins it against devnet churn.
- "Anchor this verdict on devnet" button — judges send a real memo tx (`sealed-verdict/v1 <sha256>`) with funded throwaway key `web/demo-anchor.json`.
- Browser XSS closed (all artifact fields escaped), NOT FOUND pill, standalone file:// capsule fixed, sections reordered so forgery lab hits early.
- Freshness gate → 22 docs, dead-regex fixes, 37 stale numbers reconciled.

### Round 3 (UNCOMMITTED — this is the in-flight changeset) — six fresh audits
Six parallel audits ran: Rust/Anchor correctness, evidence-verifier adversarial review, browser UX, docs/narrative, Python parity, skeptical-judge positioning. Confirmed majors:

- **CRITICAL (the flagship bug):** `sealed-match/v1` receipt completeness compared **sets** while verdict aggregation summed **arrays** → duplicate a winning receipt → flipped verdict verifies in all three languages. Fixed in TS (`receipt completeness` now enforces `want.size === got.size && got.size === list.length`), minted as exhibit `dark_model-a-vs-duel_model-a.clone-a-winning-receipt-buy-the-verdict-wholesale.json` (dies at `receipt completeness`).
- `sealed-bank/v1` run/receipt surfaces had count-only equality (dup+omit hole) → exact pk-set equality + committed exhibits `sealed-test.duplicate-a-{run,receipt}-*`.
- `sealed-trail/v1` + `sealed-ceiling/v1` failed OPEN without snapshot → fail-closed now; ceiling dir-mode skips `index.json`.
- `positionVerify` duel/bounty venues fell through to `market` seeds → proper `[duel,runA,runB,salt]`/`[bounty,bank,sponsor,salt]` branches.
- `bountyVerify` `winner binding` checked only correct+runner while the qualifies-replay consumed all fields → binds every field the gate reads; `verdict.state` now bound; "dress the winner" exhibits minted (inflate score, postdate run).
- Match receipts now carry `recordedAt` (bound to ScoreLog) — "backdate a receipt" exhibit minted.
- Tamper died-name injection: extraction anchored to line-start; "inject a phantom died-at" exhibit minted proving `✗ circuit provenance` inside a model.id can't fake a death.
- `expectThrow` floor ≥12 chars (a 1-char signature was vacuous).
- `boardVerify` `totals` now recomputed; grant ciphertext length exact-match; artifact walk depth 3→8.
- **Rust:** `score_chunk` Merkle proof capped (`proof.len() ≤ 7`, new `InvalidProof` error); `Benchmark` tail-append layout invariant documented + `bench_layout_offsets` test pins status@45/chunk_count@46/kind@106; `expire_market` cancel now emits explicit sentinels (not partial `correct`/stale `outcome`); all four `void_*` emit matching cancel events; duel dead-leg free-exit documented as KNOWN RESIDUAL (cancel is correct — forfeiting enables the ringer-steal); `still_moving` bounds disclosed (~2 cap-windows OR'd, write-once `all_queued_at` truncation option, runner can pre-position).
- **Freshness gate:** spelled-number table generated to 99 (46 exhibits exceeded the old ≤32 table); recursive `docs/**/*.md` walk (evidence README had drifted); cataloged artifacts excluded from scan; `N cataloged`/`N entries`/`N artifacts across` patterns; `-` added to number lookbehinds ("epoch-2 bounty" false-positive fixed).
- **Docs:** "remove MPC" kill-table added to README (the skeptical-judge audit's top ask); item-triviality reframe (custody+integrity claim, not benchmark ceiling); cheat-catch attribution fixed (64/64→1/64 was `openai`/gpt-oss-20b, not llama); "enclave"→"MPC cluster/boundary" swept (arcium.md's legit TEE-contrast kept); anchor tx link repointed; six-primitives roster canonized (score-band was missing from README's list, "committed-settle expiry" mislabeled as a primitive); 503-total-vs-406-finalized clarified; replay.txt regenerated (a `certify-verify` emit lacked `--snapshot` and now correctly fails closed — see pending item).
- **New exhibits (11, → 57 total):** match clone-receipt + backdate-receipt, bank dup-run + dup-receipt, bounty dress-inflate + dress-postdate, claim inject-phantom. Catalog re-emitted: **216 entries / 217 replayed**.

### In-flight at handoff (background subagents were still running)
- **Python parity agent** (`verify.py`, ~1494-line diff): position verdict replay, venue PDA per kind, account binding, grant panel tally, bounty honest-path, report PDA binding, compiled-constant program IDs (SEALED_PID/MARKET_PID vs snapshot self-claim), `ledger` in KNOWN_KINDS, `snap_idx()` guards, catalog forged-path stub removal. **Diff is largely applied but agent reported still running — verify completeness.**
- **Browser agent** (`web/index.html`, ~466-line diff): sealVerdict real all-green gate, `?card=` unsafe-URL refusal, `?rpc=` provenance warning, specCommitment enforcement after decrypt, skip-blind mega fix, forge-vs-verifier-error distinction, button-state restore, reentrancy guards, cache staleness, 404 handling, finite-number guards, memo preimage/witness. **Same caveat.**

---

## 6. The critical bug class (understand this — it's the project's reason to exist)

The match-card forgery worked like this:

```
card.receipts.a = [r1, r2, ..., r14, r1]   // r1 duplicated — byte-identical, real
```

- PDA check: every pk is real ✓
- Per-entry binding: each entry equals its decoded ScoreLog ✓ (the duplicate IS the decoded log)
- Completeness: `new Set(receipts)` == expected set ✓ (Set collapses the dup)
- Verdict replay: `sum(array)` — counts r1 **twice** → inflated pool → flipped winner ✗ (was passing)

Fix: `want.size === got.size && got.size === list.length && want ⊆ got` — length catches what the Set hides. Mirrored in bank run/receipt surfaces, all three languages.

This is the class the whole evidence system exists to kill — **self-consistent lies**. A forgery that passes every local check but contradicts the complete account set. Every verifier fix this round follows the same shape: *never trust counts, never skip binding, never let card-controlled text define the outcome.*

---

## 7. What remains before the freeze/commit (in order)

1. **Verify the two port agents' work landed completely** — read the `verify.py` and `index.html` diffs against the §5 round-3 list; run `python3 scripts/verify.py`, `python3 scripts/verify.py --all` (if applicable), and the browser audit (`node scripts/audit-browser-test.mjs` — check how it's invoked in `scripts/verify-all.sh` stage 4). Add any missing checks.
2. **`scripts/gen-replay.sh` line ~73:** `gate --certify-verify` emit lacks `--snapshot` — the transcript now correctly shows FAIL (fail-closed working), but the demo transcript should show the *passing* invocation. Add `$SNAP` to the emit and regenerate, OR keep as the honest demonstration (decide — transcript currently ends red which looks bad for judges).
3. **Browser audit assertions** for the new behavior (sealVerdict internal gate, `?card=` refusal) — add to `scripts/audit-browser-test.mjs` if the browser agent didn't.
4. **Harness test pin updates:** `packages/harness/test/harness.test.ts` pins attack counts (match now 6, bank 6, bounty 3, claim 6, tamper exhibits 57, artifacts 216/217) — run `yarn harness:test`, update stale pins.
5. **Freeze cycle** (order matters):
   ```bash
   scripts/evidence-manifest.sh update   # re-hash docs/evidence → SHA256SUMS
   scripts/web-manifest.sh update        # re-hash web → MANIFEST
   # re-anchor: chain fingerprint → memo tx → docs/evidence-anchor.json
   node scripts/gen-standalone.mjs       # regenerate capsule (embeds anchor)
   ```
   The exact anchor commands are in `scripts/verify-all.sh`'s fingerprint stage and `AGENTS.md` — follow those.
6. **Full gate:** `scripts/verify-all.sh` must end ALL GREEN before commit. Expect freshness to catch residual stale numbers — reconcile them (24 docs scanned).
7. **Update AGENTS.md + docs/judges.md** for new counts/commands if the gate flags them; append a `docs/weekly-updates.md` entry matching its established format.
8. **Commit + push** — follow the repo's commit convention (`git log` for style; include `Generated with [Devin](https://devin.ai)` + co-author trailer per repo norm — see recent commits).

---

## 8. How to make it "less generic, more likely to win" (standing owner directive)

The skeptical-judge audit's verdict: *least-generic repo they'd audited* — the failure mode now isn't genericness, it's **buried wow**. Guidance:

- **Lead with the crime scene.** The "64/64 claimed, 1/64 scored" stale-artifact story is the hook — a model self-reported a perfect score, MPC scored it 1/64, and the chain never trusted the claim. That story beats any architecture diagram.
- **The "remove MPC" kill-table** (now in README) is the anti-generic argument: without MPC, generated banks have a plaintext answer key somewhere; private exams need a custodian; scoring becomes operator-signed; delegated disclosure means copying plaintext. MPC isn't garnish — it's why there's a truth to settle on.
- **Arithmetic items are a feature, not a weakness.** Reframe: custody + scoring integrity is the claim under test; item difficulty is a parameter, not the proof. (Now documented at README's Items bullet.)
- **Make the impossible demos unmissable.** The forgery lab, sealed-exam-sit, lie exhibits, and seal-verdict anchor should hit within the first screens. Don't add features that dilute "private truth → public settlement."
- **Never overclaim.** "No single party holds the key" not "trustless". Honest-majority cluster assumption stays explicit. Localnet-epoch snapshot vs live devnet is always stated. These honest caveats *are* the credibility — judges reward a threat model that admits its edges.

Candidate next creative adds (unstarted, from audit brainstorm):
- **"Adversarial demo kit"** — a pre-baked `forged-card.json` + command that lets a judge flip a verdict and watch it die, packaged as one screenshot.
- **Attack-tree artifact** — `sealed-attacktree/v1` visualizing every closed forgery class and its exhibit.
- **"Trust diff" generator** — `chain trustdiff --without-mpc` emitting the kill-table as a replayable artifact.

---

## 9. Warnings / gotchas learned the hard way

- **WSL shell quoting:** `wsl.exe bash -lc "..."` eats backticks, `${}`, and heredocs unpredictably through the wrapper. For anything non-trivial, write a script file (the `write` tool to `\\wsl.localhost\...\scripts\x.sh`) then `bash` it — do not inline heredocs.
- **`yarn --cwd` + relative paths:** the CLI resolves `../../` from `packages/harness`. Commands in scripts assume that cwd.
- **Anchor.toml:** market's keypair-file address intentionally differs from its on-chain ID — never `anchor keys sync`.
- **`target/idl` vs `idl/`:** `loadIdl()` prefers build output; verify-all cmp's them when both exist.
- **The devnet anchor link in README** is hardcoded — repoint it to `docs/evidence-anchor.json`'s `explorer` field after every re-anchor.
- **Browser test flake:** audit-browser-test caches by evidence bytes — a stale cache produces phantom fails; the cache key is intentional, don't "fix" it.
- **Tamper index.json** is a sorted filename array regenerated by script (don't hand-edit); every exhibit needs a `web/tamper/` mirror (byte-identical).
- **Don't edit cataloged artifacts** (`docs/evidence/artifacts.json` entries) — they're pinned evidence; their internal counts are owned by the verifiers, not the freshness gate (now excluded).
- **`docs/evidence/reports/*.md`** are markdown artifacts (pinned) — their per-model receipt counts are *model-scoped*, correct even when they differ from bundle totals.

---

## 10. File map (the ones that matter)

| File | Role |
|---|---|
| `programs/sealed/src/lib.rs` | sealed program — banks, chunks, runs, grants, reveals, records, callbacks |
| `programs/market/src/lib.rs` | market program — six primitives, expiry/settle, escrow, events |
| `encrypted-ixs/src/lib.rs` | Arcis circuits (gen/score/reveal/reshare — secret-share mint, spec_commitment) |
| `packages/harness/src/chain.ts` | ~9500-line evidence CLI + ALL TS verifiers + tamper defs + catalog/board/bank/match/claim/ceiling/circuit/bounty/grant/position/trail/policy/ledger/report mint+verify |
| `packages/harness/src/snapshot.ts` | offline account decoder (tolerant legacy-layout decode) |
| `web/index.html` | the explorer — all verifiers mirrored in-page + quiz + forgery lab + seal-verdict + decrypt |
| `web/standalone.html` | generated capsule — page+snapshot+artifacts inlined, file:// works |
| `web/snapshot.json` | committed account dump (the evidence ledger, frozen localnet epoch) |
| `web/arcium-infra.json` | pinned Arcium accounts (compdefs, RawCircuits bytecode, MXE, cluster BLS) |
| `scripts/verify.py` | stdlib-only Python replay — second-language verdict, `--remote` zero-clone mode |
| `scripts/verify.mjs` | offline snapshot audit (the counts freshness replays) |
| `scripts/freshness.mjs` | doc-count drift gate |
| `scripts/verify-all.sh` | the 8-stage gate |
| `scripts/audit-browser-test.mjs` | headless in-page audit regression |
| `scripts/gen-standalone.mjs` | capsule generator |
| `scripts/gen-replay.sh` | replay.txt regenerator |
| `docs/evidence/` | the committed bundle: artifacts.json catalog, tamper/, matches/, banks/, claims/, ceilings/, circuit/, policies/, positions/, bounties/, grants/, trails/, reports/, ledger/, SHA256SUMS, evidence-anchor.json |
| `docs/judges.md` · `JUDGING.md` | judge-facing paths |
| `docs/threat-model.md` | the honest trust analysis — keep it honest |
| `AGENTS.md` | canonical repo notes (counts now freshness-gated) |

---

## 11. Session notes

- Working tree is mid-freeze: **verifier fixes + exhibits + docs done; manifests/fingerprint/anchor/standalone NOT yet regenerated.** Follow §7 exactly.
- The `demo-anchor.json` / `demo-delegate.json` keypairs are *committed throwaway devnet keys* on purpose (zero-setup judge flows) — they're funded play money, not secrets. Don't "fix" them.
- The owner wants **subagent-driven work**. Dispatch parallel agents on disjoint surfaces (Rust vs TS vs Python vs browser vs docs) — but verify their diffs against the finding list; agents have missed items each round.
- Subagents on this Windows host need the **UNC path** (`\\wsl.localhost\Ubuntu-24.04\home\joseph\code\sealed`) — the `/home/...` POSIX path fails outside bash.

*Generated by Devin — session ending mid-third-audit-round. Tree state documented honestly; nothing uncommitted is lost if §7 is followed.*
