#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for the Latheon testnet. Run as root from this folder.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${SKIP_PACKAGES:-}" ]; then
  echo "== packages: docker, compose, firewall"
  apt-get update -q
  apt-get install -y -q docker.io docker-compose-v2 ufw openssl curl
  systemctl enable --now docker
  echo "== firewall: only SSH, HTTP, HTTPS"
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

echo "== .env"
if [ ! -f .env ]; then cp .env.example .env; fi
grep -q '^BS_DB_PASSWORD=.\+' .env || sed -i "s|^BS_DB_PASSWORD=.*|BS_DB_PASSWORD=$(openssl rand -hex 24)|" .env
grep -q '^BS_SECRET_KEY_BASE=.\+' .env || sed -i "s|^BS_SECRET_KEY_BASE=.*|BS_SECRET_KEY_BASE=$(openssl rand -hex 32)|" .env
chmod 600 .env

echo "== pulling images"
set -a; . ./.env; set +a
docker pull -q "$NITRO_IMAGE" && docker pull -q node:22-bookworm-slim
echo "Done. Next: edit RPC_HOST, EXPLORER_HOST and PARENT_RPC in .env (nano .env), then ./deploy-chain.sh"
