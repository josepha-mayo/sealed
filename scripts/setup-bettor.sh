#!/usr/bin/env bash
# Create + fund a second bettor keypair on localnet.
set -euo pipefail
KP="$HOME/sealed-data/bettor.json"
if [ ! -f "$KP" ]; then
  solana-keygen new --outfile "$KP" --no-bip39-passphrase -s -f >/dev/null
fi
ADDR=$(solana address -k "$KP")
echo "bettor: $ADDR"
solana airdrop 5 "$ADDR" --url "${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}" | tail -1
