#!/usr/bin/env bash
# Regenerate docs/evidence account dumps from the live localnet.
# v4-epoch identifiers (all_queued_at build):
#   bank 25864 (authored re-seal of MPC-minted specs) + its clean/stale run pair,
#   gen bank 6932 + its two mock runs + 3 resolved markets,
#   private bank 6933 + one delegate grant.
set -u
cd /home/joseph/code/sealed/docs/evidence
for pk in \
  6ZTikUCZ4tAEtcMai29X7bNLBjJU5RDqHcv6xXBnH9Cd \
  EQsejQ899p9ZjrBfXKT8LRW1dyZdNgTKbGqMjRGDaJkW \
  VyAAjrsBiUkMumc8PqpA9nTzMyBsQ7uHMDf1AWQHFk3 \
  4uns99WDqEFZCzNXa7KhW361CKd4XB5x7CLDX8THfJZ1 \
  3CKnMa8Xbr3ph5BZZ94Q6STXWMS27YfMJUoK5iF5JXka \
  FPsmr36jVjHk1X6DnPG21WrrZJ1fUGQGhDdcxaJw1bod \
  zbgZVGwLLvi9YcUsy3VZTpVLuw2qf6bHcdVsbZjEydj \
  Cesn1pNBLAJt1ymyaAahfwzh77bZbgPXCrcarxJKFXqw \
  52tXNbsXCrCfm8RRDd7JhwYhmJfLeypCcJEMvqcu1wfL \
  5wtfwEkEaQWLsp7ofunskbnq2TW9GWSZpQGp3HXrZsnc \
  3Kv748WJeawooGXtMJcYAKv6YwsjpJJMBwi1fSxxfByG ; do
  solana account "$pk" --output json -u http://127.0.0.1:8899 > "acct-$pk.json" 2>/dev/null \
    && echo "$pk OK" || echo "$pk FAIL"
done
