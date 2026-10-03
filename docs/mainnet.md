# Mainnet deployment runbook

Sealed deploys to Solana mainnet-beta against Arcium's production MPC
cluster (offset `2026` — devnet is `456`, localnet `0`). Both programs are
upgradeable and deploy under the repo's `target/deploy/*-keypair.json`
addresses — the same IDs used on devnet:

- `sealed` — `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` (Anchor program **plus** an Arcium MXE account bound to cluster 2026)
- `market` — `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN` (plain Anchor program — it has no circuits, so **no MXE**)

Unlike localnet — where the sealed MXE is genesis-baked — on mainnet
everything is created by the sequence below, mirroring
`scripts/deploy-devnet.sh`. Neither program ID exists on mainnet today;
this is a fresh deploy, not an upgrade.

**Budget ≈ 21–22 SOL of rent + per-computation fees** (breakdown in §6).
Rent is recoverable by closing accounts (§7); computation fees are not.

## 0. Prerequisites

- Toolchain: `arcium` 0.14.x, `solana` 3.x, `anchor` 1.0.x, node + yarn.
  `scripts/setup-wsl.sh` installs the lot on Ubuntu 24.04 / WSL2.
- A funded mainnet keypair — this becomes the program upgrade authority
  AND the MXE authority: `~/.config/solana/id.json` with **≥ 24 SOL**.
- A dedicated mainnet RPC (Helius / Triton / QuickNode key). Do **not**
  use `api.mainnet-beta.solana.com` for deploys — the public endpoint
  drops long write streams (Arcium's deployment docs warn about this too).
- Fresh binaries + circuits, built from the repo root:

  ```bash
  yarn install
  arcium build                          # sealed.so + target/idl + build/*.arcis circuits
  anchor build -p market --ignore-keys  # market.so — its keypair address intentionally
                                      # differs; never `anchor keys sync` it
  ```

Export the environment once — every command below uses it:

```bash
cd <repo root>
export RPC="https://<your-mainnet-rpc>"              # dedicated endpoint, NOT the public one
export ANCHOR_PROVIDER_URL="$RPC"                    # harness RPC (chain.ts setup())
export ANCHOR_WALLET="$HOME/.config/solana/id.json"  # harness wallet: deployer + authority
export SEALED_CLUSTER_OFFSET=2026                    # Arcium mainnet cluster offset
export ARCIUM_CLUSTER_OFFSET=2026                    # same value; the getArciumEnv() fallback reads this
solana config set --url "$RPC" --keypair "$ANCHOR_WALLET"
solana balance                                       # want ≥ ~24 SOL
CLI="yarn -s --cwd packages/harness cli"
```

What the harness actually reads (`packages/harness/src/chain.ts` `setup()`):

- `ANCHOR_PROVIDER_URL` (default `http://127.0.0.1:8899`), `ANCHOR_WALLET`
  (default `~/.config/solana/id.json`), `SEALED_CLUSTER_OFFSET` (falls back
  to `getArciumEnv().arciumClusterOffset`, i.e. `ARCIUM_CLUSTER_OFFSET` —
  export both, like the devnet scripts do).
- `SEALED_PROGRAM_ID` / `MARKET_PROGRAM_ID` override the program IDs baked
  into `target/idl/*.json` — needed **only** if you deploy under different
  addresses; the checked-in IDLs already carry the two addresses above.
- There is no `SEALED_RPC` — the RPC env var is `ANCHOR_PROVIDER_URL`.
- `yarn --cwd packages/harness cli` runs the script with `packages/harness`
  as its working directory, so relative `bank/…` and `runs/…` paths land
  under `packages/harness/` — fine, as long as later commands use the same
  relative path (they resolve identically).

## 1. Deploy the sealed program + initialize its MXE

One command does both: `arcium deploy` deploys `target/deploy/sealed.so`
(upgradeable, under `target/deploy/sealed-keypair.json` → program ID
`FGVuEoWp…`, same as devnet) and initializes the MXE account bound to
cluster `2026`, which queues the MXE keygen computation on the cluster.

```bash
arcium deploy --cluster-offset 2026 --recovery-set-size 4 \
  -n sealed \
  --keypair-path "$ANCHOR_WALLET" --rpc-url "$RPC"
```

- `-n sealed` selects the workspace program (binary + keypair under
  `target/deploy/`). To pin the address explicitly, add
  `--program-keypair target/deploy/sealed-keypair.json` (this is the
  default it resolves anyway).
- `--recovery-set-size 4` is the documented minimum. If cluster 2026
  requires more, the CLI rejects the deploy and prints the required
  value — re-run with it.
- `--keypair-path` **must** sign as the deployed program's current upgrade
  authority (Arcium requirement — an immutable program can never
  initialize an MXE). With the command above the program deploys
  upgradeable under your wallet, so this holds.
- Interrupted mid-way (dropped tx, RPC timeout)? Re-run with `--resume`.
- Program already deployed but MXE never initialized? Re-run with
  `--skip-deploy`, or use the standalone form (note the different offset
  flag — `init-mxe` takes `-f`, `deploy` takes `-o`):

  ```bash
  arcium init-mxe -p FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ \
    -f 2026 -r 4 -k "$ANCHOR_WALLET" -u "$RPC"
  ```

## 2. Deploy the market program

Plain upgradeable deploy — market has no Arcium circuits, so no MXE step:

```bash
solana program deploy target/deploy/market.so \
  --program-id target/deploy/market-keypair.json --url "$RPC"
```

## 3. Wait for MXE keygen

Step 1 queued the MXE keygen computation on cluster 2026; the MXE's x25519
public key appears on-chain when the cluster finalizes it. Poll until LIVE
(this is the same `getMXEPublicKey` check the harness gates on):

```bash
scripts/wait-mxe.sh    # polls probe-mxe-live.mts using $ANCHOR_PROVIDER_URL / $ANCHOR_WALLET (~15 min cap)
# or one-shot:
npx tsx scripts/probe-mxe-live.mts "$RPC" "$ANCHOR_WALLET"   # prints LIVE or PENDING
arcium mxe-info FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ -u "$RPC"  # status, keys, recovery peers
```

If it sits on PENDING — the keygen computation expired from the mempool,
or MPC keygen finished but the result was never finalized on-chain (both
observed on localnet; fixes, in order):

```bash
arcium requeue-mxe-keygen -k "$ANCHOR_WALLET" -o 2026 \
  FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ -u "$RPC"
arcium finalize-mxe-keys -k "$ANCHOR_WALLET" -o 2026 \
  FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ -u "$RPC"
```

(`requeue-mxe-keygen` errors `MxeKeysAlreadySet` when only finalization is
missing — run `finalize-mxe-keys` in that case.)

## 4. Register computation definitions + upload circuits

```bash
$CLI chain init
```

Registers the six comp defs — `seal_part`, `score_chunk`, `gen_part`,
`gen_part_private`, `reveal_part`, `reshare_part` — against the mainnet
MXE and uploads each compiled circuit from `build/<name>.arcis` into the
comp def's on-chain circuit accounts (~1.36 MB of circuit rent total).
`chain init` fetches the MXE account first, so step 1 must have completed;
it is **safe to re-run** — comp defs whose circuits finished uploading are
skipped, partial uploads resume where they stopped.

## 5. Smoke test (real mainnet MPC, ~5 computations)

Mint a small MPC-generated bank, answer it offline with the deterministic
mock model, and score it on-chain. One chunk = 32 items = 4 `gen_part`
computations + 1 `score_chunk` computation:

```bash
BID=$((RANDOM))                                               # fresh u32 bank id
$CLI chain gen --id "$BID" --chunks 1                         # → bank/gen-$BID.json (under packages/harness/)
$CLI run --bank "bank/gen-$BID.json" --model mock/oracle-0.65 --out "runs/mainnet-smoke-$BID.json"
$CLI chain score --bank "bank/gen-$BID.json" --run "runs/mainnet-smoke-$BID.json"
```

- `chain gen` prints the benchmark PDA and ends with `status=LIVE` once all
  4 parts mint. `--fee-lamports <n>` would set the per-run fee the bank
  authority charges; default 0 is right for a smoke test.
- `run` with `mock/oracle-0.65` is fully offline — no `SEALED_API_*` keys
  needed. (For a real model later: `--model <provider/model>` with
  `SEALED_API_BASE`/`SEALED_API_KEY`, or `OPENROUTER_API_KEY` /
  `OPENAI_API_KEY` as fallbacks.)
- `chain score` creates the Run account, queues the scoring computation,
  and ends with `run <pda> FINALIZED: NN/32` — a real callback-backed
  mainnet MPC score. `chain score` also takes `--authority <pubkey>` when
  the scoring wallet isn't the bank authority, and `--create-only` to park
  a pending run for a market.

If the run reaches `FINALIZED`, the pipeline is live on mainnet
end-to-end. Check the leaderboard with
`$CLI chain status --benchmark <benchmark-pda>` — then enroll the score
into the persistent registry and print it:

```bash
$CLI chain record --run <run-pda>     # ScoreLog receipt + ModelRecord aggregate
$CLI chain modelrec mock/oracle-0.65  # the record, keyed by sha256(model_id)
```

`record_score` is permissionless — any wallet can enroll any finalized
run, the receipt makes it countable exactly once, and `model_id` stays a
claim (weigh `vouched_at_record`, not the string).

## 6. What the deploy costs

Rent-exempt balances (recoverable later by closing — see §7), measured
against the current `arcium build` artifacts (~6,960 lamports/byte):

| Item | Bytes | ≈ SOL |
|---|---|---|
| `sealed` program + program-data | 1,065,432 | ~7.4 |
| `market` program + program-data | 611,056 | ~4.3 |
| 6 on-chain circuits (`build/*.arcis`) | 1,363,118 | ~9.5 |
| MXE account + LUT + comp-def headers + recovery | — | ~0.5 |
| **One-time total** | | **~21.7** |

Plus **per-computation fees**, paid in SOL each time a computation is
queued (every `gen_part`/`seal_part`/`score_chunk`/`reveal_part`/
`reshare_part` call): the cluster's base price-per-CU × the comp def's CU
amount, plus any priority price, plus a fixed callback-submission reserve.
The CU price is set per epoch by node-operator vote — inspect the current
one with `arcium fee-proposals 2026 -u "$RPC"`. Fees split 70% node
operators / 20% recovery peers / 10% network treasury. The §5 smoke test
queues 5 computations; a 10-chunk (320-item) bank mint is 40.

Arcium's docs quote "2–5 SOL" for a typical deploy — that assumes small
circuits; this project uploads six circuits totalling ~1.36 MB plus two
programs totalling ~1.68 MB, which is why the real figure is ~22 SOL.

## 7. Verify / roll back

Verify the deploy:

```bash
solana program show FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ --url "$RPC"
solana program show 8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN --url "$RPC"
# both report: upgradeable, authority = your wallet, last-deployed slot

arcium mxe-info FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ -u "$RPC"  # MXE status + keys
arcium mempool 2026 -u "$RPC"            # live computations in the mainnet mempool
arcium computation 2026 <offset>         # inspect one queued/finalized computation
```

(`scripts/probe-mxe.mts <rpc>` prints MXE + cluster account lengths, but
its cluster offset is hardcoded to localnet `0` — edit the
`getClusterAccAddress(0)` call to `2026` for a mainnet probe, or just use
`probe-mxe-live.mts`, which derives everything it needs.)

Upgrade an existing program (same program ID, authority = your wallet):

```bash
solana program deploy target/deploy/sealed.so \
  --program-id target/deploy/sealed-keypair.json --url "$RPC"
# if the new binary outgrows the program-data account, extend FIRST —
# ExtendProgram moves in ≥ 10240-byte steps, not just the delta:
solana program extend FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ 10240
```

Recover from a stuck flow (no redeploy needed):

- Interrupted `arcium deploy`/`init-mxe` → re-run with `--resume`.
- Interrupted `chain init` → just re-run it (idempotent).
- A part stuck mid-mint/seal by a dropped computation →
  `$CLI chain reset-sealing --bank-id <n> --chunk <i>`, then re-run `gen`/`seal`.
- A scoring bit stuck → `$CLI chain reset-pending --run <pk> --chunk <i>`
  (the runner can sweep anytime; anyone can after ~15 min stale).
- Queued computations expire after 180 mempool slots; their fee is
  reclaimable via the `reclaimExpiredComputationFee` client instruction.

Tear down and reclaim rent (only if abandoning the deployment — comp-def
deactivation is **irreversible**):

```bash
# per comp def: deactivate (irreversible), wait 180 slots, close, close buffers
arcium deactivate-computation-definition -o <comp-offset> -p FGVu… -k "$ANCHOR_WALLET" -u "$RPC"
arcium close-computation-definition       -o <comp-offset> -p FGVu… -c 2026 -k "$ANCHOR_WALLET" -u "$RPC"
arcium close-computation-definition-buffers -o <comp-offset> -p FGVu… -i <raw-circuit-index> -k "$ANCHOR_WALLET" -u "$RPC"   # on-chain circuits: one call per buffer index
# once all user comp defs are closed:
arcium close-mxe -p FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ -k "$ANCHOR_WALLET" -u "$RPC"
# program + program-data rent back:
solana program close FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ --bypass-warning --url "$RPC"
```

Comp-def offsets for the `-o` flag (`sha256(name)` truncated to a LE u32 —
`getCompDefAccOffset` in `@arcium-hq/client` computes them):

| comp def | offset |
|---|---|
| `seal_part` | 377626190 |
| `score_chunk` | 22757050 |
| `gen_part` | 233748648 |
| `gen_part_private` | 3168202308 |
| `reveal_part` | 2697492279 |
| `reshare_part` | 2733337506 |

## 8. Caveats (honest version)

- **The mainnet cluster is a different deployment than devnet's.** The
  shared devnet cluster (offset `456`) had a documented outage during
  development: it finalized computations but never submitted their
  callback transactions, so bank mints/scores stalled pending — see the
  "Devnet note" in `docs/submission.md`. No mainnet incident is known,
  but the same *class* of failure is possible: if a queue lands but the
  callback never does, watch `arcium computation 2026 <offset>` /
  `arcium mempool 2026 -u "$RPC"` and use the §7 recovery commands rather
  than redeploying.
- **Generated-bank privacy scope:** `chain gen` items are public specs —
  the answers are computable by anyone who renders them. What MPC minting
  buys is provable freshness and zero answer-key custody; use
  `chain gen-private` (specs encrypted to your key) when question secrecy
  matters.
- **Bank files are mutable:** re-minting an id or re-fetching `chain
  items` rewrites `bank/gen-<id>.json`. A run started before a rewrite
  answers stale items — `chain score` now rejects the `items_root`
  mismatch. Never re-mint while a run is in flight.
- **Private bank JSON contains plaintext questions** — keep it out of git
  and out of any tooling that ships data anywhere.
- MXE authority == deployer wallet: whoever holds `$ANCHOR_WALLET`
  controls upgrades, comp-def lifecycle, and `finalize-mxe-keys`. For a
  production deployment consider moving authority to a multisig — newer
  Arcium CLI releases document `arcium set-mxe-authority` for this (not in
  0.14.1; check `arcium --help` on your installed version).

<!--
Sources (verified 2026-10):
- https://docs.arcium.com/developers/deployment — `arcium deploy` handles program deploy + MXE init; offsets 456 (devnet) / 2026 (mainnet); --recovery-set-size minimum 4 with CLI-printed required size; --resume/--skip-deploy/--skip-init; --keypair-path must be the program's current upgrade authority; dedicated RPC required; comp-def deactivate→TTL→close + close-computation-definition-buffers + close-mxe lifecycle; [clusters.mainnet] offset 2026 for `arcium test --cluster mainnet`.
- https://docs.arcium.com/computations/pricing-and-incentives — fee = cluster base price/CU × comp-def CU + priority price + callback compute-budget cost + fixed callback reserve; CU price voted per epoch; mempool 180-slot expiry; reclaim via reclaimExpiredComputationFee.
- https://docs.arcium.com/developers/js-client-library — getComputationFee / getComputationFeeFromQueueTx.
- https://www.arcium.com/tokenomics — computation fees paid in SOL, split 70% node operators / 20% recovery nodes / 10% treasury.
- `arcium` 0.14.1 `--help` output on the deploy machine — flag spellings used above: deploy `-o` offset / `-r` recovery / `-n` program-name / `-p` program-keypair; init-mxe `-f` offset / `-p` callback-program; mxe-info <pid> -u; mempool <offset> -u; computation <cluster> <offset>; fee-proposals <offset> -u; requeue-mxe-keygen / finalize-mxe-keys -k -o <pid> -u; close-* flag shapes.
- packages/harness/src/chain.ts (setup() env vars, init() idempotent comp-def + uploadCircuit flow, chainMain arg names) and packages/harness/src/cli.ts usage text.
- packages/harness/src/models.ts — SEALED_API_BASE / SEALED_API_KEY (+ OPENROUTER_API_KEY / OPENAI_API_KEY fallbacks), mock/oracle-<p> offline model.
- scripts/deploy-devnet.sh — the devnet sequence this runbook mirrors (arcium deploy -n sealed → solana program deploy market → chain init); its cost comment (~13 SOL) predates the current larger binaries — §6 recomputes from the artifacts on disk.
- scripts/wait-mxe.sh + scripts/probe-mxe-live.mts + scripts/probe-mxe.mts — MXE readiness probe semantics and argv.
- Comp-def offsets in §7 computed locally: Buffer.from(getCompDefAccOffset(name)).readUInt32LE() against @arcium-hq/client 0.14.1.
-->
