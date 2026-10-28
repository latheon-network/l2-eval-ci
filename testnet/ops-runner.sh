#!/usr/bin/env bash
# Runs operator requests from the Telegram bot. The bot (uid 1000, no docker access) drops ID.req files into ops-queue/;
# systemd (ops-install.sh) starts this script as root when one appears. Only the actions below are possible; anything
# else is refused. The answer goes to ID.out for the bot to read.
#   restart SERVICE | logs SERVICE   SERVICE ∈ nitro blockscout frontend faucet relayer caddy db bot
#   faucet-pause | faucet-resume | faucet-fund AMOUNT (1..OPS_FUND_MAX LTH from the ops wallet) | ops-address
set -uo pipefail
cd "$(dirname "$0")"
Q=ops-queue
SERVICES=" nitro blockscout frontend faucet relayer caddy db bot "
shopt -s nullglob
for req in "$Q"/*.req; do
  id=$(basename "$req" .req)
  [[ "$id" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || { rm -f "$req"; continue; }
  read -r action arg _ < <(head -c 200 "$req" | tr -cd 'a-z0-9 \n-' | head -1)
  rm -f "$req"
  out="$Q/$id.out.tmp"
  {
    case "$action" in
      restart)
        if [[ "$SERVICES" == *" $arg "* ]]; then docker compose restart "$arg" > /tmp/ops-restart.txt 2>&1 && echo "restarted $arg" || { echo "restart failed"; tail -3 /tmp/ops-restart.txt; }; sleep 3; docker compose ps "$arg" --format '{{.Service}}: {{.Status}}'
        else echo "refused: unknown service"; fi ;;
      logs)
        if [[ "$SERVICES" == *" $arg "* ]]; then docker compose logs --no-color --tail 40 "$arg" 2>&1 | grep -v 'Getting file info' | sed -E -e 's#(https?://[^ "]*/v[0-9]+/)[A-Za-z0-9_-]{8,}#\1***#g' -e 's#([?&](api[_-]?key|key|token|apikey|access[_-]?token)=)[^&" ]+#\1***#gI' | tail -25 | cut -c1-220
        else echo "refused: unknown service"; fi ;;
      faucet-pause) touch faucet/secret/paused && chown 1000:1000 faucet/secret/paused && echo "faucet paused" ;;
      faucet-resume) rm -f faucet/secret/paused && echo "faucet resumed" ;;
      faucet-fund)
        if [[ "$arg" =~ ^[0-9]{1,7}$ ]]; then ./faucet-cmd.sh fund-from-ops "$arg" 2>&1 | tail -3; else echo "refused: amount"; fi ;;
      ops-address) ./faucet-cmd.sh ops-address 2>&1 | tail -2 ;;
      *) echo "refused: unknown action" ;;
    esac
  } > "$out" 2>&1
  chown 1000:1000 "$out" 2>/dev/null; mv "$out" "$Q/$id.out"
  echo "$(date -u +%FT%TZ) $action $arg" >> "$Q/actions.log"
done
# keep the queue small: answers older than a day
find "$Q" -name '*.out' -mmin +1440 -delete 2>/dev/null || true
