# Install DeckTerm On A Dedicated Server

This guide describes a conservative production-style install where DeckTerm is
reachable only through Cloudflare Access, Cloudflare Tunnel, or a local reverse
proxy. Do not expose the Bun server directly to the public internet.

## 1. Install prerequisites

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt-get update
sudo apt-get install -y git tmux curl
```

Optional, depending on how you publish the service:

```bash
sudo apt-get install -y nginx
# or install cloudflared from Cloudflare's package repository
```

## 2. Create the runtime checkout

```bash
git clone https://github.com/ussi69-dotcom/deckterm.git /home/deploy/deckterm
cd /home/deploy/deckterm
bun install --frozen-lockfile
cp .env.example .env
```

Edit `.env`:

```dotenv
PORT=4174
HOST=127.0.0.1
DECKTERM_PUBLISH_MODE=cloudflare
TMUX_BACKEND=1
ALLOWED_FILE_ROOTS=/home/deploy
CF_ACCESS_REQUIRED=1
CF_ACCESS_TEAM_NAME=your-team-name
CF_ACCESS_AUD=your-cloudflare-access-application-aud
TRUSTED_ORIGINS=https://deckterm.example.com
```

Use `HOST=127.0.0.1` when nginx or cloudflared is on the same server. Use
`HOST=0.0.0.0` only on a trusted private network.

Use `DECKTERM_PUBLISH_MODE=cloudflare` for Cloudflare Tunnel publishing or
`DECKTERM_PUBLISH_MODE=nginx` for a local reverse proxy. The Setup doctor uses
that value to check the expected binary, auth, and bind-address requirements.

## 3. Firewall

Recommended public firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 443/tcp
sudo ufw enable
```

Do not open `4174/tcp` publicly when using nginx or Cloudflare Tunnel.

## 4. Run as a user service

Create `~/.config/systemd/user/deckterm.service`:

```ini
[Unit]
Description=DeckTerm
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/deploy/deckterm
EnvironmentFile=/home/deploy/deckterm/.env
ExecStart=/home/deploy/.bun/bin/bun run start
Restart=on-failure
RestartSec=3
# Required for tmux-backed session persistence: the tmux server is a child of
# bun, and the default KillMode=control-group would kill it (and every shell
# in it) on each service restart. KillMode=process stops only bun; the tmux
# server survives and the restarted backend re-adopts its sessions.
KillMode=process

[Install]
WantedBy=default.target
```

Start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now deckterm.service
loginctl enable-linger "$USER"
```

## 5. Publish through Cloudflare Tunnel

Example config: `deploy/cloudflared/config.example.yml`.

Cloudflare Zero Trust setup:

1. Create a self-hosted Access application for `https://deckterm.example.com`.
2. Add your email/domain/group policy.
3. Copy the application audience tag into `CF_ACCESS_AUD`.
4. Route the tunnel hostname to `http://127.0.0.1:4174`.

Only Cloudflare should reach the local service. The browser still talks HTTP and
WebSocket through the same hostname.

## 6. Publish through nginx

Example config: `deploy/nginx/deckterm.conf.example`.

Important proxy settings:

- preserve `Upgrade` and `Connection` headers for WebSockets
- disable proxy buffering
- set long read/send timeouts
- keep DeckTerm bound to `127.0.0.1`

## 7. Verify

```bash
curl http://127.0.0.1:4174/api/health
bash scripts/doctor.sh .env
```

You can run the same deployment checks from the browser through
`More -> Setup -> Run Doctor`. The Setup panel also lets you choose the target
publishing profile and generates remediation rows plus `.env`, systemd,
firewall, cloudflared, or nginx snippets for that profile. You can call the JSON
endpoint directly:

```bash
curl http://127.0.0.1:4174/api/onboarding/doctor
curl 'http://127.0.0.1:4174/api/onboarding/doctor?profile=cloudflare'
```

Expected local health shape:

```json
{ "status": "ok", "terminals": 0, "maxTerminals": 10, "uptime": 1 }
```

From the public hostname, verify:

- unauthenticated access redirects or fails at Cloudflare Access
- authenticated access loads the UI
- terminal input works, which confirms WebSocket proxying
- Files/Git can only operate under `ALLOWED_FILE_ROOTS`
