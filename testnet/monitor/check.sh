#!/usr/bin/env bash
# Checks the public test chain from outside: RPC, explorer API, faucet page, ETH of the batch poster and validator on
# Arbitrum Sepolia, the faucet's LTH. Prints one line per check; exits 1 and writes problems to $PROBLEMS_FILE if any.
set -uo pipefail
cd "$(dirname "$0")"
. ./targets.env
PROBLEMS_FILE="${PROBLEMS_FILE:-/tmp/monitor-problems.txt}"; : > "$PROBLEMS_FILE"
bad() { echo "PROBLEM: $*"; echo "- $*" >> "$PROBLEMS_FILE"; }
ok() { echo "ok: $*"; }
rpc() { curl -s -m 20 -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1"; }
wei2eth() { python3 -c "import sys; print(int(sys.argv[1],16)/1e18)" "$1"; }
lt() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) < float(sys.argv[2]) else 1)" "$1" "$2"; }

cid=$(rpc "$RPC_URL" eth_chainId '[]' | jq -r '.result // empty' 2>/dev/null)
[ "$cid" = "$CHAIN_ID_HEX" ] && ok "RPC answers, chainId $cid" || bad "public RPC $RPC_URL does not answer eth_chainId correctly (got '${cid:-nothing}')"
bn=$(rpc "$RPC_URL" eth_blockNumber '[]' | jq -r '.result // empty' 2>/dev/null)
[ -n "$bn" ] && ok "latest block $((bn))" || bad "public RPC does not return the latest block"

code=$(curl -s -m 20 -o /tmp/stats.json -w '%{http_code}' "$EXPLORER_URL/api/v2/stats")
[ "$code" = 200 ] && jq -e . /tmp/stats.json >/dev/null 2>&1 && ok "explorer API" || bad "explorer API $EXPLORER_URL/api/v2/stats answered HTTP $code"
code=$(curl -s -m 20 -o /tmp/page.html -w '%{http_code}' "$EXPLORER_URL/")
[ "$code" = 200 ] && ok "explorer page" || bad "explorer page answered HTTP $code"
code=$(curl -s -m 20 -o /tmp/faucet.html -w '%{http_code}' "$EXPLORER_URL/faucet")
[ "$code" = 200 ] && ok "faucet page" || bad "faucet page answered HTTP $code"

for who in BATCH_POSTER VALIDATOR; do
  addr=${!who}; min_var="MIN_${who}_ETH"; min=${!min_var}
  w=$(rpc "$PARENT_RPC" eth_getBalance "[\"$addr\",\"latest\"]" | jq -r '.result // empty' 2>/dev/null)
  if [ -z "$w" ]; then echo "skip: could not read $who balance on Arbitrum Sepolia"; continue; fi
  e=$(wei2eth "$w")
  if lt "$e" "$min"; then bad "$who $addr has $e ETH on Arbitrum Sepolia (below $min): top it up"; else ok "$who $e ETH"; fi
done
w=$(rpc "$RPC_URL" eth_getBalance "[\"$FAUCET\",\"latest\"]" | jq -r '.result // empty' 2>/dev/null)
if [ -n "$w" ]; then e=$(wei2eth "$w"); if lt "$e" "$MIN_FAUCET_LTH"; then bad "faucet has $e LTH (below $MIN_FAUCET_LTH): ./faucet-cmd.sh fund"; else ok "faucet $e LTH"; fi; fi

[ -s "$PROBLEMS_FILE" ] && exit 1 || exit 0
