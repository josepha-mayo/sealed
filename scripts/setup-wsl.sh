#!/usr/bin/env bash
# One-shot toolchain install for Ubuntu 24.04 (WSL2 or bare). Idempotent-ish: safe to re-run.
# Installs: build deps, Docker CE, Node 22 + yarn, Rust, Solana CLI 3.1.10, Anchor 1.0.2 (avm), Arcium (arcup).
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

SOLANA_VERSION="${SOLANA_VERSION:-v3.1.10}"
ANCHOR_VERSION="${ANCHOR_VERSION:-1.0.2}"

sudo apt-get update
sudo apt-get install -y build-essential pkg-config libudev-dev libssl-dev curl git ca-certificates gnupg lsb-release unzip jq protobuf-compiler

# --- Docker CE (Arcium localnet runs the MPC nodes in containers)
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker

# --- Node 22 + yarn
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v yarn >/dev/null || sudo npm install -g yarn

# --- Rust
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"

# --- Solana CLI
if ! command -v solana >/dev/null; then
  sh -c "$(curl -sSfL https://release.anza.xyz/${SOLANA_VERSION}/install)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
grep -q 'solana/install/active_release/bin' "$HOME/.profile" || \
  echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.profile"
solana --version
[ -f "$HOME/.config/solana/id.json" ] || solana-keygen new --no-bip39-passphrase -s -o "$HOME/.config/solana/id.json"
solana config set --url localhost

# --- Anchor via avm
if ! command -v avm >/dev/null; then
  cargo install --git https://github.com/solana-foundation/anchor avm --force
fi
avm install "$ANCHOR_VERSION"
avm use "$ANCHOR_VERSION"
anchor --version

# --- Arcium (arcup + arcium CLI + arx node image)
if ! command -v arcup >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ | bash
fi
arcium --version

echo "DONE: toolchain ready. Open a new shell (docker group) before running 'arcium test'."
