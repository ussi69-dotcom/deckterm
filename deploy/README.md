# Deploy Layout

This is the current release model for DeckTerm.

The repository now uses:

- `feature/*` for scoped work
- `dev` for integration
- `main` for production

Production is deployed from GitHub Actions into immutable release directories. It does not run from a mutable live checkout.

## Current server layout

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

`prod.env` is the shared production environment file. It should include `PORT=4173`.
Release schema contracts are stored under `prod/shared/schema-contracts/`; they are inert
JSON snapshots used to decide whether an older release can safely ignore a newer schema.

## Production service

The production systemd unit is:

- `deckterm.service`

It runs from:

- working directory: `/home/deploy/apps/deckterm/prod/current`
- environment file: `/home/deploy/apps/deckterm/shared/prod.env`

The template is `deploy/systemd/deckterm-prod.service.example`. Two lines in it
are load-bearing for persistent sessions and must survive local edits:
`KillMode=process` (tmux outlives a restart) and the `Environment=PATH=` line
(agent CLIs in `~/.local/bin`). Pair it with
`deploy/needrestart/deckterm.conf` so unattended upgrades never restart the
unit — see `docs/install-dedicated-server.md` §4b.

Daily local state-backup unit templates live under `ops/systemd/`. Production uses
`deckterm-backup.{service,timer}` and development uses the separate
`deckterm-backup-dev.{service,timer}` pair. They are not installed by deployment.

## GitHub configuration

### Required repository secrets

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`

### Required repository variables

- `ENABLE_PROD_DEPLOY=1`
- `DEPLOY_PORT` default `22`
- `DEPLOY_ROOT` default `/home/deploy/apps/deckterm`
- `PROD_PORT` default `4173`
- `PROD_CANDIDATE_PORT` default `4273`
- `PROD_SERVICE` default `deckterm.service`

### Recommended branch protection

- `dev`
  - PR required
  - required checks: `unit`, `smoke-e2e`
- `main`
  - PR required
  - required checks: `unit`, `smoke-e2e`
  - at least one approval

Helper:

```bash
GITHUB_PERSONAL_ACCESS_TOKEN=... \
bash scripts/configure_github_branch_protection.sh
```

## Deployment flow

`Deploy Main` performs:

1. verify the exact `main` commit
2. package it as a release artifact
3. upload it to the server
4. unpack into `/home/deploy/apps/deckterm/incoming/<sha>`
5. invoke the deploy driver and safety tools from the active reviewed release, with the
   incoming directory passed as `SOURCE_DIR`
6. copy into `/home/deploy/apps/deckterm/prod/releases/<sha>`
7. install dependencies in the release
8. create a serialized, hashed and integrity-checked production-state backup
9. restore that backup into a private candidate state/capture/tmux namespace
10. start a direct Bun preflight process on `PROD_CANDIDATE_PORT`
11. require exact candidate release identity and `preflight: true`
12. stop the candidate and verify additive rollback schema compatibility
13. remove the private candidate state, then repoint `current`
14. restart `deckterm.service`
15. verify exact live release identity on `4173`

## Hardening Notes

The deploy chain currently includes these important fixes:

- SSH key is written with a trailing newline so OpenSSH can load it in GitHub runners
- deploy scripts use an explicit Bun path so non-interactive SSH shells can run Bun
- startup failures exit with status `1` instead of leaving a dead process that still looks alive to systemd
- candidates never open live state and cannot run task, tmux recovery, clipboard cleanup,
  capture, or retention work during preflight
- the pre-promotion backup is verified twice and its manifest is the atomic completion marker
- rollback compatibility is checked from schema contracts without starting old server code
- deploy and rollback share one host lifetime lock; concurrent operations fail before a
  release symlink or service changes
- release retention uses deployment-directory modification time while always preserving
  `current` and `previous`

## Promotion flow

1. merge feature work into `dev`
2. validate on `4174`
3. promote `dev` to `main`
4. let `Deploy Main` handle verification and rollout

## Rollback

```bash
DEPLOY_ROOT=/home/deploy/apps/deckterm/prod \
SYSTEMD_SERVICE=deckterm.service \
bash /home/deploy/apps/deckterm/prod/current/scripts/rollback_release.sh
```

For broader operational details, see [docs/operations-guide.md](/home/deploy/deckterm_dev/docs/operations-guide.md).
