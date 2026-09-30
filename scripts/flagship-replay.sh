#!/usr/bin/env bash
# asciinema driver — replays the flagship evidence live against the running
# localnet for docs/flagship.cast → flagship.gif. Not a file replay: every
# command hits the chain.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export SEALED_CLUSTER_OFFSET=0
export ARCIUM_CLUSTER_OFFSET=0
SEALED="yarn --cwd packages/harness --silent tsx src/cli.ts"

type_write() { # fake typing for the recording
  printf '$ %s\n' "$*"
  sleep 0.8
  eval "$*"
}

type_write "$SEALED chain status --benchmark BoKj4kY1TMh9H3pPGk7v7LPys4fkZGw4NrwbjKXfNbij"
sleep 1.2
type_write "$SEALED chain market ladder show --market A4fMA7eKKC6gJ7pDJAaGJcmgYfWiA64mWxu4aUZmHMHw"
sleep 1.2
type_write "$SEALED chain market dark show --market 7TVjSaFDnQknFvcw9LRNiGd2iEGRe5bLnvtJom4JjSyG"
sleep 1.2
type_write "node scripts/verify.mjs"
