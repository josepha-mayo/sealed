# Sealed — submission evidence

Everything below is verifiable on-chain or reproducible from this repo.

## Programs

| Program | Devnet address | Status |
|---|---|---|
| sealed (benchmark oracle, Arcium MXE) | `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` | deployed; MXE initialized on cluster 456; comp defs + circuits uploaded |
| market (N-way parimutuel resolver) | `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN` | deployed (bucketed outcomes at slot 499411157; InitSpace fix redeployed `2MTjU2pH…`) |

Devnet deploy txs: sealed `5B3ksaWZ…`, market `zKHouHTc…`, MXE init `2fgATRGc…`/`2KEQqnjZ…`.

## Verified on localnet (arcium localnet, cluster offset 0)

- **Sealed bank, 320 items / 10 chunks** — `bank-8` sealed via 40 MPC re-encryption
  computations; benchmark `ExdsS5WX6xYNiE6fSDqdU8PCgbiuGirD5ttAGf1AmQTk` LIVE.
- **Real model runs through OpenCode Zen (free tier):**
  - `ling-3.0-flash-fin-free` — **58/64** (90.6%), run `BgA7Bxaq…`, MPC score == local pre-score
  - `nemotron-3.5-lightning-free` — **59/64** (92.2%), runs `GeCpoqi7…` + `2PDB8cqC…`
  - `mock/oracle-0.7` — 222/320 on the 320-item bank
- **Market lifecycle on `9NQJE5uF…`** (binary threshold 55, on pending run
  `GeCpoqi7…`): YES 0.5 SOL / NO 0.7 SOL from two wallets → MPC finalized run
  at 59/64 → `resolve` read `Run.correct` itself → outcome YES → winner
  claimed the 1.2 SOL pot + rent; loser claim rejected `NothingToClaim`.
- **N-way markets:** `create_market(salt, edges)` opens bucketed parimutuels
  (e.g. edges `[32,48]` = bands `<32`/`32–47`/`≥48`); multiple markets per run
  via `salt`. Covered by the anchor test (binary + 3-way on one MPC-scored run).
- **Output proofs:** `sealed prove --run <file> --item i` emits a Merkle proof
  that output `i` was in the committed `outputs_root`; the web explorer
  verifies it in-browser.
- **Test suite:** `yarn test` — 2/2 passing (seal+score+finalize; market
  open→bet→score→resolve→claim, plus negative paths). `yarn harness:test` — 8/8.

## Reproduce

```bash
scripts/setup-wsl.sh        # toolchain
yarn install && arcium build
scripts/e2e.sh              # arcium test on localnet
yarn --cwd packages/harness cli chain status --benchmark <pda>
python3 -m http.server -d web 8788   # explorer -> http://localhost:8788/?rpc=http://127.0.0.1:8899
```

## Devnet note (record honestly)

Programs, MXE, comp defs, circuits, and the benchmark are all live on devnet.
At submission time the shared Arcium devnet cluster (offset 456) is finalizing
computations but not submitting their callback transactions
(`callbackTransactionsSubmittedBm=0` on computation accounts
`BfPSFuZy…`/`74TL3b1x…`), so sealed-bank writes stall at the callback step.
The retry loop in `scripts/seal-devnet-retry.sh` completes sealing as soon as
the cluster recovers; the full flow is demonstrated on localnet meanwhile.
