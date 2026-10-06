# Capability report — qwen2.5-0.5b-instruct

> sealed-report/v1 · generated 2026-10-06T14:13:06.215Z · source ../../web/snapshot.json
> programs: sealed `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` · market `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN`
> record PDA `CXt66U71eShBAX3k7ATCzcU6MokgTobVvKwBtmvTZ4Js` · claim-card content sha256 `e5ca3a3b8fb58ab6f8101c260ac4f78a4b8f7b8344f850f4c273ce1f1bccd356` (canonical JSON, `generatedAt`/`source` excluded)

Every number below is replayable. Re-mint the card and compare fingerprints:
```
sealed chain prove "qwen2.5-0.5b-instruct" --out card.json --snapshot web/snapshot.json
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
| paired evidence | rank #26 · 0W-2L-1T · ΣΔ-28.12pp over 3 shared-bank results |
| settlement | duels 0W-0D-1L (0%) · ladder legs 0/1 · bounties 0 |
| market belief | no open book prices it |
| coverage | absent from the most-run suite |

## Score receipts

| run | score | items | attested | post-reveal | recorded |
|---|---|---|---|---|---|
| `DMf2vZaDhw1H…` | 0 | 32 | — | — | 2026-10-02 |

_1 receipts · 0 post-reveal run(s) flagged — post-reveal scores do not measure the same thing._

## Settlement record

| venue | kind | pot (lamports) | outcome |
|---|---|---|---|
| `497kuApdvQKE…` | band | 180000000 | 1 |
| `7p32UT6sT8DG…` | duel | 400000000 | 0 |
| `A4fMA7eKKC6g…` | ladder | 410000000 | 3 |
| `rXKda9QJYHhB…` | bounty | — | — |

_4 resolved venues — every stored score re-derives from Run.correct._

## Honesty flags

- post-reveal runs: 0
- post-reveal receipts: 0
- co-participant runs embedded for venue replay: 4

