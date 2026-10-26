#!/usr/bin/env bash
# Load and anonymity test on the test chain (testnet only): ./loadtest-cmd.sh plan|fund|start|status|stop|logs|analyze
#   plan     [--wallets 200] [--bridge 25] [--hours 24]   writes loadtest/secret/plan.json (wallet keys inside: private)
#   fund     sends LTH (and, for bridge wallets, ETH + test LTH on Arbitrum Sepolia) to the test's master wallet;
#            asks for the deployer key without echo; the key goes only into this throwaway container
#   start    runs the plan in the background (container "latheon-loadtest", resumable: after a stop or a reboot run start again)
#   status | logs | stop
#   analyze  observer heuristics on public chain data vs the private journal -> loadtest/out/loadtest-report.md
# loadtest/secret/ (master key, wallet keys, journal) never leaves the server.
set -euo pipefail
cd "$(dirname "$0")"
cmd="${1:-}"; shift || true
mkdir -p loadtest/secret loadtest/out && chmod 700 loadtest/secret
run() {
  docker run --rm "$@" --network host -u 0 \
    -e L3_RPC=http://127.0.0.1:8449 -e LATHEON_JSON=/t/latheon/out/latheon-deployments.json -e CHAIN_JSON=/t/chain/out/chain.json \
    -e RELAYER_URL -e FAUCET_URL -e DEPLOYER_KEY -e CIRCUIT_CACHE=/t/latheon/secret/circuits \
    -v "$PWD:/t" -w /t/loadtest node:22-bookworm-slim \
    sh -c 'cd /t/latheon && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 && cd /t/loadtest && node loadtest.js "$@"' sh "${ARGS[@]}"
}
case "$cmd" in
  plan|status|analyze) ARGS=("$cmd" "$@"); run ;;
  fund)
    if [ -z "${DEPLOYER_KEY:-}" ]; then read -r -s -p "Deployer private key (input hidden): " DEPLOYER_KEY; echo; export DEPLOYER_KEY; fi
    ARGS=(fund); run -i ;;
  start) docker rm -f latheon-loadtest >/dev/null 2>&1 || true; ARGS=(run)
    docker run -d --name latheon-loadtest --restart on-failure:20 --network host -u 0 \
      -e L3_RPC=http://127.0.0.1:8449 -e LATHEON_JSON=/t/latheon/out/latheon-deployments.json -e CHAIN_JSON=/t/chain/out/chain.json \
      -e RELAYER_URL -e FAUCET_URL -e CIRCUIT_CACHE=/t/latheon/secret/circuits \
      -v "$PWD:/t" -w /t/loadtest node:22-bookworm-slim \
      sh -c 'cd /t/latheon && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 && cd /t/loadtest && node loadtest.js run'
    echo "started; watch with: ./loadtest-cmd.sh logs" ;;
  logs) docker logs --tail 40 -f latheon-loadtest ;;
  stop) docker rm -f latheon-loadtest ;;
  *) echo "usage: $0 plan|fund|start|status|logs|stop|analyze"; exit 2 ;;
esac
