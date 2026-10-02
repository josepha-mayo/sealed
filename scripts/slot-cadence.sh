#!/usr/bin/env bash
# slot-cadence.sh — measure localnet slot production rate (diagnostic).
S=/home/joseph/.local/share/solana/install/active_release/bin/solana
RPC=http://127.0.0.1:8899
a=$($S slot -u "$RPC"); sleep 10; b=$($S slot -u "$RPC")
echo "slot $a -> $b = $((b-a)) slots/10s (expect ~25 at 400ms/slot)"
