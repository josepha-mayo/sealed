# Sealed — submission evidence

Everything below is verifiable on-chain or reproducible from this repo.

## Programs

| Program | Devnet address | Status |
|---|---|---|
| sealed (benchmark oracle, Arcium MXE) | `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` | deployed; MXE initialized on cluster 456; comp defs + circuits uploaded. `solana -u devnet program show <id>`: last deployed slot 499939236, authority `4RUW4pDm…` |
| market (N-way parimutuel resolver) | `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN` | deployed with duel support; upgradeable under `4RUW4pDm…` |

**Deploy state:** the devnet binaries were upgraded to the current
hardened build on 2026-09-19 (sealed `4zNMgJno…`, market `5fKofCZq…` —
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
  veto a pending resolution for a refund. And a run that STARTED scoring
  then stalled past the 24h first-queue cap settles on its proven partial
  score instead of refunding — the runner cannot veto a losing market by
  withholding chunks mid-flight. Refund is reserved for runs with no
  proven signal (never queued, or zero chunks ever landed). Markets
  resolving with any unbacked bucket cancel (full refunds) instead of
  stranding the pot.
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
- **Real model through a minted bank — fresh and on the current ledger:**
  `gpt-oss-20b` (`openai` on the anonymous Pollinations tier) answered all
  64 items of MPC-minted bank 25864 (`items_root e6a614da…`); the run
  committed `outputs_root f6aa29a3…`, scored inside MPC, and finalized
  **64/64 — on-chain score identical to the local pre-score** (run
  `3CKnMa8X…`, account + artifact + Merkle proof in `docs/evidence/`).
  The same bank carries the counter-case: an earlier artifact built on a
  stale bank file claimed 64/64 locally and MPC scored it **1/64** (run
  `4uns99WD…`) — the local pre-score is never trusted, and the harness
  now binds artifacts to `items_root` to reject the mismatch outright.
  Also live from the `demo.sh` pass: generated bank 6750 scored by two
  runners (49/64 and 32/64 — the second created by a separate judge
  wallet), binary + 3-way + duel markets resolved (duel: A wins 49–32),
  and private bank 6751 whose specs exist on-chain only as ciphertext.
  Historical: bank 99003 32/32 (epoch rotated), ling-3.0 58/64,
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
- **Test suite:** `yarn test` — 9/9 passing (seal+score+finalize; reveal
  declassify+audit; market open→bet→score→resolve→claim incl. expiry,
  claim-fee-first solvency, and post-finalize expiry rejection; duel market
  open→bet→score-both→resolve→claim + gates; generated-bank mint→live→score;
  private-bank mint→decrypt→score + privacy negatives; reshare
  delegate-decrypt + one-directional disclosure + gates; delegated-runner
  rebuild-from-grants + MPC score; pending-sweep liveness — markets stay
  latched after sweeps, swept computations still land, stranger sweep
  rejected, edge bounds, double-attestation rejected, duel dead-run expiry
  bail, retired-bank mutation rejected). The suite salts bank ids per run so it's
  re-runnable on a dirty ledger (`SEALED_TEST_SALT=<n>` pins a run).
  `yarn harness:test` — 12/12.

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
build 2026-09-19 — sealed `4zNMgJno…`, market `5fKofCZq…`). The one honest
caveat: at submission time the shared Arcium devnet cluster (offset 456)
finalizes computations but is not submitting their callback transactions
(`callbackTransactionsSubmittedBm=0` on computation accounts
`BfPSFuZy…`/`74TL3b1x…`), so sealed-bank writes stall at the callback step —
most recently probed 2026-09-19: bank `SwG8c3TK…` queued gen_part for chunk 0
part 0 (computation `3w9kBpRt…`) and no callback landed. The retry loop in
`scripts/seal-devnet-retry.sh` completes sealing as soon as the cluster
recovers; the full flow is demonstrated on localnet meanwhile.
