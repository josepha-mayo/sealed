# Capability report — llama-3.2-1b-instruct

> sealed-report/v1 · generated 2026-10-06T14:13:12.618Z · source ../../web/snapshot.json
> programs: sealed `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` · market `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN`
> record PDA `HT5SbpWXhi9mUgQDn6Y8TiuBu29qFT9WsGPbt4cwKf1c` · claim-card content sha256 `a790c35e87ae0493de9791e88f8c5a2b3a6ccdf0745b5d3e83cb3c8551fe8fd2` (canonical JSON, `generatedAt`/`source` excluded)

Every number below is replayable. Re-mint the card and compare fingerprints:
```
sealed chain prove "llama-3.2-1b-instruct" --out card.json --snapshot web/snapshot.json
sealed chain prove --verify card.json
python3 -c 'import json,hashlib; c=json.load(open("card.json")); c.pop("generatedAt",None); c.pop("source",None); print(hashlib.sha256(json.dumps(c,sort_keys=True,separators=(",",":")).encode()).hexdigest())'
```

## Registry record

| metric | value |
|---|---|
| receipts | 1 |
| aggregate | 0/32 items (0%) |
| best run | 0/0 |

## The four lenses

| lens | reading |
|---|---|
| paired evidence | rank #27 · 0W-2L-1T · ΣΔ-28.12pp over 3 shared-bank results |
| settlement | duels 0W-0D-0L (—%) · ladder legs 0/1 · bounties 0 |
| market belief | no open book prices it |
| coverage | absent from the most-run suite |

## Score receipts

| run | score | items | attested | post-reveal | recorded |
|---|---|---|---|---|---|
| `HQJL9gjCJbS8…` | 0 | 32 | — | — | 2026-10-02 |

_1 receipts · 0 post-reveal run(s) flagged — post-reveal scores do not measure the same thing._

## Settlement record

| venue | kind | pot (lamports) | outcome |
|---|---|---|---|
| `t82Q2fPEKuG3…` | band | 100000000 | 0 |
| `A4fMA7eKKC6g…` | ladder | 410000000 | 3 |
| `rXKda9QJYHhB…` | bounty | — | — |

_3 resolved venues — every stored score re-derives from Run.correct._

## Honesty flags

- post-reveal runs: 0
- post-reveal receipts: 0
- co-participant runs embedded for venue replay: 3

