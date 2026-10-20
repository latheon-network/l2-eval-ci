#!/usr/bin/env bash
# Checks the public test chain from outside: RPC, explorer API and page, faucet page and balance, ETH of the batch
# poster and validator on Arbitrum Sepolia. Prints one line per check. Writes problems (Russian, for the alert) to
# $PROBLEMS_FILE and a short summary to $SUMMARY_FILE; exits 1 if there is any problem.
set -uo pipefail
cd "$(dirname "$0")"
. ./targets.env
PROBLEMS_FILE="${PROBLEMS_FILE:-/tmp/monitor-problems.txt}"; : > "$PROBLEMS_FILE"
SUMMARY_FILE="${SUMMARY_FILE:-/tmp/monitor-summary.txt}"; : > "$SUMMARY_FILE"
bad() { echo "PROBLEM: $*"; echo "• $*" >> "$PROBLEMS_FILE"; }
ok() { echo "ok: $*"; }
sum() { echo "$*" >> "$SUMMARY_FILE"; }
rpc() { curl -s -m 20 -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1"; }
wei2num() { python3 -c "import sys; print(int(sys.argv[1],16)/1e18)" "$1"; }
pretty() { python3 -c "import sys; x=float(sys.argv[1]); d=int(sys.argv[2]); print(f'{x:,.{d}f}'.replace(',', ' ').replace('.', ','))" "$1" "$2"; }
lt() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) < float(sys.argv[2]) else 1)" "$1" "$2"; }

cid=$(rpc "$RPC_URL" eth_chainId '[]' | jq -r '.result // empty' 2>/dev/null)
[ "$cid" = "$CHAIN_ID_HEX" ] && ok "RPC chainId $cid" || bad "публичный RPC не отвечает (ответ: ${cid:-нет})"
bn=$(rpc "$RPC_URL" eth_blockNumber '[]' | jq -r '.result // empty' 2>/dev/null)
if [ -n "$bn" ]; then ok "block $((bn))"; sum "RPC: работает, последний блок $((bn))"; else bad "RPC не отдаёт последний блок"; fi

code=$(curl -s -m 20 -o /tmp/stats.json -w '%{http_code}' "$EXPLORER_URL/api/v2/stats")
if [ "$code" = 200 ] && jq -e . /tmp/stats.json >/dev/null 2>&1; then ok "explorer API"; else bad "API обозревателя: HTTP $code"; fi
code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$EXPLORER_URL/")
if [ "$code" = 200 ]; then ok "explorer page"; sum "Обозреватель: работает"; else bad "страница обозревателя: HTTP $code"; fi
code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$EXPLORER_URL/faucet")
[ "$code" = 200 ] && ok "faucet page" || bad "страница крана: HTTP $code"

eth_line=""
for who in BATCH_POSTER VALIDATOR; do
  addr=${!who}; min_var="MIN_${who}_ETH"; min=${!min_var}
  name=$([ "$who" = BATCH_POSTER ] && echo "Batch poster" || echo "Валидатор")
  w=$(rpc "$PARENT_RPC" eth_getBalance "[\"$addr\",\"latest\"]" | jq -r '.result // empty' 2>/dev/null)
  if [ -z "$w" ]; then echo "skip: $who balance not readable"; continue; fi
  e=$(wei2num "$w")
  if lt "$e" "$min"; then bad "$name: $(pretty "$e" 4) ETH в Arbitrum Sepolia, меньше $(pretty "$min" 3) — пополнить ($addr)"; else ok "$who $e ETH"; fi
  eth_line="${eth_line:+$eth_line · }$name: $(pretty "$e" 4) ETH"
done
[ -n "$eth_line" ] && sum "$eth_line"
w=$(rpc "$RPC_URL" eth_getBalance "[\"$FAUCET\",\"latest\"]" | jq -r '.result // empty' 2>/dev/null)
if [ -n "$w" ]; then
  e=$(wei2num "$w")
  if lt "$e" "$MIN_FAUCET_LTH"; then bad "в кране $(pretty "$e" 0) LTH, меньше $MIN_FAUCET_LTH — ./faucet-cmd.sh fund"; else ok "faucet $e LTH"; fi
  sum "Кран: $(pretty "$e" 0) LTH"
fi

[ -s "$PROBLEMS_FILE" ] && exit 1 || exit 0
