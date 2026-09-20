#!/usr/bin/env bash
# Regenerate docs/evidence account dumps from the live localnet.
set -u
cd /home/joseph/code/sealed/docs/evidence
for pk in \
  6ZTikUCZ4tAEtcMai29X7bNLBjJU5RDqHcv6xXBnH9Cd \
  9Pkx2TkW6FAxLzvR1nR8HX1jHehuQPhUBqGqQj6HqDc3 \
  6VFa9SqksupE6EQZMPn2wJ2K2ki3iYPkSoKPG9GvDjQE \
  4uns99WDqEFZCzNXa7KhW361CKd4XB5x7CLDX8THfJZ1 \
  F75o5JjAk17YnrQTwf61FE5rCywpWjXAAaGU536rMBcV \
  ADJz27sF71rhMRK1AT8CngqEd5L3AdcoTj4wPVheaZ21 \
  EcgwuxexDW7ZmrQMape8vZvQv3KQPGUNW3N5vpduB32D \
  EH3wCWEdaQwH1Nze7ZARV72fsydFLHsdNDwrZguk8CAD \
  7mPoyFpbRCvWxLz9m4FsVf798v384wgQxFVD5JD5ok2W ; do
  solana account "$pk" --output json -u http://127.0.0.1:8899 > "acct-$pk.json" 2>/dev/null \
    && echo "$pk OK" || echo "$pk FAIL"
done
