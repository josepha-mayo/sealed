import json
d = json.load(open("/home/joseph/code/sealed/artifacts/mxe_acc.json"))
print("pubkey:", d["pubkey"])
acc = d["account"]
print("owner:", acc.get("owner"), "lamports:", acc.get("lamports"), "dataLen:", len(acc.get("data", [""])[0]) if acc.get("data") else 0)
