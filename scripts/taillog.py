import sys, glob, os
files = sorted(glob.glob("/home/joseph/code/sealed/.anchor/test-ledger/validator-*.log"), key=os.path.getmtime)
f = files[-1]
d = open(f, "rb").read()
print(f, len(d), "bytes")
print(d[-3000:].decode("utf8", "replace"))
