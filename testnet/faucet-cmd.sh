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
# The ops wallet key lives outside faucet/: the faucet service (reachable from the internet) does not see it.
mkdir -p ops-secret && chown 1000:1000 ops-secret && chmod 700 ops-secret
if [ -f faucet/secret/ops.key ] && [ ! -f ops-secret/ops.key ]; then mv faucet/secret/ops.key ops-secret/ops.key; fi
[ -f ops-secret/ops.key ] && chown 1000:1000 ops-secret/ops.key && chmod 600 ops-secret/ops.key
# Run from a fresh copy of the read-only code with freshly installed packages (never the service's files), so nothing
# the service could have changed runs next to the deployer key.
docker run --rm --network host -u 1000:1000 -e DEPLOYER_KEY -e L3_RPC=http://127.0.0.1:8449 \
  -e FAUCET_KEY_FILE=/src/secret/faucet.key -e OPS_KEY_FILE=/ops-secret/ops.key \
  -v "$PWD/faucet:/src:ro" -v "$PWD/faucet/secret:/src/secret" -v "$PWD/ops-secret:/ops-secret" -w /tmp node:22-bookworm-slim \
  sh -c 'mkdir -p /tmp/app && cp /src/package.json /src/package-lock.json /src/*.js /tmp/app/ && cd /tmp/app && npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm >/dev/null 2>&1 && node admin.js "$@"' admin "$@"
