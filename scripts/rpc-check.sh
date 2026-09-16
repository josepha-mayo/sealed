#!/usr/bin/env bash
for url in https://rpc.ankr.com/solana_devnet https://solana-devnet.publicnode.com https://api.devnet.solana.com; do
  printf "%-55s " "$url"
  curl -s -m 10 -X POST "$url" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | head -c 200
  echo
done
