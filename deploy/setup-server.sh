#!/usr/bin/env bash
# Run this ON the EC2 instance (Ubuntu 22.04/24.04) after SSH-ing in, once
# the moot/ repo has been rsynced to /home/ubuntu/moot (see the deploy guide
# for the rsync command run from your own machine).
set -euo pipefail

echo "== Installing Node.js 22.x =="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "== Installing Caddy =="
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy

echo "== Installing repo dependencies (npm workspaces, run at repo root) =="
cd /home/ubuntu/moot
npm install

echo "== Installing Caddyfile =="
sudo cp /home/ubuntu/moot/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

echo "== Installing systemd units =="
sudo cp /home/ubuntu/moot/deploy/moot-mcp-server.service /etc/systemd/system/
sudo cp /home/ubuntu/moot/deploy/moot-slack-app.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now moot-mcp-server
sudo systemctl enable --now moot-slack-app

echo "== Done. Check status with: =="
echo "  sudo systemctl status moot-mcp-server moot-slack-app"
echo "  sudo journalctl -u moot-mcp-server -f"
echo "  sudo journalctl -u moot-slack-app -f"
