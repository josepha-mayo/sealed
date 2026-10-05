const m = await import("./src/chain.ts");
const S = "/home/joseph/code/sealed/web/snapshot.json";
const p = m.chainModel("dark/model-a", false, S);
console.log("awaiting…");
const r = await Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error("20s TIMEOUT")), 20000))]).catch((e) => "ERR: " + e?.message);
console.log("done:", typeof r === "string" ? r : JSON.stringify(r)?.slice(0, 200));
