#!/usr/bin/env bash
# Withdrawal relayer on the server: ./relayer-cmd.sh init | address | fund AMOUNT
#   init         creates the relayer's own key in relayer/secret/relayer.key (once) and shows its address
#   address      shows the relayer address and its LTH balance (it pays the gas of relayed withdrawals)
#   fund AMOUNT  sends AMOUNT LTH from the deployer to the relayer (asks for the deployer key without echo)
# The service itself runs in docker compose (service "relayer") at https://EXPLORER_HOST/relay/api/.
set -euo pipefail
cd "$(dirname "$0")"
case "${1:-}" in init|address|fund) ;; *) echo "usage: $0 init|address|fund AMOUNT"; exit 2 ;; esac
if [ "$1" = fund ] && [ -z "${DEPLOYER_KEY:-}" ]; then
  read -r -s -p "Deployer private key (input hidden): " DEPLOYER_KEY; echo
  export DEPLOYER_KEY
fi
mkdir -p relayer/secret && chown -R 1000:1000 relayer && chmod 700 relayer/secret
# Run from a fresh copy of the read-only code with freshly installed packages (never the service's files).
docker run --rm --network host -u 1000:1000 -e DEPLOYER_KEY -e L3_RPC=http://127.0.0.1:8449 -e RELAYER_KEY_FILE=/src/secret/relayer.key \
  -v "$PWD/relayer:/src:ro" -v "$PWD/relayer/secret:/src/secret" -w /tmp node:22-bookworm-slim \
  sh -c 'mkdir -p /tmp/app && cp /src/package.json /src/package-lock.json /src/relayer.js /tmp/app/ && cd /tmp/app && npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm >/dev/null 2>&1 && node relayer.js "$@"' relayer "$@"
