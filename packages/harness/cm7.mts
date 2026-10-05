console.log("A");
const m = await import("./src/chain.ts");
console.log("B");
const p = m.chainModel("x", true, "/home/joseph/code/sealed/web/snapshot.json");
console.log("C", p && typeof p.then);
p.then((r: any) => console.log("RESOLVED", r)).catch((e: any) => console.log("REJECTED", e?.message ?? e));
console.log("D");
