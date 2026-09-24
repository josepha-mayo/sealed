# Promotion drafts

Copy-paste material for build-in-public + Arcium outreach. Replace the
hosted-URL placeholder once Pages is live.

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

4/ On top: four parimutuel market types resolving straight from
Run.correct — no oracle multisig:

- binary over/under on a score
- N-way score bands
- duels: model A vs model B
- ladder races: 3–8 runners, argmax wins, dead-heat splits

5/ The security story is adversarial-reviewed: JIT-commit attacks,
landing-window expiry, committed-settle semantics, strict ordered leg
accounts. Every edge has a regression test.

Evidence: 61 MPC-finalized runs, 39 markets settled, 12.56 SOL paid
pro-rata — all verifiable from a committed snapshot + Merkle proofs.

6/ Headline run: gpt-oss-20b scored 64/64 on a bank minted inside MPC —
no answer key ever existed outside the enclave. A stale-artifact cheat
attempt on the same pipeline scored 1/64 honestly.

The model can't cheat what it can't see.

7/ Explorer: <HOSTED-URL> — banks, runs, markets, ladders, Merkle-proof
verification, all rendered from on-chain data. Zero backend.

Built for @colosseum Crypto World's Fair on @arcium.

## Arcium outreach (Discord / DM to team or judges channel)

> Hey — building Sealed for CWF: prediction markets on AI benchmark
> results where the answer key never exists outside MPC. Banks are minted
> by gen_part inside the enclave, scored by score_chunk callbacks, and
> markets resolve directly from the Run accounts your nodes finalize —
> no oracle. Also shipped a novel K-way "ladder race" market primitive on
> top (argmax + dead-heat mask), which lines up with the novel-mechanisms
> ask. 61 MPC-finalized runs on localnet; devnet deployment is live but
> the shared cluster's callback outage is blocking flows — flagging in
> case it helps: <devnet sigs>. Would love a pointer if there's a
> recommended workaround or a mainnet-cluster path for the demo.

## Colosseum forum post (if a project channel exists)

Title: Sealed — benchmark answer keys that never exist in plaintext

Body: link repo + hosted explorer + the one-paragraph pitch from
docs/pitch.md. Lead with the 64/64 MPC-minted headline run and the
four market primitives.
