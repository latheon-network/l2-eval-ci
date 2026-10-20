#!/usr/bin/env bash
# Read-only overview of the test chain: containers, errors in the node log, disk, and (chain/status.mjs) blocks,
# batches, validator, who receives fees, ETH of the batch poster, validator and deployer on Arbitrum Sepolia, and
# where the test LTH is. Needs no key and prints none. Usage: ./status.sh [hours of log to scan, default 1]
set -uo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
H="${1:-1}"

echo "[containers]"
docker compose ps --format '  {{.Service}}: {{.Status}}'
echo
echo "[node log, last ${H}h]"
LOG=$(docker compose logs --since "${H}h" nitro 2>&1)
# "eth_config has returned nil BlobSchedule": the parent chain (Arbitrum Sepolia) has no blobs; harmless, counted apart
printf '  ERROR lines: %s\n' "$(grep 'ERROR' <<<"$LOG" | grep -vc 'nil BlobSchedule')"
printf '  harmless "nil BlobSchedule" notices: %s\n' "$(grep -c 'nil BlobSchedule' <<<"$LOG")"
printf '  429 (parent RPC rate limit): %s\n' "$(grep -c '429' <<<"$LOG")"
printf '  error reading inbox: %s\n' "$(grep -c 'error reading inbox' <<<"$LOG")"
printf '  error posting batch: %s\n' "$(grep -c 'error posting batch' <<<"$LOG")"
echo
echo "[server]"
df -h / | awk 'NR==2 {print "  disk: " $3 " used of " $2 " (" $5 ")"}'
free -h | awk '/Mem:/ {print "  memory: " $3 " used of " $2}'
echo
docker run --rm --network host -u 0 -e PARENT_RPC \
  -v "$PWD/chain:/chain" -v "$PWD/faucet/secret:/faucet-secret:ro" -v "$PWD/latheon/out:/latheon-out:ro" \
  -w /chain node:22-bookworm-slim \
  sh -c '[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null 2>&1; node status.mjs'
