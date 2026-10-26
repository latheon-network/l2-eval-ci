#!/usr/bin/env bash
# Latheon contracts on the test chain, run in a Node container on the server: ./latheon-cmd.sh deploy|smoke|deploy-v6|smoke-v6
#   deploy  Poseidon, verifiers, four native-coin V5 pools, native router; every link checked, real proofs against both verifiers
#   smoke   router deposit of 11 LTH, withdrawMany of 2 notes with real proofs to an empty address, invariants, disclosure
#   deploy-v6  V6 next to V5: verifier V4, four 20-level native pools, V6 router; listed first in the public entry
#   smoke-v6   the same smoke on V6 with a relayer fee bound into the proofs, plus a 23-note deposit for gas
# Asks for the deployer key without echo unless DEPLOYER_KEY is set. Uses the node's local RPC (127.0.0.1:8449).
# Public result: latheon/out/latheon-deployments.json (goes into demo/deployments.json); latheon/secret/ stays private.
set -euo pipefail
cd "$(dirname "$0")"
case "${1:-}" in deploy|smoke|deploy-v6|smoke-v6) ;; *) echo "usage: $0 deploy|smoke|deploy-v6|smoke-v6"; exit 2 ;; esac
set -a; . ./.env; set +a
if [ -z "${DEPLOYER_KEY:-}" ]; then
  read -r -s -p "Deployer private key (input hidden): " DEPLOYER_KEY; echo
  export DEPLOYER_KEY
fi
mkdir -p latheon/secret latheon/out && chmod 700 latheon/secret
docker run --rm --network host -u 0 \
  -e DEPLOYER_KEY -e L3_RPC=http://127.0.0.1:8449 \
  -e PUBLIC_RPC="https://${RPC_HOST}" -e EXPLORER_URL="https://${EXPLORER_HOST}" \
  -e STATE_DIR=/latheon/secret -e OUT_DIR=/latheon/out -e CIRCUIT_CACHE=/latheon/secret/circuits \
  -v "$PWD/latheon:/latheon" -w /latheon node:22-bookworm-slim \
  sh -c 'npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 && node "$0.js"' "$1"
