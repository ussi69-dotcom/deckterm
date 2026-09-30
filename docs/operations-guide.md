# DeckTerm Operations Guide

## Purpose

This document describes the current operational model of DeckTerm as it exists today.

It covers:

- repository branches
- local server checkouts
- systemd services
- GitHub Actions
- release layout
- deployment and rollback

## Branch and Environment Model

Git model:

- `feature/*` for isolated work
- `dev` for integration
- `main` for production

Runtime model:

- `4174` is development
- `4173` is production

## Server Layout

### Development runtime

- checkout: [`/home/deploy/deckterm_dev`](/home/deploy/deckterm_dev)
- branch: `dev`
- service: `deckterm-dev.service`

### Production runtime

Production is deployed into release directories and served through a stable symlink:

```text
/home/deploy/apps/deckterm/
├── incoming/
├── prod/
│   ├── current -> /home/deploy/apps/deckterm/prod/releases/<sha>
│   ├── previous -> /home/deploy/apps/deckterm/prod/releases/<sha>
│   ├── releases/
│   └── shared/
└── shared/
    └── prod.env
```

The production service reads:

- code from `prod/current`
- environment from `/home/deploy/apps/deckterm/shared/prod.env`

The legacy checkout [`/home/deploy/deckterm`](/home/deploy/deckterm) is not the production runtime source anymore.

## Systemd Services

### Production

Service file: [`/home/deploy/.config/systemd/user/deckterm.service`](/home/deploy/.config/systemd/user/deckterm.service)

Key properties:

- user-level systemd
- working directory is the `current` release symlink
- explicit Bun path in `ExecStart`
- `TMUX_BACKEND=1`

### Development

Service file: `deckterm-dev.service`

Key properties:

- runs from [`/home/deploy/deckterm_dev`](/home/deploy/deckterm_dev)
- used for all active browser testing on `4174`

## Completion push notifications

**Plain-language guide:** the open web page can play a tone, but background Web Push is delivered by the operating system even when the page sleeps or closes. The server signs those messages with one long-lived VAPID key pair. Every phone or computer still needs to be enabled separately in **Settings → Notifications**.

Generate the key pair once:

```bash
bun run push:vapid
```

Store the resulting values in the runtime environment (production uses `/home/deploy/apps/deckterm/shared/prod.env`; development uses its service environment):

```text
DECKTERM_VAPID_PUBLIC_KEY=<publicKey>
DECKTERM_VAPID_PRIVATE_KEY=<privateKey>
DECKTERM_VAPID_SUBJECT=mailto:<operational-contact>
```

The private key is a secret: do not commit it, paste it into issues, or rotate it casually. Replacing the key pair invalidates existing browser subscriptions, so every device must enable push again. The public key endpoint intentionally returns only the public half.

After changing the runtime environment, restart the relevant service and verify `GET /api/notifications/push` reports `configured: true` while authenticated. On iPhone/iPad, add DeckTerm to the Home Screen, open that installed app, then enable push from its Settings; a normal Safari tab cannot receive background Web Push.

## GitHub Actions

### CI

Workflow: [`.github/workflows/ci.yml`](/home/deploy/deckterm_dev/.github/workflows/ci.yml)

Runs on:

- pushes to `main`, `dev`, `feature/**`, `fix/**`, `chore/**`
- PRs to `main` and `dev`

Jobs:

- `unit`
- `smoke-e2e`

### Deploy Main

Workflow: [`.github/workflows/deploy-main.yml`](/home/deploy/deckterm_dev/.github/workflows/deploy-main.yml)

Behavior:

1. verify-and-package
   - install dependencies
   - run unit tests
   - start DeckTerm on `4174`
   - run smoke E2E
   - build release tarball
2. deploy
   - gated by `ENABLE_PROD_DEPLOY=1`
   - downloads artifact
   - copies it over SSH
   - expands to incoming release directory
   - runs deploy script on the server

### Promote Dev To Main

Workflow: [`.github/workflows/promote-dev-to-main.yml`](/home/deploy/deckterm_dev/.github/workflows/promote-dev-to-main.yml)

Behavior:

- creates or updates a promotion PR from `dev` to `main`
- can optionally enable auto-merge

## GitHub Configuration

### Secrets

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`

### Variables

- `ENABLE_PROD_DEPLOY=1`
- `DEPLOY_PORT`
- `DEPLOY_ROOT`
- `PROD_PORT`
- `PROD_CANDIDATE_PORT`
- `PROD_SERVICE`

### Branch protections

Recommended and currently used model:

- `dev`
  - PR required
  - `unit` and `smoke-e2e` required
- `main`
  - PR required
  - `unit` and `smoke-e2e` required
  - one approval required

## Deployment Script Behavior

Primary script: [scripts/deploy_release.sh](/home/deploy/deckterm_dev/scripts/deploy_release.sh)

Current deployment flow:

1. run the driver and safety tools from the active reviewed release, with the unpacked
   candidate supplied through `SOURCE_DIR`
2. copy unpacked source into a versioned release directory
3. symlink shared env file and write a `RELEASE_ID` marker into the release
4. install dependencies inside the release
5. refuse to deploy if `PROD_CANDIDATE_PORT` is already in use (stale candidate)
6. create a serialized, integrity-checked production-state backup
7. restore that backup into private candidate state, tmux, clipboard, and capture paths
8. run a direct Bun process in validation-only preflight mode
9. require exact candidate identity plus `preflight: true`, then stop it
10. verify the backup again and prove the previous schema contract remains compatible
11. remove the private candidate tree before changing `current`
12. repoint `current` and restart the production systemd service
13. require exact live release identity on `PROD_PORT`
14. restore and re-verify `previous` on any post-promotion failure

Important hardening already in place:

- startup failures exit non-zero instead of leaving a fake alive process
- SSH deploy key is written with trailing newline
- deploy script uses an explicit Bun path for non-interactive SSH shells
- the candidate is the directly tracked Bun child, terminated and waited on by every exit
  path; its private `0700` tree and log are removed before promotion
- the candidate port is checked free before startup; health must report the exact release
  ID and validation-only marker, so another listener cannot satisfy the gate
- old release code is never started as a schema probe; additive compatibility comes from
  JSON contracts captured from the verified backup and private migrated database
- the incoming release never supplies the backup, restore, health, or schema judgment code;
  the active reviewed driver uses its own sibling tools
- deploy and rollback share one host lifetime lock and refuse overlapping operations before
  changing a release symlink or restarting the service
- promotion is verified end to end via the `release` field of `/api/health`;
  a silent rollback can no longer be reported as a successful deploy
- the remote deploy script runs under an explicit non-interactive `bash` so a
  failing/rolled-back deploy propagates its exit code and fails the job

## Rollback

Rollback script: [active release rollback script](/home/deploy/apps/deckterm/prod/current/scripts/rollback_release.sh)

The script checks the target and current schema contracts before it changes a symlink. A
missing or incompatible contract fails without opening live state. It then verifies the
exact rollback release identity; a failed rollback restores and verifies the original
release.

Example:

```bash
DEPLOY_ROOT=/home/deploy/apps/deckterm/prod \
SYSTEMD_SERVICE=deckterm.service \
bash /home/deploy/apps/deckterm/prod/current/scripts/rollback_release.sh
```

## Validation Commands

### Local development validation

```bash
bun run test:unit
bun run test:e2e:smoke
bun run test:e2e:workspace
```

### Service health

```bash
curl http://127.0.0.1:4174/api/health
curl http://127.0.0.1:4173/api/health
systemctl --user status deckterm-dev.service
systemctl --user status deckterm.service
```

`/api/health` returns a `release` field: the deployed release id (commit SHA) in
production, or `"dev"` for a local checkout. To confirm prod is serving the
expected build without trusting the CI badge:

```bash
curl -s http://127.0.0.1:4173/api/health | grep -o '"release":"[^"]*"'
readlink /home/deploy/apps/deckterm/prod/current   # should end in the same SHA
```

## Known Operational Notes

- Production now deploys cleanly from `main` via GitHub Actions
- `deckterm.service` is the production service name
- browser tests target `4174`
- stale local git checkouts can exist without affecting runtime because production runs from release directories
- **A green `Deploy Main` run now means prod is actually serving the new build.**
  The deploy verifies `/api/health` reports the promoted release id and fails
  (with automatic rollback) otherwise. Before this guarantee was added, a deploy
  could silently roll back while the job stayed green.
- History (2026-05): prod was stuck ~17 days on an old build because `bun run
start` leaked its server child onto the candidate port; that stale process
  answered the candidate health probe, so every deploy "passed" the gate, then
  failed live promotion and rolled back behind a green badge. Fixed by killing
  the candidate process tree, gating on a free candidate port, and verifying the
  served release id. If a deploy ever fails with "Candidate port ... already in
  use", a candidate leaked — `kill` the PID on `PROD_CANDIDATE_PORT` (it is not
  the live server, which is on `PROD_PORT`).

## Recommended Team Workflow

1. Work in `feature/*` or directly on `dev`
2. Validate behavior on `4174`
3. Merge to `dev`
4. Promote `dev` to `main`
5. Let `Deploy Main` verify and deploy automatically

## Security and Multiuser Isolation Model

### Multiuser Permissions

DeckTerm enforces multiuser boundaries at the **application level**:

- Each terminal session (`terminal_sessions`) is owned by a specific user identity resolved via Cloudflare Access (`sub`).
- Attaching to a terminal session requires owner status or a matching `terminal.attach` scoped grant.
- Writing to a terminal session (sending input) requires owner status or a matching `terminal.write` scoped grant.

### OS-Level Isolation Disclaimer

> ⚠️ **IMPORTANT SECURITY NOTICE:** DeckTerm's multiuser permissions isolate access within the application layer. However, under the hood, all terminal processes and tmux sessions are executed by the **same Unix user** (e.g. `deploy`) running the Bun/Hono server.
>
> Therefore, DeckTerm **does not provide OS-level containerization or process/file sandbox isolation** between different users' sessions. Any user with interactive shell access (`terminal.write`) can inspect other processes or access files owned by this Unix account. For multi-tenant hosting with strong security boundaries, you must use separate container/VM deployments or different OS-level Unix accounts.
