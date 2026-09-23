# Security policy

Sealed is a privacy protocol — answer keys are confidential by design, so
report channels matter more than usual.

## Reporting a vulnerability

- **Do not open a public issue** for anything that could leak answer
  material, break market settlement, or steal escrowed lamports.
- Preferred: a private report to the maintainer (see the repository
  profile for contact) or the Colosseum hackathon channel while the
  submission window is open.
- Include: affected program/instruction, a minimal repro or account
  layout, and whether it touches MPC circuit code (`encrypted-ixs/`) or
  the on-chain programs (`programs/`).

## Scope

- `programs/sealed` — banks, chunks, runs, grants, reveals, MPC callback
  gating.
- `programs/market` — score-band markets, duels, ladder races, positions,
  claims, fees, expiry/refund paths.
- `encrypted-ixs` — the Arcis circuits (gen/seal/score/reshare/reveal).
- `packages/harness` — client bindings, artifact commitments, encryption.
- `web/` — the explorer; report parsing bugs only if they misrepresent
  on-chain state in a way that could defraud a user.

## Known limitations (by design, not bugs)

- The devnet deployment sits on Arcium's shared devnet cluster, which
  had a callback outage during development — pending computations are
  expected; that is infrastructure, not a protocol flaw.
- Mock models (`mock/oracle-*`) are test fixtures — their "scores" are
  planted. Real-model runs go through the same pipeline.
- Bank JSON files under `bank/` and private-bank `--out` files contain
  plaintext — they are local artifacts, git-ignored, and never published
  on-chain.

## Adversarial review history

Two independent adversarial passes have run over the market program and
run lifecycle; found-and-fixed issues include the just-in-time
commit/expire gap (`all_queued_at` landing window), the 8-leg result-mask
truncation, and forced-resolution inside a leg's landing window. See
`docs/threat-model.md` for the full model.
