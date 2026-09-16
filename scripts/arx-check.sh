#!/usr/bin/env bash
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arcium-trusted-dealer-1; do
  echo "== $c"
  docker logs --timestamps --tail 3 "$c" 2>&1
  docker top "$c" 2>/dev/null | tail -2
done
