#!/usr/bin/env bash
# Faucet of test LTH on the server: ./faucet-cmd.sh init | address | fund AMOUNT
#   ops-init / ops-address / fund-ops AMOUNT (deployer → ops wallet) / fund-from-ops AMOUNT (ops wallet → faucet, no key asked;
#   used by the Telegram bot through ops-runner.sh)
#   init         creates the faucet's own key in faucet/secret/faucet.key (once) and shows its address
#   address      shows the faucet address and balance
#   fund AMOUNT  sends AMOUNT LTH from the deployer to the faucet (asks for the deployer key without echo)
# The faucet service itself runs in docker compose (service "faucet") and picks the key up without a restart.
set -euo pipefail
cd "$(dirname "$0")"
case "${1:-}" in init|address|fund|ops-init|ops-address|fund-ops|fund-from-ops) ;; *) echo "usage: $0 init|address|fund AMOUNT|ops-init|ops-address|fund-ops AMOUNT|fund-from-ops AMOUNT"; exit 2 ;; esac
if { [ "$1" = fund ] || [ "$1" = fund-ops ]; } && [ -z "${DEPLOYER_KEY:-}" ]; then
  read -r -s -p "Deployer private key (input hidden): " DEPLOYER_KEY; echo
  export DEPLOYER_KEY
fi
# the faucet (service and this command) runs as uid 1000, user "node" in the image: it owns its folder
mkdir -p faucet/secret && chown -R 1000:1000 faucet && chmod 700 faucet/secret
docker run --rm --network host -u 1000:1000 -e DEPLOYER_KEY -e L3_RPC=http://127.0.0.1:8449 \
  -v "$PWD/faucet:/faucet" -w /faucet node:22-bookworm-slim \
  sh -c 'npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm >/dev/null 2>&1 && node admin.js "$@"' admin "$@"
