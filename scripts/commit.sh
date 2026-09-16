#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
git add packages/harness/src/chain.ts scripts/
git -c user.name="Joseph Mayo" -c user.email="joseph@localhost" commit \
  -m "devnet: programs+MXE+comp defs+circuits live on devnet; chain client made resilient (poll account state not computation finalization, idempotent staging, reset-sealing CLI, circuit-upload resume on interrupted init)" \
  -m "Generated with [Devin](https://devin.ai)" \
  -m "Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
git log --oneline -3
