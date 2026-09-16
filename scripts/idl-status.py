import json
idl = json.load(open("/home/joseph/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/arcium-client-0.14.1/idls/arcium.json"))
for t in idl["types"]:
    if "ComputationStatus" in t["name"] or t["name"] == "ComputationAccount":
        print(json.dumps(t, indent=1)[:2000])
        print("---")
