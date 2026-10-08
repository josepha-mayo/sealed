# Why this is an Arcium-native application

Sealed isn't a Solana app with MPC sprinkled on top — the *reason it
exists* requires MPC, and it exercises nearly every Arcium primitive
that matters. Map for sponsor-track judges:

| Sealed feature | Arcium primitive | Where |
|---|---|---|
| Exams minted inside the cluster — no human ever held the item | `ArcisRNG::gen_public_integer_from_width` drawing operands/operators in-circuit (`gen_part`, `gen_part_private`) | `encrypted-ixs/src/lib.rs` |
| Author's answers sealed client-side, re-encrypted to the cluster key, never decrypted by the chain | `Enc<Shared, AnswerPart>` → `Enc<Mxe, AnswerPart>` handoff (`seal_part`) | `encrypted-ixs/src/lib.rs` |
| Scoring = model outputs vs sealed answers compared *inside* MPC; only the count leaves | `score_chunk` circuit, `Enc<Mxe>` state, callback writes `Run.correct` | `encrypted-ixs/src/lib.rs`, `programs/sealed` |
| Delegated selective disclosure — a viewer's x25519 pubkey receives re-encrypted item specs, answers never move | `reshare_part`/`share_part` re-encrypting `Enc<Mxe>` → `Enc<Shared>` to the viewer key; ShareGrant PDAs record who saw what | `programs/sealed` |
| Audit-and-burn — authority declassifies answer *fingerprints* (not plaintext), poisoning that bank for markets | `reveal_part` emits the public `AnswerPart` fingerprint; `post_reveal` flag locks venues on-chain | `programs/sealed` |
| MPC-friendly ciphertext on the wire | Rescue-Prime over Fp25519 + X25519 for grant ciphertexts — vendored in-page, ported to stdlib Python for the third-language decrypt | `web/vendor/rescue.mjs`, `scripts/verify.py --decrypt` |

## Why MPC and not the alternatives

- **Not ZK.** A ZK proof needs a witness — *someone* has to hold the
  answer key to prove over it. Here the key must stay live and secret
  across many runs by many different models over the same bank. MPC
  keeps the secret shared across the cluster; there is no witness to
  steal because there is no single-machine secret to hold.
- **Not TEE.** An enclave's answer key is one SGX attestation away from
  a vendor trust assumption, and one physical seizure away from
  disclosure. The Arcium cluster's secrecy is honest-majority-of-nodes,
  not honest-hardware-vendor.
- **Not "just hash the answers."** A benchmark whose questions are
  secret must let models *read* items without an operator proxying
  them — that needs the cluster to re-encrypt to the reader's key
  (`reshare_part`), which is exactly what MXE shared-key encryption
  exists for. A hash can't do disclosure; MPC can, selectively.

## Devnet honesty note

Both programs are deployed and byte-verified on devnet
(`scripts/verify-deployed.sh`), computation definitions queue on the
shared cluster, and the evidence bundle's root is notarized on devnet
via a memo tx (`docs/evidence-anchor.json`). The shared Arcium devnet
callback lane had an upstream outage during the build — documented in
`docs/engineering-log.md` — so the reproducible end-to-end environment
is `arcium localnet` (offset 0), which the committed 1796-account
evidence snapshot was captured from and which `scripts/demo.sh` drives
in one command. Everything a judge can re-run today runs without
trusting us: `verify-all.sh` recomputes the whole story offline.
