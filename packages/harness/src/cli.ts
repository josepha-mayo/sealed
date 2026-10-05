#!/usr/bin/env tsx
/**
 * sealed CLI
 *   bank build --seed <s> --id <n> --chunks <k> [--out bank/<id>.json]
 *   bank show  --bank <file>                      public summary only
 *   run        --bank <file> --model <id> [--out runs/<model>-<ts>.json] [--concurrency n]
 *   chain ...  see chain.ts (requires a built program IDL)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBank, publicSummary, CHUNK, type Bank } from "./bank.js";
import { ModelClient, MockModelClient, DEFAULT_CONFIG } from "./models.js";
import { runModel, type RunArtifact } from "./run.js";
import { chunkOutLeaves, merkleProof } from "./hash.js";

type Args = Record<string, string | boolean>;

function parse(argv: string[]): { cmd: string[]; args: Args } {
  const cmd: string[] = [];
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[k] = next;
        i++;
      } else args[k] = true;
    } else cmd.push(a);
  }
  return { cmd, args };
}

function need(args: Args, k: string): string {
  const v = args[k];
  if (typeof v !== "string" || !v) throw new Error(`missing --${k}`);
  return v;
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function loadBank(path: string): Bank {
  const bank = JSON.parse(readFileSync(path, "utf8")) as Bank;
  if (bank.schema !== "sealed.bank/1") throw new Error(`not a bank file: ${path}`);
  return bank;
}

async function main() {
  const { cmd, args } = parse(process.argv.slice(2));
  const [c0, c1] = cmd;

  if (c0 === "bank" && c1 === "build") {
    const seed = (args.seed as string) || process.env.SEALED_MASTER_SEED;
    if (!seed) throw new Error("--seed or SEALED_MASTER_SEED required");
    const id = Number(need(args, "id"));
    const chunks = Number(args.chunks ?? 10);
    const bank = buildBank(seed, id, chunks);
    const out = (args.out as string) || join("bank", `${id}.json`);
    writeJson(out, bank);
    console.log(JSON.stringify({ wrote: out, ...publicSummary(bank) }, null, 2));
    return;
  }

  if (c0 === "bank" && c1 === "show") {
    console.log(JSON.stringify(publicSummary(loadBank(need(args, "bank"))), null, 2));
    return;
  }

  if (c0 === "run") {
    const bank = loadBank(need(args, "bank"));
    const model = need(args, "model");
    const client = MockModelClient.isMock(model)
      ? new MockModelClient(new Map(bank.items.map((it) => [it.prompt, it.answer])))
      : new ModelClient({
          concurrency: args.concurrency ? Number(args.concurrency) : undefined,
          retries: args.retries ? Number(args.retries) : undefined,
          timeoutMs: args.timeout ? Number(args.timeout) : undefined,
          apiBase: args["api-base"] as string | undefined,
        });
    const cfg = { ...DEFAULT_CONFIG, maxTokens: args["max-tokens"] ? Number(args["max-tokens"]) : DEFAULT_CONFIG.maxTokens };
    const t0 = Date.now();
    const artifact = await runModel(bank, model, client, cfg, (done, total) => {
      if (done % 4 === 0 || done === total) process.stderr.write(`\r${model}: ${done}/${total}`);
    });
    process.stderr.write("\n");
    const out =
      (args.out as string) || join("runs", `${model.replace(/[^a-z0-9._-]+/gi, "_")}-${artifact.startedAt.replace(/[:.]/g, "-")}.json`);
    writeJson(out, artifact);
    console.log(
      JSON.stringify(
        {
          wrote: out,
          model,
          items: artifact.items.length,
          localCorrect: artifact.localCorrect,
          localAccuracy: +(artifact.localCorrect / artifact.items.length).toFixed(4),
          outputsRoot: artifact.outputsRoot,
          harnessHash: artifact.harnessHash,
          seconds: Math.round((Date.now() - t0) / 1000),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (c0 === "prove") {
    const run = JSON.parse(readFileSync(need(args, "run"), "utf8")) as RunArtifact;
    const i = Number(need(args, "item"));
    const rec = run.items[i];
    if (!rec) throw new Error(`no item ${i}`);
    // Two-level commitment: the chunk preimage proves the output's position
    // inside the chunk; the Merkle path binds the chunk to outputs_root — the
    // same root score_chunk enforces on-chain.
    const ci = Math.floor(i / CHUNK);
    const leaves = chunkOutLeaves(run.items.map((r) => BigInt(r.outputHash)));
    console.log(JSON.stringify({
      model: run.model, itemIndex: i,
      canonical: rec.canonical, outputHash: rec.outputHash,
      chunkIndex: ci,
      chunkOutputs: run.items.slice(ci * CHUNK, (ci + 1) * CHUNK).map((r) => r.outputHash),
      proof: merkleProof(leaves, ci).map((p) => Buffer.from(p).toString("hex")),
      outputsRoot: run.outputsRoot,
    }, null, 2));
    return;
  }

  if (c0 === "chain") {
    const { chainMain } = await import("./chain.js");
    await chainMain(cmd.slice(1), args);
    return;
  }

  console.error(`usage:
  sealed bank build --seed <s> --id <n> [--chunks 10] [--out bank/<id>.json]
  sealed bank show  --bank <file>
  sealed run        --bank <file> --model <id> [--concurrency 6] [--retries 4] [--timeout 90000] [--max-tokens 4096] [--out file]
                    (model "mock/oracle-<p>" answers a fraction p correctly, offline)
  sealed chain init                                   init comp defs + upload circuits + eager signer-PDA init (once per deployment)
  sealed chain init-signer                            standalone signer-PDA init — drains a grief-prefund and (re)creates it
  sealed chain unbrick <sealed|market> <kind> <args…>                    reclaim lamports griefed onto a program PDA
                                     (re-derives the address from canonical seeds, drains dust to you — bare "unbrick" prints kinds)
  sealed chain seal  --bank <file> [--fee-lamports n]
  sealed chain gen   --id <n> [--chunks 2] [--fee-lamports n] [--out file]   MPC-minted bank: no answer key exists
  sealed chain items --benchmark <pubkey> [--out file] [--snapshot f]       render a generated bank from on-chain specs (snapshot = offline)
  sealed chain gen-private --id <n> [--chunks 2] [--fee-lamports n] [--out f] MPC-minted bank: items encrypted to YOU
  sealed chain pitems --benchmark <pubkey> [--out file]                     decrypt a private bank (authority only)
  sealed chain reshare --benchmark <pk> --chunk <i> --part <0..3> --to <viewer-pubkey>   grant a delegate the questions
  sealed chain grant  --benchmark <pk> --chunk <i> --part <0..3>             fetch + decrypt YOUR grant (delegate)
  sealed chain grants --benchmark <pubkey> | --viewer <pk>                 list ShareGrant PDAs — per bank, or "what can I see" per delegate
  sealed chain reveals --benchmark <pubkey>                                the fingerprint-disclosure audit trail
  sealed chain delegate-bank --benchmark <pubkey> [--out file]             rebuild a bank from YOUR grants (delegate)
  sealed chain score --bank <file> --run <file> [--create-only] [--run-index n] [--authority <pk>]
  sealed chain reveal --benchmark <pk> --chunk <i> --part <0..3>   authority declassifies 8 answer hashes
  sealed chain verify --benchmark <pk> --run <file> [--run-index n]  audit revealed hashes vs committed outputs
  sealed chain status --benchmark <pubkey>
  sealed chain attest --run <pubkey>                       authority marks a finalized run as venue-vouched
  sealed chain record --run <pubkey>                       enroll a finalized run's MPC score in the on-chain capability registry (permissionless)
  sealed chain record --all [--watch s]                        enroll EVERY finalized-but-unrecorded run — the permissionless librarian (--watch = daemon)
  sealed chain modelrec <pubkey|model_id>                  show a model's aggregated score record
  sealed chain model <pk|model_id> [--json] [--snapshot f] the fused dossier — registry · evidence rank · settlement · belief · runs
  sealed chain records                                     list every model record, accuracy-first
  sealed chain banks [--kind authored|generated|private]          list every benchmark, run-count first
  sealed chain matrix [--banks N] [--json]                        the capability matrix — models × most-run banks, best score per cell
  sealed chain stats                                       the dashboard — counts, escrow, bit-exact integrity verdicts
  sealed chain export [--snapshot <f>] [--out file]        the portable integrity digest — bundle or live cluster
  sealed chain diff <a.json> <b.json>                      two bundles — account deltas + both integrity verdicts
  sealed chain feed [--limit N] [--type a,b] [--since t] [--pk k] [--model id]   the activity stream — runs, venues, resolutions in time order
  sealed chain bank <pk|name>                              one benchmark's dossier — spec, runs, venues, reveals
  sealed chain wallet <pk>                                 one address's footprint — banks, runs, venues, positions, grants
  sealed chain runs [--bank b] [--model m] [--min-pct n]   # the run substrate — who scored what where
  sealed chain compare <A> <B>                             head-to-head on shared benchmarks, paired deltas
  sealed chain compare --all [--min-shared n] [--wilson]     paired-evidence leaderboard (W-L-T over shared banks; --wilson = rank by 95% LCB)
  sealed chain trail <run-pk>                              custody chain: bank → receipt → venues, resolutions re-verified
  sealed chain market bounties                             the runner index: open capability bounties by pot
  sealed chain market venue <pk>                           one venue's dossier — pools, positions, keeper state, re-verified resolution
  sealed chain gate <model_id|record-pk> --min-pct N [--min-runs N] [--min-items N] [--wilson N] [--vouched] [--no-post-reveal] [--bank b] [--json]
  sealed chain gate --all <same policy flags>                          the gate as a leaderboard: who clears the policy, ranked
  sealed chain history <model_id|record-pk> [--json]                  capability trajectory: every ScoreLog receipt, oldest first
                                     capability gate over the on-chain registry — exit 0 pass / 1 fail / 2 no evidence
                                     (all read commands take --snapshot web/snapshot.json to replay the committed evidence bundle offline, keyless)
  sealed chain market board   [--json] [--snapshot file]                   keeper surface: claimable bounties, resolvable + sweepable venues
  sealed chain market sweep   [--bettor kp.json] [--watch secs]            execute every permissionless action the board lists (loop = keeper daemon)
  sealed chain market positions [--bettor kp.json|--viewer <pk>] [--json] [--snapshot file]
                                                                          your book: payable/refundable/live positions across all venues
  sealed chain market position <pk> [--json] [--snapshot file]              one position's dossier — stake, venue, payout class, claim cmd
  sealed chain market quote <venue> --outcome <i> --lamports <n> [--json]   bet simulator — payout if your side wins, no tx needed
  sealed chain market odds  [venue] [--json] [--snapshot file]              what the stakes believe — implied probabilities + decimal odds
  sealed chain market sentiment [--json] [--snapshot file]                  the stakes' per-model ranking — stake-weighted win%/score vs evidence
  sealed chain market champions [--json] [--snapshot file]                  the settlement record — duel W-D-L · ladder leg wins · bounty claims
  sealed chain market divergence [--json] [--snapshot file]                 evidence rank vs conviction rank — where money disagrees with receipts
  sealed chain market calibration [--json] [--snapshot file]                closing-book implied% on what resolved — favorite hit-rate + Brier vs uniform
  sealed chain search <pk> [--json] [--snapshot file]                       universal resolver — what IS this key? routes to the dossier
  sealed chain tour [--snapshot file]                                      the project demos itself — stats → trail → feed → book → P&L → sentiment
  sealed chain watch [--interval s] [--type a,b] [--model id] [--snapshot file]   the live pulse — feed events as they land (snapshot = replay ticker)
  sealed chain market open    --run <pubkey> --edges <40,55[,64..]> [--salt n]   N-way buckets; --threshold n = binary
                              [--fee-bps 0..1000] [--closes-at +secs|ts] --resolve-by +secs|ts  (required)
  sealed chain market duel    --run-a <pk> --run-b <pk> [--salt n]         head-to-head: does A outscore B? (A/B/tie)
                              [--fee-bps 0..1000] [--closes-at +secs|ts] --resolve-by +secs|ts  (required)
  sealed chain market bet     --market <pk> --outcome <i> --lamports <n> [--bettor keypair.json]   (--side yes|no for binary)
  sealed chain market resolve --market <pk>                                permissionless once the run finalizes
  sealed chain market claim   --market <pk> [--bettor keypair.json]        pays out (0 for losers) + closes position
  sealed chain market void    --market <pk> [--bettor keypair.json]        authority cancels, only before scoring starts
  sealed chain market expire  --market <pk>                                after resolve_by: refunds never-queued/uncommitted runs, settles a fully-committed stall on its proven partial
  sealed chain market claim-fee --market <pk> [--bettor keypair.json]      authority collects the accrued fee
  sealed chain market show    --market <pk>
  sealed chain market ladder open    --legs <pk,pk,...> [--salt n]         K-way race: argmax over leg scores, dead-heat ties
                                     [--fee-bps 0..1000] --closes-at +secs|ts (required) --resolve-by +secs|ts (required)
  sealed chain market ladder bet     --market <pk> --outcome <i> --lamports <n> [--bettor keypair.json]
  sealed chain market ladder resolve --market <pk>                       argmax settle once no leg is inside a landing window
  sealed chain market ladder claim   --market <pk> [--bettor keypair.json]
  sealed chain market ladder void    --market <pk> [--bettor keypair.json] authority cancels, only before any leg starts
  sealed chain market ladder claim-fee --market <pk> [--bettor keypair.json]
  sealed chain market ladder show    --market <pk>
  sealed chain market dark open      --run <pk> [--threshold n | --edges a,b,c] [--salt n]
                                     [--fee-bps 0..1000] [--closes-at +secs|ts] --resolve-by +secs|ts (required)
                                     [--reveal-secs n]                          commit-reveal market: outcomes stay sealed
  sealed chain market dark bet       --market <pk> --outcome <i> --lamports <n> [--pos-salt n] [--bettor keypair.json]
                                     prints the preimage — keep it, revealing without it is impossible
  sealed chain market dark reveal    --market <pk> --outcome <i> --salt <hex> [--pos-salt n] [--bettor keypair.json]
  sealed chain market dark finalize  --market <pk>                             tallies revealed winners after the reveal window
  sealed chain market dark resolve   --market <pk>                             permissionless once the run finalizes
  sealed chain market dark expire    --market <pk>                             after resolve_by: same committed-settle split as expire
  sealed chain market dark claim     --market <pk> [--pos-salt n] [--bettor keypair.json]
  sealed chain market dark void      --market <pk> [--bettor keypair.json]     authority cancels before scoring starts
  sealed chain market dark claim-fee --market <pk> [--bettor keypair.json]
  sealed chain market dark show      --market <pk>
  sealed chain market bounty open    --bank <pk> --threshold n --lamports n --deadline +secs|ts [--salt n] [--bettor k.json]
                                     FCFS capability bounty — first run to finalize >= threshold pays run.runner
  sealed chain market bounty claim   --bounty <pk> --run <pk>                permissionless trigger, pot lands on the operator
  sealed chain market bounty expire  --bounty <pk>                           after deadline: escrow returns to the sponsor
  sealed chain market bounty show    --bounty <pk>
  sealed chain reset-sealing  --bank-id <n> --chunk <i>          clear a part stuck by a dropped MPC computation
  sealed chain reset-pending  --run <pk> --chunk <i>             sweep a stuck scoring bit (runner anytime, anyone after 15min stale)
  sealed prove  --run <file> --item <i>               Merkle proof that output i was committed`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
