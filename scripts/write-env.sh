#!/usr/bin/env bash
# Write a local .env (gitignored) from SEALED_API_BASE / SEALED_API_KEY in the environment.
# Usage: SEALED_API_KEY=... SEALED_API_BASE=... scripts/write-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SEALED_API_KEY:?set SEALED_API_KEY}"
umask 077
{
  echo "SEALED_API_BASE=${SEALED_API_BASE:-https://opencode.ai/zen/v1}"
  echo "SEALED_API_KEY=${SEALED_API_KEY}"
} > .env
echo "wrote .env (base=${SEALED_API_BASE:-https://opencode.ai/zen/v1}, key=****${SEALED_API_KEY: -4})"
