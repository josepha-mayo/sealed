#!/usr/bin/env bash
d=~/code/sealed/artifacts/arx_node_logs
ls -la "$d" 2>/dev/null
for f in "$d"/*; do
  echo "== $f"
  tail -8 "$f"
done
