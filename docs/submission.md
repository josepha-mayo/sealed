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
- **Test suite:** `yarn test` — 4/4 passing (seal+score+finalize; reveal
  declassify+audit; market open→bet→score→resolve→claim; generated-bank
  mint→live→score). `yarn harness:test` — 12/12.

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
