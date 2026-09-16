#!/usr/bin/env bash
d=~/code/sealed/artifacts/arx_node_logs
for f in $(ls -t "$d"/*.log | head -4); do
  echo "== $f"
  tail -25 "$f" | grep -v "Router likely dropped\|RemoveProtocol"
done
