#!/usr/bin/env bash
# Run a chain.mjs command in a Node container: ./chain-cmd.sh deploy|fund|bridge|batches|withdraw|validator
# Asks for the deployer key without echo unless DEPLOYER_KEY is set. L3_DEPOSIT=AMOUNT ./chain-cmd.sh fund moves AMOUNT
# test LTH into the chain (default 10000; skipped when the deployer already holds at least that much on the chain).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
if [ -z "${DEPLOYER_KEY:-}" ]; then
  read -r -s -p "Deployer private key (input hidden): " DEPLOYER_KEY; echo
  export DEPLOYER_KEY
fi
[ -n "$DEPLOYER_KEY" ] || { echo "DEPLOYER_KEY is empty"; exit 1; }
mkdir -p chain/secret chain/out && chmod 700 chain/secret
docker run --rm --network host -u 0 \
  -e DEPLOYER_KEY -e PARENT_RPC -e BATCH_MAX_DELAY -e CHAIN_NAME=latheon-testnet -e BATCH_POSTER_FUNDING=0.02 \
  -e VALIDATOR_FUNDING -e CONFIRM_PERIOD_BLOCKS -e MIN_ASSERTION_PERIOD_BLOCKS -e BOLD_FAST -e WITHDRAW_AMOUNT -e WITHDRAW_TIMEOUT_MIN -e FUND_TIMEOUT_MIN -e L3_DEPOSIT \
  -v "$PWD/chain:/chain" -w /chain node:22-bookworm-slim \
  sh -c 'npm ci --no-audit --no-fund >/dev/null 2>&1 && node chain.mjs "$0"' "$1"
