// Targeted F1 check on the current ledger: find the benchmark with
// reveal_count > 0 (the suite's reveal test just landed one), mint a run,
// read post_reveal, try to open a market.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const anchor = require("@anchor-lang/core");
const { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const crypto = require("crypto");

const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Sealed;
const market = anchor.workspace.Market;
const owner = provider.wallet;
const SEALED = program.programId;
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

// scan benchmarks for one with revealCount > 0
const all = await program.account.benchmark.all();
let benchPk = null, bAcc = null;
for (const { publicKey, account } of all) {
  if (Number(account.revealCount ?? 0) > 0) { benchPk = publicKey; bAcc = account; }
}
if (!benchPk) { console.log("no spoiled benchmark found — did the reveal test land?"); process.exit(2); }
console.log("spoiled bank:", benchPk.toBase58(), "| revealCount =", Number(bAcc.revealCount), "| runCount =", bAcc.runCount.toString());

const runner = Keypair.generate();
const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({
  fromPubkey: owner.publicKey, toPubkey: runner.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL,
}));
await provider.sendAndConfirm(tx, []);

const idx = BigInt(bAcc.runCount.toString());
const [runP] = PublicKey.findProgramAddressSync([Buffer.from("run"), benchPk.toBuffer(), u64le(idx)], SEALED);
await program.methods
  .createRun("test/post-reveal-check", Array.from(crypto.randomBytes(32)), Array.from(crypto.randomBytes(32)))
  .accountsPartial({ runner: runner.publicKey, authority: owner.publicKey, benchmark: benchPk, run: runP })
  .signers([runner]).rpc({ preflightCommitment: "processed", commitment: "confirmed" });
const r = await program.account.run.fetch(runP);
console.log("new run", runP.toBase58(), "postReveal =", r.postReveal, "— expect 1");
if (Number(r.postReveal) !== 1) { console.log("FAIL: flag not set"); process.exit(1); }

const [mkt] = PublicKey.findProgramAddressSync([Buffer.from("market"), runP.toBuffer(), u64le(0n)], market.programId);
try {
  await market.methods
    .createMarket(new anchor.BN(0), [30], 0, new anchor.BN(0), new anchor.BN(Math.floor(Date.now() / 1000) + 86400))
    .accounts({ authority: owner.publicKey, run: runP, market: mkt })
    .signers([owner.payer])
    .rpc();
  console.log("FAIL: market opened on a flagged run");
  process.exit(1);
} catch (e) {
  const msg = String(e?.error?.errorCode?.code ?? e?.message ?? e);
  console.log("market open rejected:", msg.includes("PostRevealRun") ? "PostRevealRun ✓" : `unexpected: ${msg}`);
  process.exit(msg.includes("PostRevealRun") ? 0 : 1);
}
