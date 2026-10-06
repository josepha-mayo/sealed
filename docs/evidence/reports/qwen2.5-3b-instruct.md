# Capability report — qwen2.5-3b-instruct

> sealed-report/v1 · generated 2026-10-06T13:24:16.150Z · source ../../web/snapshot.json
> programs: sealed `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` · market `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN`
> record PDA `7mAKsLaBqXcLZNso8EXbSUWFGcDZzsqq36xRfefvCYqB` · claim-card content sha256 `945c3c2ba1e4f8906aa15383abf9e90ef6ba2e987430c3e2c3e6972967df2cfc` (canonical JSON, `generatedAt`/`source` excluded)

Every number below is replayable. Re-mint the card and compare fingerprints:
```
sealed chain prove "qwen2.5-3b-instruct" --out card.json --snapshot web/snapshot.json
sealed chain prove --verify card.json
python3 -c 'import json,hashlib; c=json.load(open("card.json")); c.pop("generatedAt",None); c.pop("source",None); print(hashlib.sha256(json.dumps(c,sort_keys=True,separators=(",",":")).encode()).hexdigest())'
```

## Registry record

| metric | value |
|---|---|
| receipts | 3 |
| aggregate | 23/96 items (23.96%) |
| best run | 9/32 |

## The four lenses

| lens | reading |
|---|---|
| paired evidence | rank #9 · 3W-0L-0T · ΣΔ+59.38pp over 4 shared-bank results |
| settlement | duels 1W-0D-0L (100%) · ladder legs 1/1 · bounties 1 |
| market belief | no open book prices it |
| coverage | absent from the most-run suite |

## Score receipts

| run | score | items | attested | post-reveal | recorded |
|---|---|---|---|---|---|
| `4biuMVncBjFZ…` | 9 | 32 | — | — | 2026-10-02 |
| `ucwXeKwU5yAn…` | 7 | 32 | — | — | 2026-10-02 |
| `GnrRt5GUu6pU…` | 7 | 32 | — | — | 2026-10-03 |

_3 receipts · 0 post-reveal run(s) flagged — post-reveal scores do not measure the same thing._

## Settlement record

| venue | kind | pot (lamports) | outcome |
|---|---|---|---|
| `EHiTUjmP6Eij…` | duel | 290000000 | 0 |
| `7TVjSaFDnQkn…` | dark | 200000000 | 1 |
| `BrFdXAxYgqNH…` | dark | 180000000 | 1 |
| `A4fMA7eKKC6g…` | ladder | 410000000 | 3 |
| `rXKda9QJYHhB…` | bounty | — | — |

_5 resolved venues — every stored score re-derives from Run.correct._

## Honesty flags

- post-reveal runs: 0
- post-reveal receipts: 0
- co-participant runs embedded for venue replay: 4

