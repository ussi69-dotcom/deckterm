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
5. copy into `/home/deploy/apps/deckterm/prod/releases/<sha>`
6. install dependencies in the release
7. start a candidate instance on `PROD_CANDIDATE_PORT`
8. wait for candidate health
9. repoint `current`
10. restart `deckterm.service`
11. verify live health on `4173`

## Hardening Notes

The deploy chain currently includes these important fixes:

- SSH key is written with a trailing newline so OpenSSH can load it in GitHub runners
- deploy scripts use an explicit Bun path so non-interactive SSH shells can run Bun
- startup failures exit with status `1` instead of leaving a dead process that still looks alive to systemd

## Promotion flow

1. merge feature work into `dev`
2. validate on `4174`
3. promote `dev` to `main`
4. let `Deploy Main` handle verification and rollout

## Rollback

```bash
DEPLOY_ROOT=/home/deploy/apps/deckterm/prod \
SYSTEMD_SERVICE=deckterm.service \
bash scripts/rollback_release.sh
```

For broader operational details, see [docs/operations-guide.md](/home/deploy/deckterm_dev/docs/operations-guide.md).
