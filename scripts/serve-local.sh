#!/usr/bin/env bash
# Serve local open-weights models for the real-model scripts — llama.cpp's
# llama-server exposes /v1/chat/completions, which the harness's OpenAI client
# talks to with SEALED_API_BASE=http://127.0.0.1:<port>/v1 and any key string.
#
# GGUFs live on /mnt/d/devin/models (big disk); the llama.cpp build is
# /mnt/d/devin/llama/llama-b11274/llama-server. Each server gets a fair share
# of cores (-t) so four concurrent legs don't starve each other.
#
# Usage:
#   scripts/serve-local.sh            # start the four ladder legs
#   scripts/serve-local.sh stop       # kill them all
# Override the table with LLAMA_BIN / MODEL_DIR / THREADS env vars.
set -uo pipefail

LLAMA_BIN="${LLAMA_BIN:-/mnt/d/devin/llama/llama-b11274/llama-server}"
# Default to ext4 — /mnt/d 9P reads D-state under concurrent mmap (WSL).
MODEL_DIR="${MODEL_DIR:-$HOME/models}"
THREADS="${THREADS:-3}"
CTX="${CTX:-4096}"

# port|file|alias — the flagship ladder's four legs (two families, four sizes)
MODELS=(
  "8081|qwen2.5-1.5b-instruct-q4_k_m.gguf|qwen2.5-1.5b-instruct"
  "8082|qwen2.5-0.5b-instruct-q4_k_m.gguf|qwen2.5-0.5b-instruct"
  "8083|qwen2.5-3b-instruct-q4_k_m.gguf|qwen2.5-3b-instruct"
  "8084|Llama-3.2-1B-Instruct-Q4_K_M.gguf|llama-3.2-1b-instruct"
)

if [ "${1:-}" = "stop" ]; then
  pkill -f "llama-server -m $MODEL_DIR" && echo "stopped" || echo "none running"
  exit 0
fi

for row in "${MODELS[@]}"; do
  IFS='|' read -r port file alias <<<"$row"
  gguf="$MODEL_DIR/$file"
  [ -f "$gguf" ] || { echo "missing $gguf — download it first"; continue; }
  if curl -s --max-time 3 "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1; then
    echo "port $port already serving ($alias)"
    continue
  fi
  # --timeout bounds a request whose client vanished — without it a killed
  # curl leaves the server churning forever and serializes every later call.
  nohup "$LLAMA_BIN" -m "$gguf" --alias "$alias" --port "$port" \
    -t "$THREADS" -c "$CTX" --timeout 120 >/tmp/llama-$port.log 2>&1 &
  echo "launching $alias on :$port (pid $!)"
done

echo
echo "endpoints come up as models mmap — poll:"
echo "  curl -s http://127.0.0.1:8081/v1/models | head -1"
