# API surface

Every public instruction, its purpose, and its guard rails. Source of truth:
`programs/sealed/src/lib.rs`, `programs/market/src/lib.rs`, `encrypted-ixs/src/lib.rs`.
Program IDs — sealed `FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ`,
market `8VSHkhNLN3q3yBUhYmTjgKSCMA55VFzfLPXcgp4Z91vN`.

## `sealed` — banks, runs, MPC lifecycle

Plain instructions:

| ix | what it does | key constraints |
|---|---|---|
| `create_benchmark(items_root, kind, …)` | registers a bank PDA `[benchmark, authority, id]` | items_root commits to questions (authored) or ciphertext (generated) |
| `init_chunk` / `init_items` / `init_items_private` | allocates `AnswerChunk` / `ItemChunk` / `PrivItemChunk` for chunk `index` | seeds bind benchmark + index |
| `stage_part(index, part, …)` | author writes 8 items' encrypted answers + spec commitments | authority-only; rejected once sealing starts for that part |
| `create_run(model_id, harness_hash, outputs_root)` | mints `Run` PDA `[run, benchmark, run_index]` committing to every output hash | stamps `post_reveal=1` if `benchmark.reveal_count > 0` (F1); `model_id` is self-reported runner metadata — the scored outputs + runner key are the trust-bearing fields |
| `attest_run(run_index)` | authority vouches for a run's model identity | benchmark authority only |
| `record_score(run_index, model_hash)` | enrolls a finalized run's score into the persistent `ModelRecord` aggregate + writes a `ScoreLog` receipt | permissionless; run must be finalized; `model_hash` must be `sha256(run.model_id)` so the entry binds the run's declared identity; `score_log`'s `init` on `[scorelog, run]` makes double-counting structurally impossible |
| `reset_pending` / `reset_sealing` | liveness sweeps: clear stalled pending bits / sealing locks | permissionless — a stalled queue can be cleared by anyone |
| `retire_benchmark` | stops new runs/chunks on the bank | authority; refused while runs pending |

MPC-boundary instructions (queue → Arcium computes → `*_callback` writes):

| queue ix | circuit | callback writes |
|---|---|---|
| `seal_part(index, part)` | `seal_part`: `Enc<Shared> → Enc<Mxe>` re-encryption | sealed ciphertext into `AnswerChunk` |
| `gen_part(id, base_index)` | `gen_part`: ArcisRNG specs + in-circuit answers | public `ItemChunk` specs + sealed answer ciphertext |
| `gen_part_private` | same, but specs returned `Enc<Shared>` to authority | ciphertext-only `PrivItemChunk` |
| `score_chunk(run_index, index)` | `score_chunk`: compares committed output hashes vs sealed answers, reveals count only | `scored_mask` bit + `correct` count on `Run` |
| `reveal_part(index, part)` | `reveal_part`: declassifies fingerprints | `Reveal` account + bumps `benchmark.reveal_count` (burn) |
| `reshare_part(index, part, viewer)` | `reshare_part`: re-encrypts specs to viewer x25519 | `ShareGrant` PDA — questions only, never answers |

All callbacks are gated by `callback_computation` — only the Arcium cluster
can invoke them, on the exact computation that was queued — and every
mutating data account additionally carries self-canonical PDA seeds (the
account must be THE PDA its own stored fields describe).

| ix | what it does | key constraints |
|---|---|---|
| `init_signer_pda` | creates the shared `ArciumSignerAccount` PDA used by every queue path | grief-proof: drains prefunded lamports back to the caller via `invoke_signed`, then `create_account` — also *un-bricks* the singleton after a successful prefund grief. Idempotent. `chain init` calls it eagerly. |
| `unbrick_pda(seeds, bump)` | sweeps a grief-prefunded PDA's lamports to the caller | permissionless. Anchor's `init` already tolerates prefunds (tops up to rent-exempt, allocate+assign) — this ix reclaims the dust *before* init so a prefunder loses it instead of donating it, and covers any manual `create_account` path. `create_program_address(seeds ‖ bump, ID) == pda` re-proves the account belongs to this program's derivation space; only a system-owned, zero-data (never-initialized) account qualifies — arbitrary wallets can never be drained. `chain unbrick sealed run <bank> <idx>` covers every layout (run/chunk/items/pitems/reveal/grant/benchmark). |

**Capability registry.** `record_score` turns a finalized `Run` into a
durable per-model artifact: `ModelRecord [modelrec, sha256(model_id)]`
aggregates `runs_scored`, `total_correct/total_items`, an accuracy-first
`best_*` (ties break toward the larger sample), and `first_seen`/
`last_scored`; `ScoreLog [scorelog, run]` snapshots `correct`, `items`,
`recorded_by`, and the honesty flags *at record time* — so a later
`attest_run` or fingerprint reveal can't rewrite history. Enrollment is
permissionless and free of trust assumptions (anyone can pay the rent; the
score itself was written by MPC), but it is **not** attestation:
`model_id` remains self-reported metadata and only
`vouched_at_record = run.attested` distinguishes authority-vouched entries.
The harness exposes it as `chain record --run <pk>` / `chain modelrec
<pubkey|model_id>`; `verify.mjs` and the explorer audit replay every
record bit-exact from its receipts. `chain gate <model_id> --min-pct N
[--min-items N] [--vouched] [--no-post-reveal] [--min-runs N]
[--wilson P] [--bank <pk|name>]` evaluates an admission policy over a
record — exit 0 pass / 1 fail / 2 no evidence — with the Wilson lower
bound so small-sample records can't flatter a gate. `--bank` scopes the
policy to one exam (name resolves every same-named benchmark), so
"does it clear 70% on *this* bank" is one command. Same evaluation runs
in-page in the hosted explorer. `chain gate --all` applies the policy
to *every* ModelRecord and prints the ranked pass/fail table — the
capability registry as a filterable leaderboard, not a list. Add
`--prove <dir>` and every model the policy admits gets a
`sealed-claim/v1` card minted into `<dir>` — "who clears ≥80% with
proof" produces a folder of verifiable claims, not a printout.
`chain records [--wilson]` lists the same registry accuracy-first; the
flag re-ranks on the Wilson lower bound of cumulative accuracy — the
claim each record can defend (80% on a thin record correctly sits below
78% on a proven one). `chain gate --sweep` drops the single-threshold
assumption entirely: every record re-evaluated across a min-pct grid
(default 10–90%, `--grid a,b,c` overrides, all other flags apply), each
model's "frontier" = the strictest line it survives. `gate --all` says
who clears *this* policy; the sweep says who is *robustly* good.

`chain market positions [--bettor kp.json] [--json]` — the bettor-side
mirror: every position the wallet holds across bands/duels/ladders/darks,
classified PAYS / REFUND / LIVE / SEALED / RENT / FORFEIT with est.
pro-rata payouts (same fee math the claim ixes recompute on-chain).
Claim commands prefilled — except darks, where `pos_salt` is a PDA seed
only the bettor knows.

`chain market sweep [--bettor kp.json] [--watch secs]` runs the board then
EXECUTES every permissionless action on it — bounty claims (the pot pays
the winning run's operator, not the sweeper), `resolve`,
`resolve_ladder`, `finalize_dark`, `expire_*`, `expire_bounty`. A raced
keeper's tx fails on the already-transitioned account and the sweep
continues. `--watch` loops it into a keeper daemon — the no-operator
design as a runnable process, not a promise. The registry side has the
same loop: `chain record --all --watch <secs>` re-scans the ledger and
enrolls every newly-finalized run into a `ScoreLog` receipt — a
permissionless librarian daemon; receipts are init-once PDAs, so the
daemon is idempotent and races are harmless.

`chain market board [--json]` scans every venue account + run and reports
the keeper inventory: bounties claimable *right now* (a qualifying run is
already finalized-or-proven — the claim command prefilled), live and
expired bounties awaiting `expire_bounty`, resolvable markets/ladders,
resolved darks past `reveal_until` awaiting `finalize_dark`, and venues
past `resolve_by` awaiting `expire` (annotated settle-vs-refund — the
same `expire_decision` split the program makes). Read-only; the
classification is pure (`packages/harness/src/board.ts`) and mirrors the
on-chain `still_moving`/`proven`/`bounty_qualifies` gates exactly.

`chain market live [--json]` is the bettor's counterpart — every venue
still accepting positions (status open AND `closes_at`/`resolve_by` both
in the future; a past-expiry venue can't take a bet — that's the keeper
board's job, not the bettor's), soonest-close first, each row carrying
the live book, countdown, and a prefilled `market quote` command. The
keeper board asks "what needs a transaction"; this asks "where can I
still get one down".

`chain market sharps [--min n] [--json]` is the bettor track record —
every *surviving* position across every venue kind aggregated per
wallet (exercised claims close their Position PDAs, so claimed winners
are invisible to account reads — `market escrow` tracks their outflow).
Wins are `payable` classifications, losses are `lost`/`forfeit`;
refunds, live, and sealed positions are reported but never counted as
results (the same honesty rule as coverage — unresolved ≠ zero). Repeat
bettors (≥`--min` resolved, default 1) rank by Wilson 95% LCB of
win-rate so a 1–0 can't outrank a proven record; P&L uses full position
stake (`risked` — every bucket's lamports, not just the winning share)
so a hedged winner doesn't inflate its return. On the committed bundle
the headline is the anonymity set: 139 bettors hold 140 surviving
positions and every resolved position sits in a distinct wallet — zero
observable track records. That is the market layer's real privacy
posture, measurable from chain state alone.

`chain market escrow [--json]` is the lamport ledger — every cumulative
stake reconciled to an obligation bucket: in-play pots, unclaimed winner
shares (surviving payable positions), unclaimed refunds, accrued fees,
mid-reveal dark pools, live and sponsor-refundable bounty escrow, and
`dead` — resolved venues whose winning bucket went unbacked (`winTotal
= 0`), pots no instruction can move. `settled out` is the balancing
line: claims already exercised, fees collected, refunds paid. The
ledger is forced to sum exactly to cumulative stakes — on the bundle,
72.7◎ of 76.1◎ already left escrow (68.1◎ of it winner payouts), with
zero dead money: every resolved venue's winning bucket was backed.

`chain anomalies [--json]` is the skeptic's checklist — ten hostile
audits run against the bundle itself: post-reveal runs, stuck-pending
runs, thin high-pct records, dead money, forfeited dark stakes,
past-deadline bounties, duplicate bank names, venues on post-reveal
runs (must be zero — the program refuses them), single-runner banks,
and empty resolved books. Each finding carries a severity and the
drill-in command; clean checks still print because the absence of an
anomaly is evidence too. On the bundle: 1 disclosed warn (29 post-reveal
runs — flagged on-chain, refused by markets, excludable from gates),
6 informational notes, 3 clean bills.

`chain history <model_id|record-pk> [--json]` lists a model's ScoreLog
receipts oldest-first with running accuracy after each — the capability
trajectory ("did it regress after the fine-tune?") answered from
on-chain data; vouched/post-reveal flags ride on every row.

`chain compare <A> <B>` joins the two models' receipts **by benchmark** —
the paired question the markets exist to price ("does A beat B on the
SAME evidence?"). Per-bank deltas, pooled shared-item score, bank-win
count, and unshared-coverage reporting. Disjoint coverage exits 2 — an
honest "the registry can't rank them" instead of an aggregate lie.
`chain banks` indexes every benchmark (kind, items, runs, best score) —
the pk list `status`/`compare` need without the explorer; `--kind
private` isolates the ciphertext-only banks. `chain compare --all`
tallies every model×model pair's shared-bank
result into a W-L-T leaderboard — rankings grounded on shared evidence
only, with disjoint pairs reported as unranked rather than assumed;
`--min-shared n` requires n shared banks before a pair counts
(`--min-shared 5` tightens the bundle's rankable pairs to 52).
`--wilson` re-ranks by the Wilson 95% lower confidence bound of the win
rate (ties count half, n = ranked pairs) — the same interval math the
capability gate applies to accuracy, here disciplining the *ranking*: a
2–0 record can't sit above a proven 15–2 on thin evidence.
`chain matrix [--banks N]` renders the capability matrix — models × the
most-run banks, each cell the model's best finalized score there
(`*` marks cells whose best score is post-reveal-only — it can't prove
anything). "—" is unproven, not zero: a model absent on a bank can't be
ranked there. `--json` emits the same grid machine-readable for
integrators building their own coverage views.
`chain trail <run-pk>` prints one run's custody chain — bank, registry
receipt, and every venue that priced it — and **re-verifies each resolved
venue's score against `Run.correct`** (duel `resolved_score` unpacked
`(a << 16) | b`), so a settlement that disagreed with the run would
print ✗ MISMATCH, not get trusted.

Every read command also takes `--snapshot <file>` — `records`,
`modelrec`, `gate`, `history`, `compare`, `trail`, `status`, `banks`, `stats`,
`runs`, `feed`, `bank`, `wallet`, `verify`, `grants`, `reveals`, `market board`, `market bounties`, `market venue`,
`market positions`, `market position`, `market quote`, `market odds`, `market sentiment`, `market champions`, `market divergence`, `market calibration`, `market live`, `market sharps`, `market escrow`, `anomalies`, `model`, `matrix`, `search`, `watch`, `items` (rebuilds a generated bank's item specs from
raw ItemChunk bytes and re-verifies the items_root fold — an exam
regenerated from chain state alone, offline). `chain export --snapshot
web/snapshot.json [--out digest.json]` emits the portable integrity
digest (`sealed-evidence-digest/v1`): the bundle's sha256, counts, the
keeper classification, and per-row verdicts for every `ModelRecord`
replay and every resolved venue's `Run.correct` check — the audit as
one diffable JSON document, exit 1 on any violation. Drop `--snapshot`
and the same digest runs over the live cluster (`source: "live"`) —
the verdicts applied to YOUR deployment, with a discriminator-filtered
fallback that tolerates old-layout accounts the same way snapshot
decoding does.
`chain runs` filters the substrate — `--bank`, `--model`, `--min-pct`,
`--status`, and `--attested` isolates authority-countersigned runs (the
flag markets and the `vouched` gate trust; an unattested run is a claim,
an attested one is a co-signed measurement).
`chain prove <model|record-pk> [--out claim.json]` mints a
`sealed-claim/v1` card — the product's actual deliverable: one model's
ModelRecord, every receipt, every run (plus the co-participant runs its
venues' verdicts need — duel runB, ladder legs), every bank, and every
venue that priced those runs, each carrying its PDA seeds. `chain prove
--verify claim.json` re-verifies the card with nothing but the program
IDs: every account address re-derives from its declared seeds (identity
is cryptographic, not claimed — `[modelrec, sha256(model_id)]`,
`[run, bank, index]`, `[scorelog, run]`, `[benchmark, authority, id]`,
`[market|duel|dark|ladder|bounty, …]`), the record aggregate replays
bit-exact from receipts, receipts agree with `Run.correct`, and venue
resolutions re-derive (duels unpack `(a<<16)|b`, ladders re-argmax the
result mask, bounties check winner score ≥ threshold). A tampered card
fails exactly where it should. `chain prove` works keyless on the
snapshot. `chain prove --all [--out dir]` mints one card per record —
the whole registry as verifiable artifacts — and `chain prove --verify
<dir>` batch-checks every card in a directory (`ALL CARDS VERIFIED`,
exit 1 on any failure). The committed bundle ships all 31 registry cards
in `docs/evidence/claims/` (mirrored at `web/claims/`, each
sha256-pinned in `web/MANIFEST`), and the explorer's "verify a claim
card" section replays the same 9 checks in-page for any of them —
`qwen2.5-3b-instruct`'s card, for example, is a public audit trail no
one had to ask permission for.

`chain diff <a.json> <b.json>` compares two bundles — per-type account
deltas (added/removed, and MUTATED: same PDA, different bytes), both
sides' sha256 and integrity verdicts recomputed. Pair it with
`snapshot.mjs --rpc <url>` to prove the committed bundle reproduces
from live chain state instead of trusting the committed file.
`chain stats` is the executive dashboard — ledger counts, escrow, fees,
MPC latency p50/p95, the keeper surface, an activity heartbeat
(per-UTC-day event sparkline — the same timestamps `feed` orders by),
and two verdicts recomputed
on the spot: every `ModelRecord`'s stored aggregate replayed bit-exact
from its `ScoreLog` receipts, and every resolved venue's stored score
checked against `Run.correct` (exit 1 on any violation). When the
snapshot rides `web/MANIFEST`, the loader sha256-checks the bundle
first and warns loudly on a mismatch. `chain modelrec` prints the same
per-record replay verdict inline.
`chain feed [--limit N] [--type a,b] [--since t] [--pk k] [--model id]` is the cross-type
chronology — every timestamped event across both programs (bank
created, run queued, MPC finalized, receipt minted, venue opened,
resolved, fingerprint revealed, access granted) newest-first, so the
causal chains are visible: a `reveal` event followed by runs stamped
post-reveal, a `score` followed by its `receipt` and the venue that
priced it. `--type` accepts the event classes
`bank,run,score,receipt,venue,resolution,reveal,grant`; `--pk <key>`
filters to events that touch an account — its own pubkey OR a
referenced one (a venue's runs, a receipt's record/bank, a grant's
delegate) — so one account's custody narrative is a one-line query,
and each matched row annotates `· via <class> <key>` (the role the
filtered key played in that event: its run, its bank, its record).
`--model <id>` filters to one model's timeline — its runs, scores,
receipts, and every venue event whose refs touch its runs — the
dossier's chronological counterpart. `--bank <pk|name>` is the same
join anchored on an exam — the bank's own creation/runs/reveals/grants
plus every venue event whose run refs resolve to it (a venue references
runs, not banks, so the bank timeline follows custody one hop deep).
`chain bank <pk|name>` is the per-benchmark dossier — spec (kind,
authority, chunks sealed, items_root, fee), run totals (finalized,
pending, post-reveal-stamped, best score), the exam's difficulty
curve (score distribution across models — min/p25/median/p75/max with a
spread verdict: discriminating exams separate models, tight ones
don't), receipt summary (vouched /
post-reveal), every fingerprint reveal with timestamps, reshare-grant
count, stored item-chunk counts, and every venue type priced against
the bank with open/resolved breakdown. Ambiguous names list the
matching public keys and exit 2 — disambiguation is never guessed.
`chain wallet <pk>` is the actor dossier — every role one address plays
across both programs: banks authored, runs submitted (with recent
scores), receipts recorded, venues created, bounties sponsored
(escrow still locked), positions held with wagered totals, and reshare
grants addressed to it. `bank` is the subject view, `market venue` the
instrument view, `wallet` the actor view — the audit triangle closes.
`market bounties` is the runner-facing index — open capability bounties
sorted by pot, marking which are claimable NOW under the exact
`bounty_qualifies` rules (retroactivity wall, no self-deal, proven runs,
no post-reveal) and which expired ones just need `expire_bounty` to
refund their sponsor.
`chain market venue <pk>` is the single-venue dossier — kind and status,
per-outcome pools, positions held, fees accrued, the run(s) it prices,
the book — every stake classified bettor-by-bettor like `market positions` does — its live keeper classification (the same verdict `market board`
assigns), and — when resolved — its stored score re-verified against
`Run.correct`, with duel `(a << 16) | b` packing and ladder `resultMask`
handled. `chain trail` traces one run across venues; `market venue` is
the mirror image — one venue across its runs and bettors.
`chain market position <pk>` is the bettor-side dossier for a single
position — the commitment (per-bucket amounts or the sealed dark
commitment), the venue it rides on, and the same PAYS/REFUND/RENT/
FORFEIT classification `positions` computes, plus the exact claim
command when money is due. The audit triangle is complete: `bank`
(subject), `market venue` (instrument), `wallet` (actor), `trail` (run),
`market position` (stake).
`chain market quote <venue> --outcome <i> --lamports <n>` is the
pre-transaction simulator — the same parimutuel math the program
settles with, run locally over the venue's current book: estimated
payout if your side wins, ROI, and the share the pool already implies
on that outcome. Ladders bound outcomes by `legCount` (not the
8-slot totals array), resolved/cancelled venues refuse, and dark
markets quote honestly as a scenario range — a sealed position's
payout depends on who reveals, so it prints only-you-win / pool-stays
/ zero-reveals (gross refund) instead of a single number it can't
know. The hosted explorer carries the same math as a per-venue
widget — every open band/duel/ladder card and every open dark card
has an inline stake simulator, no wallet required. `chain market odds
[venue]` is the sibling view: the *implied-probability distribution*
itself — what the pool weights say about each outcome (decimal odds =
post-fee pot ÷ side), funded venues first, per-leg model labels —
the market's opinion to set against the evidence leaderboards.
`chain market sentiment` goes further — every open funded book pooled
into a stake-weighted belief per model: duels and ladders contribute
win probability (tie books split half to each side), bands contribute
an implied expected score. `compare --all` says what the data PROVES;
this says what the money EXPECTS. `chain market champions` completes
the lens set — the settlement record per model: duel W-D-L, ladder
leg wins (dead-heat masks count each co-winner), bounty claims. Where
`records` ranks by score receipts, `champions` ranks by what money
resolved on — the opinion a model can't argue with. `chain market
divergence` then diffs two of the rankings directly: evidence rank
(shared-bank W-L) vs conviction rank (stake weighed) — a positive gap
means the money prices a model above its receipts (the paired evidence
ranks it worse than the books do), a negative gap the reverse, and a
model present on only one side is reported as exactly that finding.
`chain market calibration` is the report card: across every resolved
venue with a book, the implied share the actual winner carried at
close, per-venue Brier scores, and the favorite hit-rate — all against
a uniform-betting baseline, all re-derivable because every resolution
checks against `Run.correct` (on the committed ledger: favorites hit
87%, winners carried ~55% implied at close vs a ~40% uniform baseline).
`chain model
<pk|model_id>` fuses all four lenses into one dossier: the registry
aggregate (receipt-replayable), the paired-evidence rank, the
settlement record, the market's current belief, and the run history —
the whole answer to "what does the system know about this model?"
`chain watch [--interval s] [--type a,b] [--model id] [--bank b]` is the live pulse —
a `feed` tail that polls and prints new events oldest-first as they
land, deduplicated by a bounded seen-set; with `--snapshot` it becomes
a replay ticker (the bundle's last events, then idle).
`chain search <pk>` is the front door to all of them — the same
universal resolver as the explorer's `?pk=` box: it identifies what a
pubkey IS (benchmark, run, ScoreLog receipt, ModelRecord, reveal,
grant, item chunk, any venue kind, position) and prints the dossier
command that answers questions about it. A key that isn't an account
but signs activity resolves to the actor dossier (`chain wallet`).
`chain tour` strings the whole set into a narrative — seven stops
(stats → search → the most-venue'd run's trail → its filtered feed →
the biggest venue's book → a bettor's P&L → the pooled market
sentiment plus the top evidence-vs-conviction divergences) with
exhibits picked live
from the data, so a first-time reader gets the system's story in one
command instead of assembling it.
`packages/harness/src/snapshot.ts` decodes the committed evidence
bundle (`web/snapshot.json`) through the same discriminator-keyed
borsh layouts the RPC path uses, so the surfaces replay **keyless and
connection-free**:

```bash
sealed chain market board --snapshot web/snapshot.json   # 36 actionable — the explorer's keeper panel, in the CLI
sealed chain gate dark/model-a --min-pct 80 --min-runs 5 --snapshot web/snapshot.json
sealed chain market positions --snapshot web/snapshot.json --viewer <pubkey>
```

`positions` in snapshot mode takes `--viewer <pubkey>` — a read-only
look at any wallet's book without a keypair. Write paths (`sweep`,
`claim`, `open`, …) stay RPC+signer only, obviously.

## `market` — four parimutuel primitives + capability bounties on `Run.correct`

Every creator rejects runs that have begun scoring (`ScoringStarted`), runs
flagged `post_reveal` (`PostRevealRun`), and bait-shaped edge layouts.

| ix set | primitive | resolution |
|---|---|---|
| `create_market` / `bet` / `resolve` / `claim` / `claim_fee` / `void_market` / `expire_market` | score-band: `outcome_of(edges, n, correct)` | bucket edges must leave every outcome reachable; expiry refunds |
| `create_duel` / `bet_duel` / `resolve_duel` / `void_duel` | duel: two runs, same bank class | A wins / B wins / tie bucket; distinct runner keys required |
| `create_ladder` / `bet_ladder` / `resolve_ladder` / `claim_ladder` / `claim_fee_ladder` / `void_ladder` | race: 3–8 ordered legs | argmax → `result_mask` bitmask, dead-heats split pro-rata; legs landing nothing score 0, landed partials count |
| `create_dark` / `dark_bet` / `resolve_dark` / `reveal_dark` / `finalize_dark` / `claim_dark` / `claim_fee_dark` / `void_dark` / `expire_dark` | commit-reveal: bet tx carries only a salted sha256 | resolved → reveal window (60s–90d) → tally; zero reveals or void → gross refund; fee gated on `tallied` |

Plus a non-parimutuel primitive — no bettors, the pot pays the operator:

| ix set | primitive | settlement |
|---|---|---|
| `create_bounty` / `claim_bounty` / `expire_bounty` | capability bounty: sponsor escrows SOL on "first run scoring ≥ `threshold`" | FCFS — the first *proven* run claims; gates: same bank, run postdates bounty creation, `runner ≠ sponsor`, `correct ≥ threshold`, finalized-or-proven, not `post_reveal` — and the claim tx itself must land by `deadline` (a total deadline: entry *and* proof must exist on-chain before it; afterwards only `expire_bounty` remains). `payee` pinned to `run.runner` so front-running can't redirect. Past `deadline`, `expire_bounty` closes the account to the stored sponsor. Claimed bounties persist as permanent `winner_run`/`winning_score` evidence. |

`unbrick_pda(seeds, bump)` exists here too — same generic grief-dust
reclaim (market/duel/position/ladder/dark/darkpos/bounty layouts), e.g.
`chain unbrick market position <market> <bettor>`.

## `encrypted-ixs` — the six Arcis circuits

```rust
seal_part(Enc<Shared, AnswerPart>)          -> Enc<Mxe, AnswerPart>
gen_part(benchmark_id, base_index)          -> (GenPart, Enc<Mxe, AnswerPart>)
gen_part_private(benchmark_id, base_index)  -> (Enc<Shared, GenPart>, Enc<Mxe, AnswerPart>)
reshare_part(Enc<Mxe, Pack<GenPart>>, viewer_x25519) -> Enc<Shared, Pack<GenPart>>
reveal_part(Enc<Mxe, AnswerPart>)           -> AnswerPart            // plaintext u64 fingerprints
score_chunk(outputs[32]u64, Enc<Mxe, AnswerPart>×4) -> u8            // count only — match bits stay inside
```

Only `reveal_part` returns plaintext — and only fingerprints (SHA3-256
truncated u64s), which is why a landed reveal burns the bank for future
runs. `score_chunk` reveals a count, never per-item results.

Measured per-instruction compute-unit costs live in [costs.md](costs.md)
(queue-side MPC ixs ~110-150k CU, callbacks ~130-160k, market ops ~4-16k).
