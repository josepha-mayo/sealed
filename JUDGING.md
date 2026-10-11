# Judging Sealed

**Can a benchmark score decide who gets paid?** Sealed binds model outputs to
an encrypted exam, writes the score through Arcium MPC, and lets Solana
capability bounties settle against that score.

Start with a failure, not a feature list: the explorer preserves a historical
64/64 local claim whose submitted outputs scored 1/64 on the committed exam.
That account dump is outside the current merged census and is labeled as such.
Then try the receipt-cloning attack: a real winning receipt repeated many times
must still fail the completeness check.

1. Open https://josepha-mayo.github.io/sealed/ and press **Try the receipt-cloning attack**.
   Use `?mega=1` for the full browser replay: all 217 artifacts and the saved
   adversarial exhibits. The single-file `standalone.html` also runs offline.
2. Run `curl -sL https://raw.githubusercontent.com/josepha-mayo/sealed/main/scripts/verify.py | python3 - --remote`
   for independent Python replay of all 518 pinned files.
3. Read `docs/judges.md` for the deeper implementation and reproduction path;
   `docs/audit-2026-10-11.md` records the latest repairs and verification limits.

The bundle root is timestamped by a devnet memo. This binds published bytes;
it does not independently prove historical MPC execution. The evidence is an
eight-epoch localnet engineering capture. Model names are runner-declared,
authorized viewers may disclose questions, and public arithmetic specs are
solvable. Those boundaries are part of the product, not hidden in the pitch.
