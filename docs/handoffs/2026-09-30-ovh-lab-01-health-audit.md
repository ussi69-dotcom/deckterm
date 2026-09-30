---
status: open
updated: 2026-09-30
next: Owner-only steps remain (Immich version bump, Cloudflare dashboard, Ubuntu Pro token, big-data review) and PR #37 needs merge + dev validation. See "Applied 2026-09-30".
---

# OVH-PL-LAB-01 health and security audit (2026-09-30)

## In plain words

The server (OVH dedicated box `OVH-PL-LAB-01`, public IP 51.75.54.17) is running and
nobody appears to have broken in: every successful SSH login in the last 60 days came
from the owner's own IP with the owner's keys. But two apps (Immich photos and the
learnai.cz platform) are reachable directly from the internet, bypassing the firewall
and Cloudflare; DeckTerm leaves 7.4 GB of world-readable terminal transcripts in
`/tmp`; the learnai.cz website has returned 502 since at least 2026-09-17; and the disk
is 86 % full with no spare physical space. This was a read-only audit — nothing was
changed. Scope limit: this is the OVH box only; the separate dedicated server from
`docs/handoffs/2026-08-26-dedicated-server-session-kills.md` was not examined.
Cloudflare was checked from the server side only (tunnel logs + Access redirects), not
the dashboard (no API credentials on the box): WAF events and Access login logs are
unseen.

## Terms

- **Cloudflare Tunnel (`cloudflared`)** — an outbound connection from this server to
  Cloudflare; public hostnames are routed through it, so no inbound port is needed.
- **Cloudflare Access** — Cloudflare's login wall in front of a hostname (redirects to
  `waginy.cloudflareaccess.com`).
- **UFW** — Ubuntu's firewall front-end. Docker writes its own iptables rules for
  published ports, which run *before* UFW, so UFW does not protect them.
- **Pipe logs** — DeckTerm's tmux backend copies every terminal's output into
  `/tmp/deckterm-tmux-pipes/<session>.log` (`pipe-pane`, `backend/services/tmux-terminal-backend.ts:47,395`).

## Applied 2026-09-30 (owner said "spusť A a pak zbytek")

- Pipe logs: dir 0700, files 0600, 863 orphans deleted (6.9 GB -> 4 MB); 2 open logs kept.
- `~/.env` -> 600; 162 `~/.deckterm-onboarding-envfile-*` dirs deleted.
- SSH: `codex-temp-transfer-20260815` key removed (backup `~/.ssh/authorized_keys.bak-20260930`);
  `/etc/ssh/sshd_config.d/10-hardening.conf` = `PermitRootLogin no`, `X11Forwarding no`; reloaded, `sshd -T` verified.
- Disk: journal vacuumed to 1 G, old Immich v2 images + test images removed, Trash emptied, npm cache cleared.
  `/` 86 % (66 G free) -> 81 % (87 G free).
- Immich: DB backup `/data/immich/immich-db-backup-v3.1.0-20260930.sql.gz` (600); port now `127.0.0.1:2283`
  (compose backup `docker-compose.yml.backup-20260930`); `/data/immich` 750, old SQL backup 600.
  immich.learnai.cz (Access) and upload-immich (nginx) still work.
- learnai.cz: `ai-nginx` now `127.0.0.1:3333:80` (the port the tunnel already targets) in
  `~/ai-learning-platform/docker-compose.prod.yml` (backup `.backup-20260930`). Site back: `/en` 200. Port 80 closed.
- cloudflared 2026.6.0 -> 2026.9.3 (sha256 verified), restarted, 4 HA connections, all hostnames answer as before.
- pm2-deploy restarted (stale libs); 11/11 apps online. (3848, 4180 were not listening before either.)
- UFW: 22 blanket Cloudflare-range allows removed (188 packets in 109 days); backup `/root/ufw-backup-20260930`.
  Remaining: 22, 443 (upload-immich), 9010 from 172.18/16.
- fail2ban `immich-401` was watching nothing (backend=systemd default ignored logpath) -> `backend = auto`; now monitors the nginx log.
- `certbot renew --dry-run` for upload-immich succeeds (DNS-01; port 80 not needed).
- Code: PR #37 `fix/tmux-pipe-log-hygiene` (worktree `~/deckterm-wt-pipelog`), 1165 unit pass, tsc green; prune is a no-op when tmux does not answer.

### Still for the owner
- Immich upgrade (secret guard blocks agents from touching any .env): first
  `sudo grep IMMICH_VERSION /data/immich/.env` (the line was never seen; running image is v3.1.0), then
  `sudo sed -i 's/^IMMICH_VERSION=v3.1.0$/IMMICH_VERSION=v3.2.4/' /data/immich/.env && sudo chmod 600 /data/immich/.env`,
  then `cd /data/immich && sudo docker compose pull && sudo docker compose up -d`.
- Not verifiable from the box: one real upload to upload-immich from CZ; next Veeam backup job
  succeeds (/data/immich is now 750); next Deploy Main run still connects over SSH (CI key untouched).
- After PR #37 runs on BOTH dev and prod: `rm -rf /tmp/deckterm-tmux-pipes` (dead path then).
- `~/ai-learning-platform/docker-compose.prod.yml` port edit is uncommitted in that repo; a
  `git checkout .` there would reopen port 80 and break learnai.cz again.
- Cloudflare Zero Trust -> Networks -> Tunnels -> this tunnel -> Public hostnames: delete `auth.learnai.cz` (-> localhost:1455).
- Look at Security -> Events and Access -> Logs in the dashboard (not visible from the box).
- `sudo pro attach <token>` (free personal Ubuntu Pro: Livepatch + ESM).
- Decide on `~/projects/guide` (67 G) and `~/.codex/sessions` (15 G).
- `/tmp` holds ~34k entries (9 G before cleanup) — worth a separate look.

## Findings (evidence)

### Critical

1. **Docker ports bypass the firewall.** `immich_server` publishes `0.0.0.0:2283` and
   `ai-nginx` publishes `0.0.0.0:80`; `DOCKER-USER` chain is empty; `DOCKER` filter
   chain ACCEPTs both. DNAT counters since boot: 2283 → 1,999 packets, 80 → 287K.
   `ai-nginx` log, last 7 days: 12,072 requests, **all** from non-Cloudflare public IPs
   (e.g. `3.130.168.2 /en → 200`). Immich on raw `:2283` skips Cloudflare Access, the
   nginx CZ geo-block and the auth rate limit on `upload-immich`.
2. **Terminal transcripts world-readable and never deleted.** 865 files, 7.4 GB, mode
   `-rw-rw-r--`, directory `drwxrwxr-x`. Only 2 are held open (live sessions); the rest
   are orphans (newest mtime 2026-09-06). The code has no unlink path. Other local
   accounts exist (`ubuntu`, `nova`, `dtbroker1`, `dtalice`, `dtbob`,
   `veeam-usr-vspc-agent`); they are locked / keyless, which lowers but does not remove
   the risk. Dev and prod share this directory.
3. **`auth.learnai.cz` → `localhost:1455` with no Access wall.** 1455 is the Codex CLI
   OAuth callback port. Currently nothing listens (502), but any `codex login` would be
   publicly reachable during the login window.
4. **`learnai.cz` down (502).** Tunnel route → `localhost:3333`; nothing listens there.
   5,136 tunnel errors in 7 days; first logged 2026-09-17 (journal start, so possibly
   older). The running stack serves the platform on host port 80 via `ai-nginx`;
   `ai-learning-platform/docker-compose.yml` maps `3333:3000` but is not the running
   stack. Unknown whether the outage is intentional.

### Medium

5. **SSH:** port 22 open to the world (needed — the `deckterm-github-actions` key is
   used by the Deploy Main workflow from GitHub runners). Password auth off, fail2ban
   active (6,232 bans total), ~900–1,200 failed attempts/day = normal background noise.
   Hardening gaps: `PermitRootLogin without-password` (root key is forced-command, so
   low risk), `X11Forwarding yes`, stale key `codex-temp-transfer-20260815` in
   `~deploy/.ssh/authorized_keys`.
6. **UFW allows ALL ports from Cloudflare IP ranges.** With the tunnel, only
   `upload-immich` (443, direct) needs inbound. These rules expose e.g. `:4101`
   (litellm, root, host network) and `:3001` (next-server) to traffic originating from
   Cloudflare's network (e.g. Workers). Verify in CF DNS that no proxied record points
   to the origin IP before removing.
7. **Loose file modes on secrets:** `~/.env` is `664`; 162 leftover
   `~/.deckterm-onboarding-envfile-*/.env` directories (664, dated 2026-07-25…09-06) —
   DeckTerm onboarding test leftovers (contents not read).
8. **Latent exposure:** `ai-learning-platform/docker-compose.yml` would publish
   5432 (Postgres), 8000, 8081, 8082 on `0.0.0.0` if ever started.
9. **Versions:** unattended security upgrades working (1 pending: libgraphite2), kernel
   current, no reboot required. Behind: `cloudflared` 2026.6.0 → 2026.9.3; Immich
   v3.1.0 → v3.2.4. `pm2-deploy.service` runs on stale libraries (needrestart).
   Ubuntu Pro not attached (free personal tier: Livepatch + ESM Apps). LiteLLM 1.89.3
   in the three gateways.
10. **fail2ban `immich-401` jail has 0 bans ever** — either no failed logins or the
    filter does not match; worth one test.

### Capacity

- Disk `/` (RAID1 of two 477 GB NVMe, no unallocated space): 377 G used / 66 G free (86 %).
  Largest: Immich uploads 139 G, `~/projects/guide` 67 G (`.git` 22 G, `.worktrees` 14 G,
  `out` 12 G, videos 9.4 G), `~/models` 20 G, `~/.codex` 19 G (sessions 15 G),
  containerd 19 G, `/tmp` 9.4 G, journal 4 G.
- Net growth rate is **not measured** (no disk history on the box).
- RAM fine (62 G, 47 G available); 1 G swap full but irrelevant at that headroom.
- RAID `[UU]` healthy; NVMe wear not checked (no smartctl/nvme-cli installed).

## Proposed actions

### A. Safe now (no restart of DeckTerm, no data loss) — ~20 GB freed

```bash
# 2: lock down + prune orphan pipe logs (skip files held open)
chmod 700 /tmp/deckterm-tmux-pipes && chmod 600 /tmp/deckterm-tmux-pipes/*.log
open=$(sudo lsof +D /tmp/deckterm-tmux-pipes -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u)
for f in /tmp/deckterm-tmux-pipes/*.log; do grep -qxF "$f" <<<"$open" || rm -f "$f"; done
# 7: secret file modes + onboarding leftovers
chmod 600 ~/.env; rm -rf ~/.deckterm-onboarding-envfile-*
# 5: SSH hardening (keep port 22 open for CI)
#   remove the codex-temp-transfer-20260815 line from ~/.ssh/authorized_keys
#   /etc/ssh/sshd_config.d/99-hardening.conf: PermitRootLogin no / X11Forwarding no
sudo sshd -t && sudo systemctl reload ssh
# capacity
sudo journalctl --vacuum-size=1G
docker image prune -a --filter "until=720h"; docker builder prune -f
rm -rf ~/.local/share/Trash/*; npm cache clean --force
```

### B. Needs a short app outage (owner picks the moment)

- **1 + 4 together:** bind `127.0.0.1:2283:2283` (Immich compose) and
  `127.0.0.1:80:80` (ai-learning-platform prod compose), `docker compose up -d`; in the
  Cloudflare dashboard repoint `learnai.cz` tunnel route `localhost:3333 → localhost:80`.
  Then check `upload-immich` still works (nginx → 127.0.0.1:2283) and learnai.cz returns 200.
- Upgrade `cloudflared` (apt/pkg) and restart it (all tunnel hostnames blip, seconds).
- Immich v3.1.0 → v3.2.4: back up DB first, read release notes, then pull + up.
- `systemctl restart pm2-deploy.service`.

### C. Owner decisions / Cloudflare dashboard

- Delete `auth.learnai.cz` tunnel route (3).
- Narrow UFW Cloudflare-range rules (6) after checking DNS records.
- `sudo pro attach <token>` for Livepatch + ESM (free personal tier).
- Review `~/projects/guide` (67 G) and `~/.codex/sessions` (15 G) — owner's data.
- Look at CF Security Events / Access logs in the dashboard (not visible from the box).

### D. DeckTerm code fix (repo slice, with tests)

Move `pipeDir` under `$DECKTERM_STATE_DIR` (per-instance, mode 0700, files 0600),
delete a session's pipe log when its tmux session ends and sweep orphans in
`reconcileSessionsOnStartup()`; make onboarding tests clean their temp envfile dirs.
