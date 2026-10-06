# Capability report — qwen2.5-1.5b-instruct

> sealed-report/v1 · generated 2026-10-06T14:13:01.148Z · source ../../web/snapshot.json
> programs: sealed `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ` · market `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN`
> record PDA `FQGc2nW7epZZFnF8qL6nCrwFbKP71UAU9LSpLpRQB79j` · claim-card content sha256 `3a9076c8bb6154d6367f26217ccd799db8cd28e02d4151016302f459e3abe9f2` (canonical JSON, `generatedAt`/`source` excluded)

Every number below is replayable. Re-mint the card and compare fingerprints:
```
sealed chain prove "qwen2.5-1.5b-instruct" --out card.json --snapshot web/snapshot.json
sealed chain prove --verify card.json
python3 -c 'import json,hashlib; c=json.load(open("card.json")); c.pop("generatedAt",None); c.pop("source",None); print(hashlib.sha256(json.dumps(c,sort_keys=True,separators=(",",":")).encode()).hexdigest())'
```

## Registry record

| metric | value |
|---|---|
| receipts | 3 |
| aggregate | 9/96 items (9.38%) |
| best run | 5/32 |

## The four lenses

| lens | reading |
|---|---|
| paired evidence | rank #12 · 2W-1L-0T · ΣΔ-3.12pp over 4 shared-bank results |
| settlement | duels 1W-0D-1L (50%) · ladder legs 1/1 · bounties 0 |
| market belief | no open book prices it |
| coverage | absent from the most-run suite |

## Score receipts

| run | score | items | attested | post-reveal | recorded |
|---|---|---|---|---|---|
| `55iJanaGGPZ9…` | 5 | 32 | — | — | 2026-10-02 |
| `CjatpBGz5MTR…` | 2 | 32 | — | — | 2026-10-02 |
| `Hn21uoPQYi8x…` | 2 | 32 | — | YES | 2026-10-03 |

_3 receipts · 1 post-reveal run(s) flagged — post-reveal scores do not measure the same thing._

## Settlement record

| venue | kind | pot (lamports) | outcome |
|---|---|---|---|
| `7p32UT6sT8DG…` | duel | 400000000 | 0 |
| `EHiTUjmP6Eij…` | duel | 290000000 | 0 |
| `A4fMA7eKKC6g…` | ladder | 410000000 | 3 |
| `rXKda9QJYHhB…` | bounty | — | — |

_4 resolved venues — every stored score re-derives from Run.correct._

## Honesty flags

- post-reveal runs: 1
- post-reveal receipts: 1
- co-participant runs embedded for venue replay: 5

