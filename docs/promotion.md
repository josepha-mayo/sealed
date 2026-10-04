# Promotion drafts

Copy-paste material for build-in-public + Arcium outreach. The hosted
explorer is live at https://josepha-mayo.github.io/sealed/ (GitHub Pages,
auto-deployed on every push).

## X / Twitter thread (build in public)

1/ Sealed: prediction markets on AI models whose benchmark questions and
answer keys *do not exist in plaintext anywhere*.

Benchmarks are minted inside Arcium MPC enclaves — the bank is born
encrypted, stays encrypted, and is scored by the cluster itself.
🧵

2/ AI leaderboards today: a lab submits a score, or an operator runs the
eval and posts a number. Both are trusted claims.

Sealed inverts it: the answer key never leaves MPC. Runners can't see it.
The bank owner can't see it. The score on-chain is the only score.

3/ The primitive stack, all live:

- MPC-minted banks (items born inside the enclave, fingerprinted answers)
- Private banks (ciphertext-only specs on-chain)
- Selective disclosure — show a judge the questions, not the answers
- MPC scoring — run.correct is written by the cluster, not an oracle

4/ On top: six market primitives resolving straight from
Run.correct — no oracle multisig:

- binary over/under on a score
- N-way score bands
- duels: model A vs model B
- ladder races: 3–8 runners, argmax wins, dead-heat splits
- unseen-exam markets: the priced event is itself ciphertext
- dark commit-reveal markets: bettor sides stay sha256-sealed until reveal
Plus a non-parimutuel primitive — capability bounties: a sponsor escrows
SOL on "first MPC-proven run ≥ threshold", pot pays the winning run's
operator.

5/ The security story is adversarial-reviewed: JIT-commit attacks,
landing-window expiry, committed-settle semantics, strict ordered leg
accounts. Every edge has a regression test.

Evidence: 503 MPC-scored runs, 340 market+bounty venues across six
primitives, 200+ resolutions re-verified by the offline audit — every
artifact and Merkle proof in the repo, replayable bit-for-bit.

6/ Headline run: gpt-oss-20b scored 64/64 on a bank minted inside MPC —
no answer key ever existed outside the enclave. A stale-artifact cheat
attempt on the same pipeline scored 1/64 honestly.

The model can't cheat what it can't see.

7/ Explorer: https://josepha-mayo.github.io/sealed/ — banks, runs, markets,
ladders, Merkle-proof verification, all rendered from on-chain data.
Zero backend.

Built for @colosseum Crypto World's Fair on @arcium.

## Arcium outreach (Discord / DM to team or judges channel)

> Hey — building Sealed for CWF: prediction markets on AI benchmark
> results where the answer key never exists outside MPC. Banks are minted
> by gen_part inside the enclave, scored by score_chunk callbacks, and
> markets resolve directly from the Run accounts your nodes finalize —
> no oracle. Also shipped a novel K-way "ladder race" market primitive on
> top (argmax + dead-heat mask), which lines up with the novel-mechanisms
> ask. 503 MPC-finalized runs on localnet; devnet deployment is live and
> byte-verified (scripts/verify-deployed.sh sha256-compares the on-chain
> ELF to the repo build) but the shared cluster's callback outage is
> blocking flows — flagging in case it helps. Would love a pointer if
> there's a recommended workaround or a mainnet-cluster path for the demo.

## Colosseum forum post (if a project channel exists)

Title: Sealed — benchmark answer keys that never exist in plaintext

Body: link repo + hosted explorer + the one-paragraph pitch from
docs/pitch.md. Lead with the 64/64 MPC-minted headline run and the
six market primitives + capability bounties.
