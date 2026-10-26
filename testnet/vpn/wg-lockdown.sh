#!/usr/bin/env bash
# Closes SSH (port 22) to everything except the WireGuard network, with ufw. Keeps HTTP/HTTPS (the public RPC, explorer,
# faucet, relayer) and WireGuard open. Run it ONLY from an SSH session that already goes through the VPN
# (ssh root@10.66.0.1), so you can see it still works. If you lock yourself out: Hetzner Cloud Console → the server →
# "Console" (web terminal), then run: ufw delete deny 22/tcp ; ufw allow 22/tcp
#   ./vpn/wg-lockdown.sh          apply
#   ./vpn/wg-lockdown.sh undo     open SSH to everyone again
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
NET=10.66.0.0/24
command -v ufw >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q ufw; }
if [ "${1:-}" = undo ]; then ufw delete deny 22/tcp >/dev/null 2>&1 || true; ufw allow 22/tcp; ufw status; exit 0; fi
FROM=$(echo "${SSH_CLIENT:-}" | awk '{print $1}')
case "$FROM" in 10.66.0.*) ;; *) echo "You are connected from '${FROM:-unknown}', not through the VPN (10.66.0.x). Connect with ssh root@10.66.0.1 first."; exit 1;; esac
ufw allow 51820/udp >/dev/null
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
ufw allow from "$NET" to any port 22 proto tcp >/dev/null
ufw delete allow 22/tcp >/dev/null 2>&1 || true
ufw deny 22/tcp >/dev/null
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
ufw status verbose
echo; echo "SSH now answers only through the VPN. Public ports: 80, 443 (Caddy), 51820/udp (WireGuard)."
