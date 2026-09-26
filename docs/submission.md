# Sealed — submission evidence

Everything below is verifiable on-chain or reproducible from this repo.

## Programs

| Program | Devnet address | Status |
|---|---|---|
| sealed (benchmark oracle, Arcium MXE) | `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` | deployed; MXE initialized on cluster 456; comp defs + circuits uploaded. `solana -u devnet program show <id>`: last deployed slot 499939236, authority `4RUW4pDm…` |
| market (N-way parimutuel resolver) | `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN` | deployed with duel + ladder + dark commit-reveal support; upgradeable under `4RUW4pDm…` |

**Deploy state:** the devnet binaries carry the current hardened build
(sealed `3a9Cgven…` 2026-09-22, market `271eYBWM…` 2026-09-25 —
`solana -u devnet program show <id>` reports the deploy slots). All protocol
features are verified end-to-end on localnet; the only devnet caveat left is
the Arcium callback outage (below).

## Verified on localnet (arcium localnet, cluster offset 0)

_Note: accounts cited in this section (`ExdsS5WX…`, `9NQJE5uF…`, `BgA7Bxaq…`,
`GeCpoqi7…`, `2PDB8cqC…`) lived on earlier localnet epochs that have
since been wiped and redeployed during hardening. The evidence bundle in
`docs/evidence/` is the current-ledger set._

- **Sealed bank, 320 items / 10 chunks** — `bank-8` sealed via 40 MPC re-encryption
  computations; benchmark `ExdsS5WX6xYNiE6fSDqdU8PCgbiuGirD5ttAGf1AmQTk` LIVE.
- **Real model runs through OpenCode Zen (free tier):**
  - `ling-3.0-flash-fin-free` — **58/64** (90.6%), run `BgA7Bxaq…`, MPC score == local pre-score
  - `nemotron-3.5-lightning-free` — **59/64** (92.2%), runs `GeCpoqi7…` + `2PDB8cqC…`
  - `mock/oracle-0.7` — 222/320 on the 320-item bank
- **Market lifecycle on `9NQJE5uF…`** (binary threshold 55, on pending run
  `GeCpoqi7…`): YES 0.5 SOL / NO 0.7 SOL from two wallets → MPC finalized run
  at 59/64 → `resolve` read `Run.correct` itself → outcome YES → winner
  claimed the 1.2 SOL pot + rent; the losing position paid 0 and closed
  (rent back — no account left behind).
- **N-way markets:** `create_market(salt, edges, fee_bps, closes_at,
  resolve_by)` opens bucketed parimutuels (e.g. edges `[32,48]` = bands
  `<32`/`32–47`/`≥48`); multiple markets per run via `salt`. Covered by the
  anchor test (binary + 3-way on one MPC-scored run).
- **Market economics + lifecycle:** `fee_bps` (≤10%) is skimmed at resolution
  and collected via `claim_fee` — solvency is order-independent (claims
  recompute the fee, so the authority collecting first cannot strand the
  pot). `closes_at` is optional (0 = until scoring starts); `resolve_by` is required
  and capped at 90 days — every market carries a permissionless refund deadline; bets reject
  after either passes. `void_market`/`void_duel` let the authority cancel
  ONLY while the run is pending and unscored (no free-look cancels);
  `expire_market` lets anyone clean up once `resolve_by` passes — but NOT
  after the run finalized (`MarketResolvable`), so a losing bettor cannot
  veto a pending resolution for a refund. A run that committed EVERY chunk
  (`all_queued_at` set) and then stalled past its 24h landing window
  settles on the proven partial score — the cluster's fault, not a chosen
  truncation. Refund covers never-queued runs, uncommitted stalls (the
  runner withheld chunks — settling a chosen truncation would let them
  freeze a favorable bucket), and fully-queued runs where nothing ever
  landed. A just-in-time commit+expire bundle is blocked because the
  post-commit window is still open. Markets resolving with any unbacked
  bucket cancel (full refunds) instead of stranding the pot.
- **Duel markets — "who mogs whom":** `create_duel(run_a, run_b, salt,
  fee_bps, closes_at, resolve_by)` opens a
  head-to-head on two pending runs of the SAME benchmark (outcomes: A wins /
  B wins / tie). Both legs must come from DISTINCT runner wallets
  (`RunnersMustDiffer` — one runner scoring both legs could trade on the
  outcome it already knows). `bet_duel` closes the book once EITHER run starts scoring, so
  no one trades on a half-known result; `resolve_duel` reads both finalized
  `Run.correct` fields and pays the winner bucket (a tie pays the tie bucket
  pro-rata); `resolved_score` packs both scores `(a << 16) | b`. Verified E2E:
  duel `9QteJLVr…` between `duel/model-a` and `duel/model-b` on a generated
  bank → MPC-scored 25–19 → outcome A-wins → winner claimed pro-rata
  (0.098 → 0.65 SOL). Negative paths proven: self-duel rejected
  `RunsMustDiffer`, post-scoring bet rejected `RunNotPending`.
- **Ladder races — K-way argmax markets:** `create_ladder(legs[3..8], salt,
  fee_bps, closes_at, resolve_by)` binds K pending runs of one benchmark
  (distinct runners, same bank — legs arrive as `remaining_accounts` and are
  re-verified on every read; pairs belong in duels, which carry an explicit
  tie bucket and the proven-leg veto). Resolution is the highest leg score;
  co-leaders split the pot dead-heat pro-rata (`result_mask` bitmask). A leg
  that lands nothing **forfeits at 0 — it can never cancel the race**,
  because cancelling on a dead leg would hand every losing leg operator a
  free exit — while a stalled leg that did land chunks scores its honest
  partial (`correct` is monotone under argmax, so a partial can only
  understate, never inflate). Resolution is gated by the unified
  `still_moving` window — a leg inside its first-queue or post-commit
  landing window blocks rather than forfeits, before AND after `resolve_by`.
  `closes_at` is required (the leg list is public; an open-ended board
  invites sniping) and `bet_ladder` latches the moment ANY leg leaves
  pending. Verified E2E: a 3-way race scored 30/20/10 by MPC → leg-0 mask
  `0b001` → winner claimed pro-rata (0.098 → 0.7 SOL); a 25/25/10 dead-heat
  → mask `0b011` → winners split the loser's stake pro-rata; a live 8-leg
  race (`scripts/ladder8.sh`) resolved 30/28/27/24/19/14/9/7 → mask `0b1`.
  Negative paths proven: duplicate leg rejected `RunsMustDiffer`,
  `closes_at=0` rejected `DeadlineTooSoon`, reordered legs at resolve
  rejected `LegMismatch`, post-latch bet rejected `RunNotPending`. Disclosed
  residual: dormant-runner "ringer" legs are priced by bettors (the CLI
  prints every leg's runner/model).
- **Generated banks — the headline feature.** `chain gen` mints a benchmark
  *inside* MPC: the `gen_part` Arcis instruction draws item specs from
  `ArcisRNG`, computes answers in-circuit, fingerprints them (SHA3-256 over
  raw i64 bytes), and returns them `Enc<Mxe>`. **The answer key never exists
  in plaintext on any machine** — nothing to stage, seal, leak, or sell.
  Specs land publicly in `ItemChunk` accounts and are folded into a running
  `items_root` commitment; anyone can re-render prompts and re-fold to verify.
  Verified E2E on localnet: 4 MPC computations minted a 32-item bank, bank
  went LIVE, `mock/oracle-0.75` scored **24/32 on-chain == local pre-score**
  (`run 2e7CfDW3…`). The anchor test also proves `stage_part` on a generated
  bank is rejected `WrongBankKind`.
- **Private generated banks — nothing onchain but ciphertext.** `chain
  gen-private` runs `gen_part_private`: the same in-MPC mint, but the item
  specs come back `Enc<Shared, Pack<GenPart>>` to the authority's x25519 key
  (derived from the Solana keypair — no extra key management). `PrivItemChunk`
  accounts store ciphertexts + nonce + recipient key only — **the questions
  never appear onchain in plaintext**, and neither do the answers. The
  `items_root` fold commits to the ciphertext stream (`sealed/v1/privitems`
  over cts‖nonce) so the mint transcript is auditable without the key.
  Verified E2E: 4 MPC computations minted a private 32-item bank → LIVE →
  CLI `mock/oracle-0.75` scored **23/32 == local pre-score** (the anchor
  suite plants 21/32); the anchor test
  proves the public-items path is rejected `WrongBankKind`, a private mint on
  a public bank fails, and a wrong-key decrypt yields out-of-range garbage.
- **Selective question disclosure (reshare_part):** the `reshare_part` circuit
  decrypts a private bank's specs inside MPC and re-encrypts them to a
  *delegate's* x25519 key — the authority can hand a judge or runner the exam
  questions without publishing them, and the `ShareGrant` PDA records
  who-can-see-which-parts onchain. The answers never move. Verified E2E: the
  delegate decrypts 8 items **identical** to the authority's view; the
  authority's own key cannot open the delegate's grant (disclosure is
  one-directional); a non-authority reshare is rejected `NotAuthority`; a
  repeat grant to the same viewer is rejected. Explorer shows the grant trail.
  The delegated-runner path is verified too: `chain delegate-bank` rebuilds a
  private bank entirely from a wallet's grants — verified byte-identical to
  the authority's own decryption (prompts, answer hashes, items_root).
- **Real model through an MPC-minted bank — fresh and on the current
  ledger:** `gpt-oss-20b` (`openai` on the anonymous Pollinations tier)
  answered all 64 items of generated bank 6932 (`EQsejQ89…`, `items_root
  c4e1c840…` — minted inside MPC; no plaintext answer key exists
  anywhere); the run committed `outputs_root 0c305939…`, scored inside
  MPC, and finalized **64/64 — on-chain score identical to the local
  pre-score** (run `HW5H5bT7…`, account + artifact + Merkle proof in
  `docs/evidence/`). The same model also scored **64/64** on authored
  bank 25864 (`items_root e6a614da…`, run `4uns99WD…`), which carries the
  counter-case: an earlier artifact built on a stale bank file claimed
  64/64 locally and MPC scored it **1/64** (run `3CKnMa8X…`) — the local
  pre-score is never trusted. The harness now binds artifacts to
  `items_root` and refuses the mismatch outright; the 1/64 run was
  reproduced via a deliberate insecure-bypass script to show the check is
  UX — MPC is the boundary.
  Also live from the `demo.sh` pass on bank 6932: mock runners 43/64 and
  28/64 (the second created by a separate judge wallet), binary + 3-way +
  duel markets resolved (duel: A wins 43–28), and private bank 6933
  (`VyAAjrsB…`) whose specs exist on-chain only as ciphertext.
  Historical: bank 99003 32/32 (earlier epoch), ling-3.0 58/64,
  nemotron-3.5 59/64 — all MPC-scored, all matching.
- **Output proofs:** `sealed prove --run <file> --item i` emits a Merkle proof
  that output `i` was in the committed `outputs_root`; the web explorer
  verifies it in-browser.
- **Spot-check audit (reveal_part):** the `reveal_part` circuit lets the
  benchmark authority declassify one part's eight answer *fingerprints* — the
  MPC decrypts inside the enclave and the callback writes hashes to a `Reveal`
  PDA, never plaintext answers. `chain verify` then compares them against a
  run's committed output hashes so anyone can recompute what `score_chunk`
  counted on the revealed positions. Verified E2E: 8 declassified fingerprints
  equal the planted answers exactly; a non-authority reveal is rejected
  `NotAuthority`; a repeat reveal is rejected.
- **Test suite:** `yarn test` — 13/13 passing (seal+score+finalize; reveal
  declassify+audit; market open→bet→score→resolve→claim incl. expiry,
  claim-fee-first solvency, and post-finalize expiry rejection; duel market
  open→bet→score-both→resolve→claim + gates; 3-way ladder open→bet→latch→
  resolve→claim + LegMismatch/DeadlineTooSoon/RunsMustDiffer gates;
  ladder dead-heat: two legs tie at 25 → result_mask 0b011 → the whole pot
  splits pro-rata; dark commit-reveal market: sealed bets → resolve →
  reveals → forfeit redistribution + tallied fee sweep, plus the void →
  preimage-free refund path; pending-sweep liveness gates)
  splits pro-rata over winning stakes, loser's claim fails;
  generated-bank mint→live→score;
  private-bank mint→decrypt→score + privacy negatives; reshare
  delegate-decrypt + one-directional disclosure + gates; delegated-runner
  rebuild-from-grants + MPC score; pending-sweep liveness — markets stay
  latched after sweeps, swept computations still land, stranger sweep
  rejected, edge bounds, double-attestation rejected, duel dead-run expiry
  bail, retired-bank mutation rejected). The suite salts bank ids per run so it's
  re-runnable on a dirty ledger (`SEALED_TEST_SALT=<n>` pins a run).
  `yarn harness:test` — 13/13.

## Reproduce

```bash
scripts/setup-wsl.sh        # toolchain
yarn install && arcium build
scripts/e2e.sh              # arcium test on localnet
yarn --cwd packages/harness cli chain status --benchmark <pda>
python3 -m http.server -d . 8788   # serve the repo root so /web/ and /docs/ resolve
# explorer -> http://localhost:8788/web/?rpc=http://127.0.0.1:8899
# offline  -> http://localhost:8788/web/?snapshot=/docs/evidence/snapshot.json
```

## Devnet note (record honestly)

Programs, MXE, comp defs, and circuits are live on devnet (program IDs above;
verify with `solana -u devnet program show`; binaries upgraded to the current
build — sealed `3a9Cgven…` (2026-09-22), market `271eYBWM…` (2026-09-25,
includes committed-settle expiry + deadline floor + hardened ladder races
+ dark commit-reveal markets)). The one honest
caveat: at submission time the shared Arcium devnet cluster (offset 456)
finalizes computations but is not submitting their callback transactions
(`callbackTransactionsSubmittedBm=0` on computation accounts
`BfPSFuZy…`/`74TL3b1x…`), so sealed-bank writes stall at the callback step —
most recently probed 2026-09-19: bank `SwG8c3TK…` queued gen_part for chunk 0
part 0 (computation `3w9kBpRt…`) and no callback landed. The retry loop in
`scripts/seal-devnet-retry.sh` completes sealing as soon as the cluster
recovers; the full flow is demonstrated on localnet meanwhile.

## Submission day (deadline: Oct 12, 2026 11:59 PM PT)

Ordered human checklist — everything else in this repo is already done.
Hard-blockers first (each is a documented DQ path in Colosseum's rules):

0. **Every team member registers on colosseum.com** — an unregistered
   member DQ's the whole team, and only ONE submission per person.
0b. **Disclose any prior work** on the form — prior code is allowed but
   undisclosed reuse is a DQ + ban. Only in-window work is judged.
1. **Fill `teamBackground`** in `docs/submission-fields.md` (founder-market
   fit is scored — real names, real credibility, why YOU for this).
2. **Record the pitch video** against `docs/pitch-video-script.md`
   (separate from the technical demo — `docs/demo.mp4` is already rendered,
   114s, upload-ready; `docs/video-script.md` covers a live re-record if
   you want one). Founder-narrated beats polished voiceover — Colosseum's
   own guide calls the pitch video the shortlist gate.
3. **Make the repo public** (Settings → General → Danger Zone → Change
   visibility). Most common disqualifier per Colosseum's own list.
4. **Enable Pages**: Settings → Pages → Source = "GitHub Actions" — the
   `.github/workflows/pages.yml` workflow then publishes `web/` to
   `https://<you>.github.io/<repo>/`; paste that bare URL into the
   submission "demo" field — no `?snapshot=` param needed, the bundled
   snapshot auto-loads (only `web/` is published).
5. **Paste the field values** from `docs/submission-fields.md` into the
   form — char counts are pre-verified against the limits. Pick up to 3
   tracks; Solana is the required one (accelerator is Solana-only).
6. **Upload both videos** (pitch + `docs/demo.mp4`).
7. **Submit ≥2 days early** — late submissions and timezone errors are
   documented DQ'd teams (deadline is Pacific Time).
8. *Cheap signal most teams skip*: **weekly 1-minute update videos** on the
   project page — Colosseum staff confirm they watch them, and silent teams
   read as abandoned to track judges (Arcium staff judge the Solana track).
9. *Optional, highest-leverage*: **mainnet deploy** per `docs/mainnet.md`
   (~21–22 SOL + a reliable RPC, cluster offset 2026 — the six on-chain
   circuits dominate the rent) — turns "deployed on devnet" into "live on
   mainnet."
10. *Optional*: post the X thread + Arcium outreach DM from
   `docs/promotion.md` — attention compounds. Arcium's narrative has
   shifted to confidential AI (Inpher acquisition, Blackthorn engine) —
   Sealed's "MPC-scored model runs" is the onchain complement; lead with
   the benchmark oracle, not "another dark prediction market" (Pythia,
   Epoch, ArxPredict already exist from Cypherpunk's sidetrack).

