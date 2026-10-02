#!/usr/bin/env bash
# reclaim-buffers.sh — close stranded program buffers and reclaim rent.
set -uo pipefail
export PATH="/home/joseph/.local/share/solana/install/active_release/bin:$PATH"
for buf in 5fEzogi7TfsvRLQrcfCzqdY24JhSKhuM56nBemQpVtF6 \
           BACSLwLomfxvUsFYduzmYk2GxZ9k9yYfQeCA5hBpXvZt \
           FLiz8MffyBqXtRy8UvB4mquHPhcrqnaRena7JCVC2UF6; do
  echo "closing $buf"
  timeout 60 solana program close "$buf" -u devnet --keypair ~/.config/solana/id.json 2>&1 | tail -2
done
solana balance -u devnet --keypair ~/.config/solana/id.json
