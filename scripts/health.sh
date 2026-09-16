#!/usr/bin/env bash
curl -s -o /dev/null -m 5 -w "web:%{http_code}\n" http://127.0.0.1:8788/index.html
curl -s -m 5 -X POST http://127.0.0.1:8899 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | head -c 120
echo
