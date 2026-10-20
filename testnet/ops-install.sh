#!/usr/bin/env bash
# Installs the systemd units that run ops-runner.sh when the Telegram bot drops a request into ops-queue/. Run once as
# root on the server; safe to re-run. Remove with: systemctl disable --now latheon-ops.path
set -euo pipefail
cd "$(dirname "$0")"
DIR=$(pwd)
mkdir -p ops-queue ops-data
chown 1000:1000 ops-queue ops-data && chmod 770 ops-queue && chmod 755 ops-data
chmod +x ops-runner.sh
cat > /etc/systemd/system/latheon-ops.service <<UNIT
[Unit]
Description=Latheon testnet: run operator requests from the Telegram bot
[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=$DIR/ops-runner.sh
UNIT
cat > /etc/systemd/system/latheon-ops.path <<UNIT
[Unit]
Description=Latheon testnet: watch the bot's request queue
[Path]
PathExistsGlob=$DIR/ops-queue/*.req
MakeDirectory=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now latheon-ops.path
systemctl is-active latheon-ops.path && echo "ops runner installed: requests in $DIR/ops-queue are handled as they arrive"
