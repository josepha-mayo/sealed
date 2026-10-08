# Judging Sealed

**A benchmark whose answer key was never written down, scored by nobody
in particular.** Exams are minted and scored inside an Arcium MPC
cluster; Solana carries commitments, score receipts, and markets that
settle off `Run.correct` with no referee.

Three paths, fastest first:

1. **One link, zero setup** — https://josepha-mayo.github.io/sealed/?mega=1
   runs the whole skeptic's suite in your browser (~8s): every account
   PDA re-derived, all 138 committed artifacts replayed, every forgery
   attack caught, the sealed exam decrypted in-page — ending on
   EVERYTHING VERIFIED with a copyable verdict for your notes.
2. **One line, zero clone** — `curl -sL https://raw.githubusercontent.com/josepha-mayo/sealed/main/scripts/verify.py | python3 - --remote`
   downloads a single stdlib file that fetches all 351 pinned bytes
   itself and replays the entire evidence base in a third language.
3. **The full path** — `docs/judges.md` is the 10-minute walk mapped to
   the rubric (program tests, the MPC-rescore proof, forgery lab,
   capsule, devnet anchor).

**Trust nothing:** the whole bundle folds to one sha256
(`chain fingerprint`), notarized on devnet via a memo tx
(`docs/evidence-anchor.json`). Terminal, browser, and Python all agree
on it — or the evidence is dirty.
