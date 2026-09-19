# Sealed — agent notes

Privacy-preserving benchmark oracle + prediction markets on Solana + Arcium MPC.
Programs: `sealed` (FGVuEoWp…) owns banks/runs/circuits; `market` (8VSHkhNL…)
hosts score-band and duel parimutuel markets resolved from `Run.correct`.

## Build / test

- `anchor build` (sealed), `anchor build -p market --ignore-keys` (market; its
  keypair file address intentionally differs — do NOT `anchor keys sync`).
- `yarn test` → 9/9 mocha E2E against a RUNNING localnet; needs env
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
  grows to ~396 bytes, then `finalize` shrinks it to 289 = keys Set).
- If MXE stalls mid-keygen (cluster account exists, nodes up, no growth):
  keygen usually COMPLETED at MPC level but was never finalized on-chain.
  `~/.config/solana/id.json` IS the `4RUW…` mint/MXE authority, so run
  `arcium finalize-mxe-keys -k ~/.config/solana/id.json -o 0 FGVuEoWp… -u localnet`
  (`requeue-mxe-keygen` errors `MxeKeysAlreadySet` when only finalization is
  missing). `activate-cluster` fails `InvalidAuthority` — cluster authority
  is None (permissionless) and it activates at genesis.
- Probe state: `npx tsx scripts/probe-mxe.mts` prints MXE/cluster lengths.

## Devnet

- Cluster offset 456. Both programs upgraded to the hardened build on
  2026-09-19: sealed `4zNMgJno8WNfyHjfezSz2A4USkkdyofxdjWB1ouhozzNYqU8swdgnkCr46S9J2p2QBdjXDajpLfD3FMJC8JPYiUK`,
  market `5fKofCZqJFKuut4bnJTNjrkVMNKVzce469vMB77NUYpEgnUARA4XkG1GL8i1nQGxwnNG7kwYM9rZY6CzHGYbHxVq`
  (both upgradeable — same program IDs).
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
- Free model endpoint: `SEALED_API_BASE=https://text.pollinations.ai/openai`,
  model `openai` (gpt-oss-20b), `SEALED_API_KEY` any value, `--concurrency 1`
  (anonymous IPs capped at 1 in-flight request).
- Private bank JSON files contain plaintext questions — keep out of git.
