# Mainnet deployment runbook

Sealed is mainnet-ready: the programs are upgradeable, the MXE is
parameterized by cluster offset, and Arcium operates a production
cluster on Solana mainnet-beta (offset `2026`). What follows is the
exact sequence — budget ~2–5 SOL plus MPC computation fees.

## Prerequisites

- A funded mainnet wallet: `~/.config/solana/id.json` (≥ 6 SOL —
  program deploys + program-data buffers + MXE/comp-def init + fees).
- A reliable mainnet RPC (Helius / Triton / QuickNode API key).
  Do NOT use the public `api.mainnet-beta.solana.com` for deploys —
  it drops long write streams.
- Current binaries: `anchor build && anchor build -p market --ignore-keys`.

## 1. Deploy the two Solana programs

```bash
solana program deploy target/deploy/sealed.so \
  --program-id target/deploy/sealed-keypair.json \
  -u <mainnet-rpc>

solana program deploy target/deploy/market.so \
  --program-id target/deploy/market-keypair.json \
  -u <mainnet-rpc>
```

Both programs already exist on mainnet under the same IDs if you keep
the repo keypairs; otherwise use `solana program upgrade`.

## 2. Deploy the MXE against the mainnet Arcium cluster

```bash
arcium deploy \
  --cluster-offset 2026 \
  --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url <mainnet-rpc>
```

`--recovery-set-size 4` is the documented minimum; the CLI rejects the
deploy with the required size if the cluster needs more.

## 3. Initialize computation definitions

```bash
ANCHOR_PROVIDER_URL=<mainnet-rpc> SEALED_CLUSTER_OFFSET=2026 \
  yarn cli chain init
```

This registers `gen_part`, `gen_part_private`, `seal_part`,
`score_chunk`, `reshare_part`, and `reveal_part` comp defs against the
mainnet MXE account.

## 4. Smoke test (cheap)

```bash
# mint a small generated bank inside MPC (32 items, 1 chunk)
ANCHOR_PROVIDER_URL=<mainnet-rpc> yarn cli chain gen --id <rand-id> --chunks 1
# answer it with a deterministic mock model (mock/oracle-<p>)
ANCHOR_PROVIDER_URL=<mainnet-rpc> yarn cli run --bank bank/gen-<id>.json --model mock/oracle-0.65 --out /tmp/mainnet-run.json
# create + score it — a real callback-backed mainnet MPC score
ANCHOR_PROVIDER_URL=<mainnet-rpc> yarn cli chain score --bank bank/gen-<id>.json --run /tmp/mainnet-run.json
```

If the run reaches `FINALIZED` with `correct > 0`, the pipeline is live
on mainnet end-to-end.

## Notes

- Mainnet MPC computations are billed in SOL-denominated fees at queue
  time; keep the fee-payer funded.
- Devnet's shared cluster (offset `456`) had a documented callback
  outage during development — the honest-status note in
  `docs/submission.md` covers it. The mainnet cluster is a different,
  production-grade deployment.
- Do not paste private bank JSON files into any tooling that ships to
  git — they contain plaintext questions.
