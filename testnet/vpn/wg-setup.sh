#!/usr/bin/env bash
# WireGuard VPN for administering the server (not for users). Run as root on the server:
#   ./vpn/wg-setup.sh CLIENT_PUBLIC_KEY [CLIENT_NAME]
# CLIENT_PUBLIC_KEY comes from the WireGuard app on your computer ("Add empty tunnel" creates a key pair; copy the
# public key). Re-running with another key adds another device (10.66.0.3, .4, ...).
# Prints the [Peer] part to paste into the app. Changes nothing about SSH: that is ./vpn/wg-lockdown.sh, after you
# have checked that SSH over the VPN works.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
PUB="${1:-}"; NAME="${2:-device}"
[[ "$PUB" =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]] || { echo "usage: $0 CLIENT_PUBLIC_KEY [NAME]   (a WireGuard public key: 44 characters ending in =)"; exit 2; }
PORT=51820; NET=10.66.0
command -v wg >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q wireguard; }
umask 077; mkdir -p /etc/wireguard
if [ ! -f /etc/wireguard/server.key ]; then wg genkey > /etc/wireguard/server.key; wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub; fi
if [ ! -f /etc/wireguard/wg0.conf ]; then
  printf '[Interface]\nAddress = %s.1/24\nListenPort = %s\nPrivateKey = %s\n' "$NET" "$PORT" "$(cat /etc/wireguard/server.key)" > /etc/wireguard/wg0.conf
fi
if grep -q "$PUB" /etc/wireguard/wg0.conf; then
  IP=$(awk -v k="$PUB" '$0 ~ "PublicKey = "k {f=1} f && /AllowedIPs/ {split($3,a,"/"); print a[1]; exit}' /etc/wireguard/wg0.conf)
  echo "This key is already a peer ($IP)."
else
  N=$(grep -c '^\[Peer\]' /etc/wireguard/wg0.conf || true); IP="$NET.$((N + 2))"
  printf '\n[Peer]\n# %s\nPublicKey = %s\nAllowedIPs = %s/32\n' "$NAME" "$PUB" "$IP" >> /etc/wireguard/wg0.conf
fi
systemctl enable -q wg-quick@wg0 2>/dev/null || true
if systemctl is-active -q wg-quick@wg0; then wg syncconf wg0 <(wg-quick strip wg0); else systemctl start wg-quick@wg0; fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$PORT/udp" >/dev/null; fi
PUBIP=$(curl -4 -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
cat <<OUT

WireGuard is running. In the app on your computer, edit the tunnel so it reads:

[Interface]
PrivateKey = (keep the one the app generated)
Address = $IP/32

[Peer]
PublicKey = $(cat /etc/wireguard/server.pub)
Endpoint = $PUBIP:$PORT
AllowedIPs = $NET.1/32
PersistentKeepalive = 25

Then activate it and test from PowerShell:  ssh -i C:\Users\smirn\.ssh\latheon_server root@$NET.1
Only when that works, run ./vpn/wg-lockdown.sh to close SSH to everything but the VPN.
OUT
