# Calibration bank — independently checkable MPC arithmetic

The strongest audit Sealed offers: a benchmark whose plaintext answers are
**public on purpose**, scored through the real MPC pipeline, then
declassified — so anyone can recompute every layer and confirm the
MPC-written score bit-for-bit. No trust in the harness, the circuit, or the
cluster's say-so required.

## The bundle

| file | what it is |
|---|---|
| `bank.json` | The authored 32-item bank (10 families) — prompts, **plaintext answers**, salts, and precomputed `answerHash` fingerprints. Bank id `77007`. |
| `run-artifact.json` | `qwen2.5-3b-instruct` (local llama.cpp) answering all 32 items — canonical replies + `outputHash` u64s + `outputsRoot` commitment. |
| `rescore.txt` | Transcript of `scripts/rescore.mjs` replaying the whole chain — **7 PASS / 0 FAIL**. |

On-chain artifacts (all in `web/snapshot.json`):

- Benchmark `CSnhf6QySv3BszDkJ47KGooUx86PBpLxxi2iDz42S8fp` (id 77007, 1 chunk, 4 sealed parts)
- Run `GnrRt5GUu6pUQXi7gyXLn7mXMbhXDdneiXbaV6LFFHvi` — **MPC wrote `correct = 7`**, `post_reveal = 0` (created while answers were still sealed)
- Four `Reveal` accounts — the declassified answer fingerprints, 8 per part
- `ScoreLog` `2YncpZ3Fib8pCAmwUpnD4B3rDtGisjm2RAsqoWePD77d` on `ModelRecord` `7mAKsLaBqXcLZNso8EXbSUWFGcDZzsqq36xRfefvCYqB`

## Replay it yourself

```bash
node scripts/rescore.mjs \
  --bank docs/evidence/calibration/bank.json \
  --run docs/evidence/calibration/run-artifact.json \
  --benchmark CSnhf6QySv3BszDkJ47KGooUx86PBpLxxi2iDz42S8fp \
  --run-pubkey GnrRt5GUu6pUQXi7gyXLn7mXMbhXDdneiXbaV6LFFHvi \
  --snapshot web/snapshot.json
```

Everything resolves from the committed snapshot — **no RPC, no localnet,
no Arcium dependency**. What it checks:

1. `answerHash = trunc64(sha256("sealed/v1/answer\0" ‖ bankId ‖ index ‖ answer))`
   recomputes for all 32 plaintext answers → matches the bank file.
2. `items_root` = Merkle over salted `itemLeaf`s → matches the file **and**
   the on-chain benchmark account.
3. Every `Reveal.hashes[j]` on-chain → equals the recomputed fingerprint at
   that global position (the MPC decrypted exactly these u64s).
4. `outputs_root` over the artifact's `outputHash` u64s → equals the
   artifact's own commitment **and** `Run.outputs_root` (proves the artifact
   is bit-for-bit what the MPC scored — no post-hoc editing).
5. **Independent rescore**: count positions where
   `artifact.outputHash == recomputed answerHash` → **7**, identical to the
   MPC-written `Run.correct`.

The MPC did not just claim 7 — the arithmetic is reproduced publicly.

## Why the ordering matters

The run was created and scored **before** any `reveal_part` landed, so
`post_reveal = 0`: the model's outputs were committed (and scored inside the
enclave) while every fingerprint was still sealed. Only then did the
authority declassify — the sequence mirrors the intended production audit:
blind scoring first, transparency on demand.

## Regenerate

```bash
yarn --cwd packages/harness tsx src/cli.ts bank build --seed calibration-77007 --id 77007 --chunks 1 --out bank/cal-77007.json
# deterministic: the rebuilt file is byte-identical to bank.json in this bundle
yarn --cwd packages/harness tsx src/cli.ts chain seal --bank bank/cal-77007.json
SEALED_API_BASE=http://127.0.0.1:8083/v1 SEALED_API_KEY=local \
  yarn --cwd packages/harness tsx src/cli.ts run --bank bank/cal-77007.json \
  --model qwen2.5-3b-instruct --concurrency 1 --max-tokens 256 --out runs/cal-qwen3b.json
yarn --cwd packages/harness tsx src/cli.ts chain score --bank bank/cal-77007.json --run runs/cal-qwen3b.json
for p in 0 1 2 3; do yarn --cwd packages/harness tsx src/cli.ts chain reveal \
  --benchmark <bench-pk> --chunk 0 --part $p; done
yarn --cwd packages/harness tsx src/cli.ts chain record --run <run-pk>
```

(Localnet + a running `llama-server` on :8083 required; see
`scripts/serve-local.sh`.)
