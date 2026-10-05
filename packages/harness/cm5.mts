const m = await import("./src/chain.ts");
const s = await import("./src/snapshot.ts");
const { PublicKey } = await import("@solana/web3.js");
const { createHash } = await import("crypto");
const S = "/home/joseph/code/sealed/web/snapshot.json";
console.log("load…");
const ss = s.decodeSnapshotSection(s.loadSnapshotJson(S), "sealed");
console.log("decode ok");
const keyOrName = "dark/model-a";
let pda: any;
try { pda = new PublicKey(keyOrName); } catch { [pda] = PublicKey.findProgramAddressSync([Buffer.from("modelrec"), createHash("sha256").update(Buffer.from(keyOrName, "utf8")).digest()], m.sealedProgramId()); }
console.log("pda", pda.toBase58());
const recAcc = s.snapOf(ss, "ModelRecord").find((x: any) => x.publicKey.equals(pda));
console.log("rec found?", !!recAcc, recAcc && String(recAcc.account.modelId));
