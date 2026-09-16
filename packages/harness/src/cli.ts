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
import { buildBank, publicSummary, type Bank } from "./bank.js";
import { ModelClient, MockModelClient, DEFAULT_CONFIG } from "./models.js";
import { runModel, type RunArtifact } from "./run.js";
import { merkleProof, outputLeaf } from "./hash.js";

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
          apiBase: args["api-base"] as string | undefined,
        });
    const cfg = { ...DEFAULT_CONFIG, maxTokens: args["max-tokens"] ? Number(args["max-tokens"]) : DEFAULT_CONFIG.maxTokens };
    const t0 = Date.now();
    const artifact = await runModel(bank, model, client, cfg, (done, total) => {
      if (done % 16 === 0 || done === total) process.stderr.write(`\r${model}: ${done}/${total}`);
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
    const leaves = run.items.map((r) => outputLeaf(r.index, BigInt(r.outputHash)));
    console.log(JSON.stringify({
      model: run.model, itemIndex: i,
      canonical: rec.canonical, outputHash: rec.outputHash,
      leaf: Buffer.from(leaves[i]).toString("hex"),
      proof: merkleProof(leaves, i).map((p) => Buffer.from(p).toString("hex")),
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
  sealed run        --bank <file> --model <id> [--concurrency 6] [--retries 4] [--max-tokens 4096] [--out file]
                    (model "mock/oracle-<p>" answers a fraction p correctly, offline)
  sealed chain init                                   init comp defs + upload circuits (once per deployment)
  sealed chain seal  --bank <file> [--fee-lamports n]
  sealed chain score --bank <file> --run <file> [--create-only] [--run-index n]
  sealed chain status --benchmark <pubkey>
  sealed chain market open    --run <pubkey> --edges <40,55[,64..]> [--salt n]   N-way buckets; --threshold n = binary
  sealed chain market bet     --market <pk> --outcome <i> --lamports <n> [--bettor keypair.json]   (--side yes|no for binary)
  sealed chain market resolve --market <pk>
  sealed chain market claim   --market <pk> [--bettor keypair.json]
  sealed chain market show    --market <pk>
  sealed prove  --run <file> --item <i>               Merkle proof that output i was committed`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
