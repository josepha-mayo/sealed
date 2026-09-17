# Sealed — agent notes

Privacy-preserving benchmark oracle + prediction markets on Solana + Arcium MPC.
Programs: `sealed` (FGVuEoWp…) owns banks/runs/circuits; `market` (8VSHkhNL…)
hosts score-band and duel parimutuel markets resolved from `Run.correct`.

## Build / test

- `anchor build` (sealed), `anchor build -p market --ignore-keys` (market; its
  keypair file address intentionally differs — do NOT `anchor keys sync`).
- `yarn test` → 8/8 mocha E2E against a RUNNING localnet; needs env
  `ARCIUM_CLUSTER_OFFSET=0 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
  ANCHOR_WALLET=~/.config/solana/id.json`. Suite salts bank ids per run
  (`SEALED_TEST_SALT=<n>` pins) so it is re-runnable on a dirty ledger.
- `yarn harness:test` → 12/12 unit. `npx tsc -p packages/harness --noEmit` → typecheck
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
- MXE is genesis-baked; keygen completes when primary nodes activate (account
  grows to 396 bytes).

## Devnet

- Cluster offset 456. Sealed program + all 6 comp defs/circuits deployed;
  market.so has duel support (tx 5dZQFQHd…).
- The shared Arcium devnet cluster finalizes computations but has an ongoing
  callback-tx outage — bank mints/scores stall pending. `scripts/*-retry.sh`
  loops are the armed watchers; do not claim devnet success until one lands.

## Gotchas

- `PrivItemChunk` stores `nonces` BEFORE `ciphertexts` (unlike AnswerChunk) —
  decoders in genbank.ts / tests / explorer all share this layout.
- `Pack<GenPart>` = 40 u8s in two 256-bit fields; `Enc<Shared>` decrypts via
  `x25519.getSharedSecret(ed→montgomery(secret), mxe_pubkey)` + RescueCipher.
- Free model endpoint: `SEALED_API_BASE=https://text.pollinations.ai/openai`,
  model `openai` (gpt-oss-20b), `SEALED_API_KEY` any value, `--concurrency 1`
  (anonymous IPs capped at 1 in-flight request).
- Private bank JSON files contain plaintext questions — keep out of git.
