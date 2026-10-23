#!/usr/bin/env bash
# Send ETH on Arbitrum Sepolia from the deployer to the batch poster or the validator:
#   ./topup-cmd.sh batch-poster 0.1      or      ./topup-cmd.sh validator 0.05
# Asks for the deployer key without echo; it is passed to a throwaway container and not stored.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
case "${1:-}" in batch-poster|validator) ;; *) echo "usage: ./topup-cmd.sh batch-poster|validator AMOUNT_ETH"; exit 2;; esac
[ -n "${2:-}" ] || { echo "usage: ./topup-cmd.sh batch-poster|validator AMOUNT_ETH"; exit 2; }
if [ -z "${DEPLOYER_KEY:-}" ]; then
  read -r -s -p "Deployer private key (input hidden): " DEPLOYER_KEY; echo
  export DEPLOYER_KEY
fi
docker run --rm --network host -u 0 -e DEPLOYER_KEY -e PARENT_RPC \
  -v "$PWD/chain:/chain" -w /chain node:22-bookworm-slim \
  sh -c 'npm ci --no-audit --no-fund >/dev/null 2>&1 && node topup.mjs "$0" "$1"' "$1" "$2"
