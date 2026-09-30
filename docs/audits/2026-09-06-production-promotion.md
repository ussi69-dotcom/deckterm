# Production promotion record — 2026-09-06

## Outcome

The owner authorized production deployment. The one-time reviewed bootstrap returned exit status 0.
The new service started at 09:43:19 UTC; post-promotion gates completed at 09:43:39 UTC. Production now serves release
`4eb15831027eb9d683e5d4fa97b75be62ef26035`; the prior live release
`98f5175298adf7e6603ba90fca9d3d4aa170ab01` is retained as `previous`.

This was a manually authorized bootstrap, not a GitHub Actions deployment. The deployed
source was the reviewed local branch `fix/audit-repairs-20260906`; it is not pushed.
The deployment archive SHA-256 was
`3aeeca6ff559bdab73a59d345db847156f8ee9800dd4d7c96f19c422c1c52f01`.

## Verified production facts

- The private driver restore and inert preflight completed before promotion. Rollback schema
  contracts were compatible.
- Exact live health reported the deployed release and three terminals. The post-promotion
  service main PID was `3952686`.
- The promotion created backup `20260906T094318Z`; its verified database digest was
  `6a530387cc44867bfdd23358e4462723bc2efc1ec6109116b7f55b4ecac48aeb` and integrity was `ok`.
- The five selected physical tmux pane creation/PID/dead-state tuples were preserved. The
  corresponding selected terminal-catalog fields were identical before and after promotion.
- An independent postcheck approved the release: all 434 released
  regular files and all six driver hashes matched the reviewed archive, and the selected tmux,
  catalog, and service comparisons remained exact. The live database `integrity_check` was
  `ok`; the bounded service journal had 53 lines and no error, failure, or fatal record.
- Private application-boundary verification confirmed that six representative deployed frontend
  and backend files matched the archive, unauthenticated loopback `/` and `/api/settings`
  returned `401`, and a public browser reached Cloudflare Access sign-in.

The private host receipt is at
`/home/deploy/apps/deckterm/prod/shared/promotion-receipts/4eb15831027eb9d683e5d4fa97b75be62ef26035`.
It contains the operational evidence. This repository records only the safe summary above;
it does not copy terminal catalog rows, journal output, user identifiers, tmux names, terminal
contents, environment values, or workspace inventories.

## Continuity addendum

The initial strict baseline found two physical panes whose catalog rows had already been ended
on 2026-08-10 and 2026-08-11. A separately reviewed authorization supplement compared the
three active and two already-ended selected tuples without reviving, killing, or changing a
database row. Its systemd `WorkingDirectory`, `EnvironmentFiles`, and `KillMode` gates passed
before and after promotion. The supplement and its review are retained only in the private
receipt.

This preserves evidence of the historical catalog discrepancy; it does not claim that the
underlying race was reproduced or repaired.

## Open follow-up

- An authenticated manual browser render/action smoke is pending because no authenticated
  browser session was available during this window. The public browser had no authenticated
  cookie. No full browser test suite was run against port 4173.
- Production backup timer installation, off-host backup transfer, failure/age notification,
  privileged helper upgrade, and OS-isolation enablement were outside this authorization.
- `origin/dev` advanced to `47d6f26` with concurrent lifetime/tmux-unit changes. The reviewed
  deployed tree does not include those changes; a separate integration is required because it
  overlaps five files. Do not merge it as part of this promotion.
- The source was committed locally; no push or main merge occurred. After source integration,
  a new release can use the active driver through the normal `Deploy Main` workflow.
