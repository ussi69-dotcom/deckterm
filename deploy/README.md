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

The production systemd units are:

- `deckterm.service` — the backend and web UI
- `deckterm-tmux.service` — the tmux server that holds terminal sessions

Both run from:

- working directory: `/home/deploy/apps/deckterm/prod/current`
- environment file: `/home/deploy/apps/deckterm/shared/prod.env`

## The tmux server runs in its own unit

Terminal sessions live in a tmux server. If that server is started implicitly by
the backend — which is what happens the first time a terminal is created — tmux
parents it to `deckterm.service`. The systemd default `KillMode=control-group`
kills every process in a unit's control group on stop, so the tmux server and all
its shells die with the backend on *any* restart.

That includes restarts nobody asked for. On Ubuntu, `needrestart` restarts
services automatically after a shared-library security upgrade; on 2026-08-26 a
`libcurl` update did exactly that and destroyed three live sessions, one of them
eighteen minutes into an unattended job. The backend's shutdown line says
`(tmux sessions preserved)` — with the server inside the cgroup, that is false.

`deckterm-tmux.service` puts the server in its own control group, so restarting,
redeploying or crashing the backend leaves sessions alone. Stopping the tmux unit
is what ends them, which is the point.

### Installing it

```bash
sudo cp deploy/systemd/deckterm-tmux.service.example \
        /etc/systemd/system/deckterm-tmux.service
sudo systemctl daemon-reload
sudo systemctl enable --now deckterm-tmux.service
```

Then add to `prod.env`:

```
TMUX_REQUIRE_EXTERNAL_SERVER=1
```

With that set, the backend refuses to start a tmux server itself: if the unit is
not running it fails terminal creation with a message naming the unit, instead of
silently recreating the original problem. Leave it unset for local checkouts,
where no unit is installed and the implicit start is what you want.

`deckterm.service` gains `Wants=`/`After=deckterm-tmux.service`. `Wants=` rather
than `Requires=` so a broken tmux server does not take the web UI down with it.

### Migrating a running box

Sessions cannot be moved between control groups. Adopting this costs **one last
restart that destroys the current sessions** — after that they are protected.
Check what is running in them first; scrollback is kept in
`/tmp/deckterm-tmux-pipes/*.log`, but only until the next reboot.

### The socket path is derived, never hardcoded

`ExecStart` runs `backend/tmux-server-launch.ts`, which computes the socket path
with `getTmuxSocketPath()` and `resolveTmuxSessionNamespace()` — the same
functions the backend uses — from the same `prod.env`.

Do not replace it with a literal `tmux -S /path/... start-server`. Without a
namespace the backend falls back to `p<PORT>`, not to `default`, so a hardcoded
path drifts the moment `TMUX_SESSION_NAMESPACE`, `PORT` or `DECKTERM_STATE_DIR`
changes. The unit would then hold a server on one socket while the backend
started its own — back inside its own control group — on another, and nothing
would look wrong until the next restart. `backend/tmux-server-launch.test.ts`
pins the two derivations together.

The launcher also sets `exit-empty off` in the same tmux invocation as
`start-server`. tmux defaults that to on, so a server started before any session
exists would otherwise exit immediately; splitting it into a second command is a
race the unit loses on a cold boot.

### needrestart

The new unit is itself a restart target after a libc or libevent upgrade — the
same failure through a new door. On Ubuntu, exempt both units:

```bash
printf '$nrconf{override_rc}->{qr(^deckterm)} = 0;\n1;\n' \
  | sudo tee /etc/needrestart/conf.d/deckterm.conf
```

The `^deckterm` prefix covers `deckterm.service` and `deckterm-tmux.service`.
The cost is that both keep an old library mapped until restarted deliberately.

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
