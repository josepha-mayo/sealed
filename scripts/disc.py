import hashlib
for n in ["AnswerChunk", "Benchmark", "Run", "Market", "Position"]:
    print(n, hashlib.sha256(("account:" + n).encode()).hexdigest()[:16])
