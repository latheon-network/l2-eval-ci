#!/usr/bin/env bash
# Run a chain.mjs command in a Node container: ./chain-cmd.sh deploy|fund|bridge|batches|withdraw|validator
# Needs DEPLOYER_KEY in the environment (deploy-chain.sh asks for it without echo).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
: "${DEPLOYER_KEY:?DEPLOYER_KEY is not set}"
mkdir -p chain/secret chain/out && chmod 700 chain/secret
docker run --rm --network host -u 0 \
  -e DEPLOYER_KEY -e PARENT_RPC -e BATCH_MAX_DELAY -e CHAIN_NAME=latheon-testnet -e BATCH_POSTER_FUNDING=0.02 \
  -e VALIDATOR_FUNDING -e CONFIRM_PERIOD_BLOCKS -e MIN_ASSERTION_PERIOD_BLOCKS -e BOLD_FAST -e WITHDRAW_AMOUNT -e WITHDRAW_TIMEOUT_MIN -e FUND_TIMEOUT_MIN \
  -v "$PWD/chain:/chain" -w /chain node:22-bookworm-slim \
  sh -c 'npm ci --no-audit --no-fund >/dev/null 2>&1 && node chain.mjs "$0"' "$1"
