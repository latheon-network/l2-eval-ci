#!/usr/bin/env bash
# Read-only check of the pre-V7 pools on every network in deployments.json (testnets only): balance, nextIndex(),
# number of Withdrawal events, routers' balances; flags more withdrawals than deposits or a balance below
# deposits minus withdrawals. No keys, no transactions; runs in a throwaway Node container.
#   ./legacy-pools-check.sh [--all] [--network latheon-testnet,arbitrum-sepolia]
# deployments.json: downloaded from the Latheon repository (main, demo/deployments.json) unless DEPLOYMENTS_FILE
# points to a local copy (a path inside this folder, e.g. DEPLOYMENTS_FILE=latheon/out/latheon-deployments.json;
# that file lists only this chain). The Latheon chain is read through the node's local RPC (127.0.0.1:8449),
# the other networks through the public RPCs in deployments.json.
# Result: the table on stdout and legacy-pools/out/legacy-pools.json. Exit 1 when an anomaly is flagged.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p legacy-pools/out
DF_ARGS=()
if [ -n "${DEPLOYMENTS_FILE:-}" ]; then DF_ARGS=(-e "DEPLOYMENTS_FILE=/t/${DEPLOYMENTS_FILE#./}"); fi
docker run --rm --network host -u "$(id -u):$(id -g)" \
  -e RPC_LATHEON_TESTNET="${RPC_LATHEON_TESTNET:-http://127.0.0.1:8449}" -e DEPLOYMENTS_URL -e LOGS_MAX_REQUESTS \
  -e RPC_ETHEREUM_SEPOLIA -e RPC_ARBITRUM_SEPOLIA -e RPC_ROBINHOOD_TESTNET "${DF_ARGS[@]}" \
  -v "$PWD:/t:ro" -v "$PWD/legacy-pools/out:/out" -w /t node:22-bookworm-slim \
  node legacy-pools-check.js --json /out/legacy-pools.json "$@"
