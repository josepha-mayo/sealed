#!/usr/bin/env bash
# usage: acct.sh <rpc> <pubkey>
curl -s -m 5 -X POST "$1" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$2\"]}" | head -c 300
echo
