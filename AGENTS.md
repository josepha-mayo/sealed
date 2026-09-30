# Sealed — agent notes

Privacy-preserving benchmark oracle + prediction markets on Solana + Arcium MPC.
Programs: `sealed` (FGVuEoWp…) owns banks/runs/circuits; `market` (8VSHkhNL…)
hosts score-band, duel, ladder, unseen-exam, and dark commit-reveal
parimutuel markets resolved from `Run.correct`.

## Build / test

- `anchor build` (sealed), `anchor build -p market --ignore-keys` (market; its
  keypair file address intentionally differs — do NOT `anchor keys sync`).
- `yarn test` → 13/13 mocha E2E against a RUNNING localnet; needs env
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
  market `271eYBWME2iCWwpK1NBSp4XnJ2Rs1tuPcbmPCtZKHDXgbAw5Rb3tV9qZzWBptyPsKiF27dourjs6wGsQfX96N33s`
  (2026-09-25 — dark commit-reveal markets: sealed positions, reveal window
  floored 60s / capped 90d, forfeit redistribution, tallied-gated fee claims).
  Both upgradeable — same program IDs. Binary growth past a program-data
  account needs `solana program extend <id> 10240` FIRST (ExtendProgram
  requires >= 10240-byte steps, not just the delta).
- Accounts created under the pre-upgrade layout (e.g. bank 99004) are
  Borsh-EOF bricked — mint fresh banks on the new binaries; there is no
  migration ix.
- Devnet binaries lag HEAD: the post_reveal/F1 build is committed +
  localnet-verified but a redeploy attempt hit devnet write congestion
  (buffer closed, SOL reclaimed). Deployed devnet code = the pre-F1 v4
  build above; the tail-read is forward-compatible so a redeploy can
  happen any time.
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
  `SEALED_API_BASE`/`SEALED_API_KEY`/`--model` — **including fully local
  inference**: llama.cpp's `llama-server -m <gguf> --alias <name> --port N`
  serves `/v1/chat/completions` with no key needed (`SEALED_API_KEY=local`).
  `scripts/duel-local.sh` duels two local endpoints (defaults
  :8081/`qwen2.5-1.5b-instruct` vs :8082/`qwen2.5-0.5b-instruct`) — a true
  two-real-model head-to-head with zero external API dependency.
  Anonymous Pollinations
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
  rejects unbound artifacts). `scripts/real-unseen-run.sh` runs a real
  model on a PRIVATE bank it can only see through reshare grants —
  gpt-oss-20b scored 32/32 on bank `Fa4WS8B1…` (run `9nfKSXnM…`,
  delegate `9z6CwKCQ…`; rerun on the current ledger: `qwen2.5-1.5b`
  scored 8/32 on private bank `F1owH6zE…`, run `7S9ZmxrT…`, MPC == local
  pre-score). `scripts/duel-local.sh` duels two local llama.cpp endpoints:
  `qwen2.5-1.5b` 3/32 vs `qwen2.5-0.5b` 1/32 on MPC-minted bank
  `2RPWrmbq…`, duel `7p32UT6s…` resolved A-wins and settled.
  `scripts/ladder-local.sh` races FOUR local models (qwen2.5-3b/1.5b/0.5b
  + llama-3.2-1b, `scripts/serve-local.sh` stands up all endpoints) on
  bank `BoKj4kY1…` — ladder `A4fMA7eK…` resolved `mask=0b11` (a REAL
  dead-heat: 3b and 1.5b both 6/32) and dark market `BrFdXAxY…` on leg 0
  paid a revealed winner with the sealed loser forfeiting.
  `scripts/dark-local.sh` is the double-sealed composition — a dark
  commit-reveal market on a PRIVATE bank's pending real-model run:
  private bank `8HHm4HgA…` (exam ciphertext-only + positions sealed +
  MPC score), 3b scored 5/32, dark `7TVjSaFD…` resolved `>=5`, loser
  forfeited sealed. `scripts/band-local.sh <bench> <bank-json> <model>
  <endpoint>` runs a score-band market on a private bank's pending run —
  first pass cancelled on unbacked buckets (`H3RGMd3N…`, gross refunds,
  the `all_backed` guard live), second with a full six-bucket book
  resolved `[1] 1–7` on 0.5b's 2/32 (`497kuApd…`).
  `scripts/duel-private.sh <bench>` runs the blind private duel — two
  grant-delegates race different models on the same ciphertext-only
  bank: 3b 5/32 vs 1.5b 4/32, duel `EHiTUjmP…` resolved A-wins. Bank
  `8HHm4HgA…` now carries 6 runs + 12 grants (4 to a delegate whose
  keypair was overwritten mid-first-attempt — orphaned grants are
  permanent records, not sessions). WSL gotchas learned the hard way:
  llama.cpp needs `setsid` to survive the `wsl -d` wrapper teardown,
  and `/mnt/d` 9P reads D-state under concurrent mmap — serve models
  from ext4 (`~/models`). All transcripts in
  `docs/evidence/` (`duel-local.txt`, `ladder-local.txt`,
  `unseen-local.txt`, `dark-local.txt`, `band-local*.txt`,
  `duel-private.txt`). Every market
  primitive has now settled a real model's MPC-written score.
  Small-model arithmetic scores are genuinely weak —
  that IS the evidence: the benchmark measures, not flatters.
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
- Dark markets (`DarkMarket`/`DarkPosition`) are commit-reveal: the bet tx
  carries only `sha256("sealed/dark" ‖ market ‖ bettor ‖ outcome u8 ‖
  amount u64le ‖ salt32)`; the outcome never hits the wire. PDA seeds:
  `["dark", run, salt]` and `["darkpos", market, bettor, pos_salt]`.
  `reveal_secs` is floored at 60s and capped at 90d (an unbounded window
  locks the pool — the cap exists because `resolve_dark` adds
  `now + reveal_secs` under overflow-checks). Winners reveal inside the
  window; no-shows forfeit into the pot; zero-reveals cancels → gross
  refunds (no preimage needed). `claim_fee_dark` requires `tallied` — a
  resolved market that later cancels owes gross refunds, so a fee swept
  early would insolvent the tail. Positions close on claim (rent returns);
  `revealed == 255` is the sealed sentinel, so `reveal_dark` rejects
  `outcome >= n_outcomes`.
- `reveal_part` is audit-and-burn, enforced on-chain: the published
  `Reveal.hashes` are the exact u64s `score_chunk` compares. A landed reveal
  bumps `benchmark.reveal_count` in the callback; `create_run` then stamps
  `run.post_reveal=1` and all four market creators reject flagged runs
  (`PostRevealRun`). Only reveal on banks you don't intend to score again —
  and note the reveal test must run LAST in `tests/sealed.ts` for the same
  reason (it spoils AUTH_ID for anything after it). `Benchmark`/`Run` got
  tail-appended fields (`reveal_count`, `post_reveal`); pre-upgrade accounts
  EOF-brick under `Account<T>` — same no-migration stance as before. The
  market program tail-reads the flag at `229 + model_id_len` rather than
  mirroring the field, so old-layout runs still load (flag absent ⇒ 0).
- `pending_since` refreshes on EVERY `score_chunk` for the run — a public
  third-party sweep of an older dead bit waits ~15 min past the LAST queue,
  not the dead bit's own queue time (runner self-sweep is always allowed;
  the market-side 24 h `first_pending_at` cap bounds everything anyway).
- `Benchmark.priv_viewer` is pinned when the first `gen_part_private` is
  QUEUED (not when its callback lands). If that computation dies
  permanently the bank can only be re-minted under the same viewer key —
  there is no `reset_priv_viewer`. Self-inflicted edge only.
- Private bank JSON files contain plaintext questions — keep out of git.
- `web/vendor/rescue.mjs` is the Rescue cipher extracted verbatim from
  `@arcium-hq/client` build (noble-only span); the explorer's "decrypt with
  demo delegate key" button uses it + `web/demo-delegate.json` (THROWAWAY
  localnet keypair, committed on purpose) to decrypt `ShareGrant` ciphertexts
  in-browser. `snapshot.mjs` embeds `meta.mxe_x25519` (cluster pubkey) so the
  shared secret can be rebuilt client-side. Regression:
  `scripts/decrypt-grants-test.mjs` — fully offline, pinned spec digest, CI.
- The demo delegate (`Cr2bbdGh…`) holds grants on private bank `8HHm4HgA…`
  chunk 0 parts 0-3. If that bank is ever re-minted or the ledger wiped,
  re-grant + regenerate the snapshot or the decrypt button will error.
