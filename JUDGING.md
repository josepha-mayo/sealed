# Judging Sealed

**A benchmark whose answer key never existed — the exam nobody can
leak, the score nobody can fake, the market that settles itself.**
Exams are minted and scored inside an Arcium MPC cluster; Solana
carries commitments, score receipts, and markets that settle off
the on-chain score field itself (`Run.correct`) — no referee, no
oracle operator.

Three paths, fastest first:

1. **One link, zero setup** — https://josepha-mayo.github.io/sealed/?mega=1
   runs the whole skeptic's suite in your browser (~8s): every account
   address re-derived from its seeds, all 142 committed proof files
   replayed, every forgery attack caught at the check that kills it,
   the sealed exam decrypted in-page — ending on EVERYTHING VERIFIED
   with a copyable verdict for your notes.
2. **One line, zero clone** — `curl -sL https://raw.githubusercontent.com/josepha-mayo/sealed/main/scripts/verify.py | python3 - --remote`
   downloads a single stdlib Python file that fetches all 359 pinned
   bytes itself and re-verifies the entire evidence base independently —
   none of the code that produced it.
3. **The full path** — `docs/judges.md` is the rubric-mapped deep-dive
   (program tests, the MPC-rescore proof, forgery lab, capsule, devnet
   anchor; ~40 min hands-on plus a localnet toolchain if you rebuild
   everything).

**Trust nothing:** the whole bundle folds to one sha256
(`chain fingerprint`), notarized on devnet via a memo transaction
(`docs/evidence-anchor.json`). Terminal, browser, and Python all agree
on it — or the evidence is dirty.

**Break it:** download any artifact, edit any byte you like, and feed it
back — `python3 scripts/verify.py --card <yours>` or drop it on the
explorer's verifier (hit "⚔ forge this card" for the canned attack).
A forged card that verifies earns a named entry in
`docs/engineering-log.md`; the 15 committed exhibits in
`docs/evidence/tamper/` are the ones we already killed.
