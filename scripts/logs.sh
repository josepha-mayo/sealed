#!/usr/bin/env bash
# Show Arcium localnet program logs and any errors from the last `arcium test` run.
cd "$(dirname "$0")/.."
echo "== artifacts/program-logs"
ls -la artifacts/program-logs 2>/dev/null
for f in artifacts/program-logs/*; do
  [ -f "$f" ] || continue
  echo "== $f (errors)"
  grep -n -i -E 'error|abort|fail|panic|invalid|mismatch|sealed|score' "$f" | grep -v -E 'Stack offset' | head -40
done
echo "== validator: failed transactions / program logs mentioning sealed program"
PID=$(grep -o 'sealed = "[A-Za-z0-9]*"' Anchor.toml | cut -d'"' -f2)
grep -n -E "Program $PID|Program log|failed|custom program error" .anchor/test-ledger/validator.log 2>/dev/null | grep -v -E 'metrics|Stack offset' | tail -60
