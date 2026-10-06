# Compose on Sealed

Sealed's scored outputs are permissionless read surfaces — no CPI, no
permission, no vendor key. Any program, client, or market resolves against
`Run.correct` and the capability registry the same way the bundled `market`
program does. This document is the byte-accurate consumer guide; the market
program (`programs/market/src/lib.rs`) is the reference implementation.

## The three read surfaces

| Account | PDA seeds | What a consumer gets |
| --- | --- | --- |
| `Run` (sealed) | `[b"run", benchmark, run_index.to_le_bytes()]` | `correct`, `status`, `scored_mask`/`pending_mask`, `outputs_root`, `attested`, `post_reveal` |
| `ScoreLog` (sealed) | `[b"scorelog", run]` | one enrollment receipt per run — `correct`, `items`, `vouched_at_record`, `post_reveal` |
| `ModelRecord` (sealed) | `[b"modelrec", sha256(model_id)]` | aggregate per-`model_id`: `runs_scored`, `total_correct`, `total_items`, `best_*` |

The IDLs are committed at `target/idl/sealed.json` and `target/idl/market.json`.

## On-chain: the `load_run` pattern

A consumer program never trusts account identity — it checks **owner +
discriminator**, then deserializes a mirror struct. This is verbatim the
market program's gate:

```rust
pub const SEALED_PROGRAM: Pubkey =
    pubkey!("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");
pub const RUN_DISC: [u8; 8] = [0xc7, 0x36, 0x9b, 0x56, 0xeb, 0x73, 0xf6, 0xbd];

fn load_run(info: &AccountInfo) -> Result<Run> {
    require!(info.owner == &SEALED_PROGRAM, ErrorCode::WrongRun);
    let data = info.try_borrow_data()?;
    require!(data.len() > 8 && data[..8] == RUN_DISC, ErrorCode::WrongRun);
    Run::try_deserialize_unchecked(&mut &data[..])
}
```

The mirror `Run` struct must be byte-identical through `all_queued_at` —
`sealed` appends `post_reveal: u8` as a **tail byte** past the mirror's end,
read by fixed offset:

```rust
// disc8 + 176B fixed + u32 len + model_id + 41B tail + post_reveal1
fn run_post_reveal(info: &AccountInfo) -> Result<bool> {
    let data = info.try_borrow_data()?;
    if data.len() < 188 { return Ok(false); }           // pre-upgrade: clean
    let ml = u32::from_le_bytes(data[184..188].try_into().unwrap()) as usize;
    Ok(data.get(229 + ml).copied().unwrap_or(0) != 0)
}
```

`load_benchmark` reads `Benchmark` the same way — every field a resolver
needs (`status@45`, `chunk_count@46`, `kind@106`) precedes the
variable-length `name`, so layout growth never bricks the reader.

## Off-chain: TypeScript

```ts
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

const SEALED = new PublicKey("FGVuEoWpDGTqBBuR9e26t2t5mDngXgbrAj5CtuLKXLUZ");

// capability registry: aggregate MPC-scored record for any claimed model_id
const [modelRecord] = PublicKey.findProgramAddressSync(
  [Buffer.from("modelrec"), createHash("sha256").update(modelId).digest()],
  SEALED
);
// per-run receipt the registry aggregates
const [scoreLog] = PublicKey.findProgramAddressSync(
  [Buffer.from("scorelog"), runPk.toBuffer()], SEALED
);
```

The browser explorer (`explorer/index.html`) does exactly this — reads any
RPC, verifies Merkle proofs against `Run.outputs_root` in-browser, zero
trust in the host.

## The honesty contract a consumer must respect

`Run.correct` is only as meaningful as the flags beside it. Consumers that
ignore these are reimplementing the failure modes Sealed exists to prevent:

- **`status`** — a still-scoring run's `correct` is a partial. Settle only
  on a *fair settle value*: finalized, or fully committed (`ever_queued_mask`
  complete) past its expiry horizon. An uncommitted stall is a chosen
  truncation — refund, don't settle.
- **`post_reveal`** — a run created after `reveal_part` declassified a
  fingerprint on its bank could commit to now-public scoring targets.
  Markets refuse to open on flagged runs; consumers should too.
- **`attested` / `vouched_at_record`** — the benchmark authority's venue
  verification, snapshotted at record time. Weight it to separate
  venue-verified evidence from self-report — `model_id` is a *claim*.
- **`ScoreLog.post_reveal`** — the same flag at enrollment time; later
  reveals show as later events, never retroactive contamination.

## Composability, executable: `chain gate`

The canned example is a capability gate — the "insurers and DAOs pricing
capability risk" surface as a one-line command:

```bash
# exit 0 if the model's MPC-scored record clears the policy, 1 on fail,
# 2 when there is no evidence (absent proof ≠ disproof)
sealed chain gate qwen2.5-3b --min-pct 60 --min-runs 2 --vouched
sealed chain gate <record-pda> --min-items 128 --json
sealed chain gate llama-3.2-1b --wilson 50 --no-post-reveal
sealed chain gate qwen2.5-3b --min-pct 60 --bank sealed-v77007   # policy scoped to one exam
sealed chain gate --all --min-pct 70 --min-runs 2   # the leaderboard filtered by policy
sealed chain gate --all --min-pct 60 --bank <bank>  # per-exam leaderboard — who clears it HERE
sealed chain gate --all --min-pct 60 --min-runs 3 --prove claims/
#   ↑ every passer mints a sealed-claim/v1 card — verify each with
#     `chain prove --verify claims/<model>.json` (PDAs re-derive keyless)
sealed chain gate --sweep [--grid 10,30,50,70,90]
#   ↑ every record re-evaluated across a min-pct grid — the strictest
#     line a model survives is its "frontier"; no threshold can be gamed
sealed chain prove --all --out claims/ && sealed chain prove --verify claims/
#   ↑ the whole registry as verifiable artifacts — one card per record,
#     directory batch-verification, exit 1 on any failure
```

`--vouched` restricts evidence to venue-attested runs
(`vouched_at_record`); `--no-post-reveal` drops receipts minted after the
bank's fingerprints were revealed (they're always reported, never
silently counted); `--bank <pk|name>` scopes the policy to one benchmark —
a name resolves every same-named bank; `--wilson N` applies the 95% lower
confidence bound so
a 3/3 perfect sample can't flatter a strict accuracy floor. `--json`
emits `{pass, scope, runs, items, correct, pct, postRevealRuns,
checks[]}` for scripted policy. The evaluation is pure
(`packages/harness/src/gate.ts` — `evalGate(receipts, policy)`) —
the same verdict runs against a live RPC or the explorer's committed
snapshot, no trust in the caller's box. `chain history <model>` is the
complement: the raw receipt trajectory with running accuracy after each
run — a regression detector read straight off the receipts.

`chain market board` is the sibling read surface for venues: a pure
classifier (`board.ts`) that turns the account set into a keeper
inventory — claimable bounties (same `bounty_qualifies` gates the program
enforces: bank match, retroactivity wall, runner ≠ sponsor, threshold,
finalized-or-proven, not post-reveal), resolvable markets and ladders
(the ladder gate is `!still_moving` per leg, not `resolve_by`), resolved
darks awaiting `finalize_dark`, and sweepable expiries annotated
settle-vs-refund. Every read command also takes `--snapshot
web/snapshot.json` — `packages/harness/src/snapshot.ts` decodes the
committed bundle through the same discriminator-keyed layouts the RPC
path uses, so `board`, `gate`, `history`, `records`, `status`,
`banks`, `bank`, `stats`, `runs`, `feed`, `watch`, `verify`, `trail`, `grants`,
`reveals`, `market bounties`, `market venue`, `market position`, `market quote`,
`market odds`, `market sentiment`, `market champions`, `market divergence`, `market calibration`, `market live`, `market sharps`, `market escrow`, `anomalies`, `model`, `matrix`, `wallet`, `search`, `tour`, `gate --sweep`, `compare --matrix`, `prove` (+`--all`, `--verify`), and `market positions --viewer <pk>` replay
**keyless, connection-free** (and a unit test pins the replay against
the bundle's published counts). `chain export --snapshot <f>` emits the
same verdicts as a portable `sealed-evidence-digest/v1` JSON — diffable
across deployments, CI-gateable via exit code; `chain diff <a> <b>`
compares two bundles account-by-account (added/removed/mutated per
type) so a judge can re-dump devnet and prove the committed bundle is
intact inside it. `chain stats` is the integrator's health probe: counts,
escrow, fees, and two recomputed verdicts — every `ModelRecord` aggregate
replayed bit-exact from receipts, every resolved venue score checked
against `Run.correct` — with exit 1 on a violation, so a pipeline can gate
on the registry's own arithmetic.
Third-party keepers don't need our binary — the table
above is the whole read contract. `chain market sweep` goes one step
further: it executes every permissionless action the board lists —
the no-operator design as a runnable cron job (bounty pots still pay the
winning run's operator on-chain, never the sweeper). The explorer renders
the same classification in-page over the committed snapshot — on the
bundled ledger it flags 36 actionable venues (resolvable markets and
ladders, a tallyable dark, and expired bounties worth ~0.25 SOL to their
sponsors).

## What a consumer never gets

The answer key. `items_root`/`outputs_root` are Merkle commitments — the
plaintext fingerprints live inside the MXE cluster's sealed state and are
scored there. Composing on the *result* is free; learning the *truth* early
is cryptographically priced out. That's the primitive everything else
builds on.
