# Sealed — agent notes

Privacy-preserving benchmark oracle + prediction markets on Solana + Arcium MPC.
Programs: `sealed` (FGVuEoWp…) owns banks/runs/circuits; `market` (8VSHkhNL…)
hosts score-band and duel parimutuel markets resolved from `Run.correct`.

## Build / test

- `anchor build` (sealed), `anchor build -p market --ignore-keys` (market; its
  keypair file address intentionally differs — do NOT `anchor keys sync`).
- `yarn test` → 11/11 mocha E2E against a RUNNING localnet; needs env
  `ARCIUM_CLUSTER_OFFSET=0 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
  ANCHOR_WALLET=~/.config/solana/id.json`. Suite salts bank ids per run
  (`SEALED_TEST_SALT=<n>` pins) so it is re-runnable on a dirty ledger.
- `yarn harness:test` → 13/13 unit. `npx tsc -p packages/harness --noEmit` → typecheck
  (exclude `build/` — arcis codegen emits invalid identifiers there).
- `node scripts/explorer-check.mjs [rpc]` → live account-parse sanity check.

## Localnet

- `arcium localnet` bootstraps everything but frequently times out on backup
  nodes and TEARS DOWN the whole stack (including the validator).
- `scripts/localnet-up.sh` relaunches validator + nodes from `artifacts/` +
  `.anchor/test-ledger`. `--wipe` for a fresh ledger — REQUIRED when sealed.so
  changes (sealed deploys immutable via `--bpf-program`; market is upgradeable
  so `solana program deploy target/deploy/market.so` works without a wipe).
- After a fresh ledger: `docker restart artifacts-arx-node-*-1
  artifacts-arcium-trusted-dealer-1` — nodes hold a stale context slot.
- MXE is genesis-baked; keygen completes when primary nodes activate. The
  readiness check is `getMXEPublicKey` — `npx tsx scripts/probe-mxe-live.mts`
  prints LIVE/PENDING (scripts/wait-mxe.sh polls it; the old byte-94
  heuristic is stale — the current layout settles at ~313 bytes).
- If MXE stalls mid-keygen (account exists, nodes up, probe PENDING):
  keygen usually COMPLETED at MPC level but was never finalized on-chain.
  `~/.config/solana/id.json` IS the `4RUW…` mint/MXE authority, so run
  `arcium finalize-mxe-keys -k ~/.config/solana/id.json -o 0 FGVuEoWp… -u localnet`
  (`requeue-mxe-keygen` errors `MxeKeysAlreadySet` when only finalization is
  missing). `activate-cluster` fails `InvalidAuthority` — cluster authority
  is None (permissionless) and it activates at genesis.
- Probe state: `npx tsx scripts/probe-mxe.mts` prints MXE/cluster lengths.

## Devnet

- Cluster offset 456. Both programs upgraded to the v4 committed-settle
  build (all_queued_at landing window) 2026-09-22: sealed
  `3a9Cgvenu3g1XJ4mnkpUHQmWjRD1trjSRHfYN4JonnYQbRNgLb2WiezmGWPqAq9LDhibSkJyuf6F2QRknAuFcHn1`,
  market `3t7b8AZPdzqa2Vxrub6gdG6g5Fby8a2rqAtLYGvfPnM12rWXFCAnYSCmvXcmo74hAde1XVLg2rXoj4CVkQHnEGNF`
  (2026-09-24 — ladder hardening: MIN_LEGS=3, unified still_moving resolve
  gate, landed-partial leg scores, cancel-mask hygiene, FeeClaimed events).
  Both upgradeable — same program IDs. Binary growth past a program-data
  account needs `solana program extend <id> 10240` FIRST (ExtendProgram
  requires >= 10240-byte steps, not just the delta).
- Accounts created under the pre-upgrade layout (e.g. bank 99004) are
  Borsh-EOF bricked — mint fresh banks on the new binaries; there is no
  migration ix.
- The shared Arcium devnet cluster finalizes computations but has an ongoing
  callback-tx outage — bank mints/scores stall pending (verified: a fresh
  `gen` queued a computation whose callback never landed). Do not claim
  devnet success until a callback-backed flow lands; the honest framing is
  "deployed + queued, cluster callback outage upstream".

## Gotchas

- `PrivItemChunk` stores `nonces` BEFORE `ciphertexts` (unlike AnswerChunk) —
  decoders in genbank.ts / tests / explorer all share this layout.
- `Pack<GenPart>` = 40 u8s in two 256-bit fields; `Enc<Shared>` decrypts via
  `x25519.getSharedSecret(ed→montgomery(secret), mxe_pubkey)` + RescueCipher.
- Real-model runs need any OpenAI-compatible endpoint via
  `SEALED_API_BASE`/`SEALED_API_KEY`/`--model`. Anonymous Pollinations
  (`SEALED_API_BASE=https://text.pollinations.ai/openai`,
  `SEALED_API_KEY=anonymous` — sends NO auth header, keyed calls are
  credit-walled) serves gpt-oss-20b BUT caps `max_tokens` at ~512 and
  credit-walls in bursts (billing notice as a normal 200 reply).
  `ModelClient` rejects provider-error signatures and `runModel` refuses an
  artifact when one reply dominates the bank; `scripts/real-model-run.sh`
  (authored bank) / `scripts/real-gen-run.sh` (MPC-minted gen bank)
  retry through the gaps (`--max-tokens 512 --concurrency 1`). Fresh
  MPC-verified evidence: run `HW5H5bT7…` scored **64/64 on-chain** on
  MPC-minted bank 6932 (the headline); run `4uns99WD…` scored 64/64 on
  authored bank 25864; the stale-artifact run `3CKnMa8X…` on the same
  bank scored 1/64 (local claim 64 — the anti-cheat demonstration, run
  via `scripts/score-artifact-insecure.mts` since `chain score` now
  rejects unbound artifacts).
- Borsh `String` fields serialize at ACTUAL length (`u32 len + bytes`), not
  `#[max_len]` — accounts are ALLOCATED at max_len but the bytes after the
  string are variable-offset. Any fixed-offset tail read past `model_id`
  (e.g. `pending_since`, `ever_queued_mask`) reads zeros; walk the length
  prefix like web/index.html does (`o += 4 + ml`).
- Ladder markets (`Ladder` account) seed `[b"ladder", legs[0], salt]` —
  legs arrive via `remaining_accounts` and are re-verified in-order on every
  read (`load_legs`). 3–8 legs (pairs are duels — explicit tie bucket +
  proven-leg veto). Leg outcome index == leg order in `legs[]`; legs that
  land nothing forfeit at 0 (never cancel), but a landed partial counts —
  `correct` is monotone under argmax. Resolution gates on the unified
  `still_moving` (first-queue AND post-commit windows, before AND after
  `resolve_by`). Runner note: `first_pending_at` is write-once — a leg that
  gaps >24h between chunk-queue txs can settle at partial early; stage all
  queue txs inside one 24h burst. Mask math: compare `mask as u16` against
  `full_leg_mask(len)` — `1u16 << 8` truncates to 0 in u8 (8-leg regression
  covered by `argmax_mask_flags_every_co_leader`, and proven live on-chain
  by `scripts/ladder8.sh` — 8 runners, ladder `Cej6nELe…` resolved 30/28/27/
  24/19/14/9/7 mask=0b1).
- Bank files are mutable on disk: re-minting an id or `chain items` rewrites
  `bank/gen-<id>.json`. A run started before a rewrite answers STALE items —
  MPC then scores it honestly but low (observed: local 64/64 → on-chain
  1/64). `RunArtifact.itemsRoot` now binds the artifact to the bank revision
  and `chain score` rejects a mismatch — never re-mint or re-fetch a bank
  while a run against it is in flight.
- Private bank JSON files contain plaintext questions — keep out of git.
