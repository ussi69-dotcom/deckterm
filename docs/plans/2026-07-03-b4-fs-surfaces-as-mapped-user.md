# B4 — All fs/git/exec surfaces as mapped user (impl plan)

> Program: `2026-07-02-enterprise-1.0-program.md` Track B, slice B4. Design authority:
> `2026-07-02-b1-identity-isolation-storage-design.md` §2.5 (the B4 checklist), §2.1–2.3;
> B2 delivery: `2026-07-03-b2-run-as-user-broker.md` (broker, `resolveExecutionContext`,
> `denyIfOsIsolationPending`). Status: **rev 1 — Codex-validated 2026-07-03** (14 findings, all
> incorporated; see §9). Initial verdict was no-go (git/search not fd-contained, git execution
> model undecided, root/grant lifecycle loose); rev 1 closes all three.
> Tiering (program §7 + B4 row): fs helper + broker profiles + shared broker-call layer on the
> strong main loop; per-surface route wiring = Sonnet subagents with briefs; **Codex validates
> this plan, per-slice review on the helper/profiles, and the integrated diff.**

## 0. Scope

Implements from B1 §2.5: every fs/git/search surface acquires the B2 execution context and, when
`brokered`, executes as the mapped uid via the broker — replacing B2's blanket
`os_isolation_pending` 403 per-surface. Concretely:

1. **`deckterm-fs-helper`** — a root-installed, fixed one-shot binary (broker profile `fs`) that
   performs file operations **as the mapped user** with **fd-based containment**
   (`openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`), JSON-over-stdio.
2. **Broker `git` profile** — `/usr/bin/git` with a broker-side allowlisted subcommand/argv
   schema table (same pattern as the S2 tmux schemas), **an fd-based `--root`+`--reldir` cwd
   contract** (the broker opens the granted root, resolves the repo dir beneath it with
   `openat2`, `fchdir`s into it as the dropped user — Codex #1), a **hardened git execution
   model** that neutralizes hooks/config/pager/credential-helper command execution (Codex #5),
   and repo-top-inside-grant enforcement (`GIT_CEILING_DIRECTORIES`, Codex #4). **Local git only;
   network ops (push/pull/fetch) are denied under isolation in 1.0** (Codex #5/#6).
3. **Broker `search` profile** — the existing fixed grep argv as the mapped uid, under the same
   fd-based `--root`+`--reldir` cwd contract (Codex #1).
4. **Server-side brokered fs/git layer** — per-surface wiring in `server.ts` through one shared
   seam (`FsExecutor` / `runGit` context-aware variants); actor-aware path policy for brokered
   contexts (lexical containment against granted roots; app-side realpath stays legacy-only —
   the service account cannot traverse 0700 user homes).
5. **Per-user roots** — a newly created OS mapping auto-provisions a `project_roots` row for the
   user's `$HOME` + a `root.use` grant for that user; brokered path policy resolves against the
   actor's granted roots, not the env-level `ALLOWED_FILE_ROOTS` allowlist.
6. **Task runner: explicit deny stays in 1.0** (see §6 decision D-B4-2).

Non-goals: Alice/Bob adversarial e2e (immediately-next slice, program Track B row 6);
replace-in-files (D4); ripgrep search v2 (D4); recordings (C4); retention (B6); task-runner
brokering (1.1 / B4b, §6); any change to legacy-mode behavior (byte-identical, B2 inv §7.1).

## 1. Design decisions (for Codex)

- **D-B4-1: one-shot fs helper, not a persistent per-uid daemon.** Every brokered fs operation is
  one `brokerExec` (sudo → broker → `systemd-run --scope` → `__drop` → helper), request JSON on
  stdin, response JSON on stdout, scope auto-collected. Rationale: the brokered tmux backend
  already routes **every** tmux client op through `brokerExec`, so per-op broker latency
  (~100–200 ms) is already the accepted isolation-mode cost; a persistent per-uid helper (pipes
  held open, request multiplexing, idle reaping, kill-on-revocation of one more long-lived scope)
  is meaningful new attack/lifecycle surface for a latency win 1.0 does not need. Revisit as a
  1.1 optimization behind the same protocol.
- **D-B4-2: task runner stays denied under isolation in 1.0.** Task workspaces/worktrees live
  under `DECKTERM_STATE_DIR` (service-owned) — a mapped user cannot write there, and B2
  eligibility _forbids_ accounts that can. Brokering tasks means relocating workspaces into user
  homes + threading exec through `task-runner.ts`'s runCommand/worktree/checks paths — a real
  redesign, sanctioned as "explicit deny" by the program B4 row. The deny reason becomes
  `os_isolation_unsupported` (permanent, distinct from `os_isolation_pending`). **The deny must
  cover every `/api/tasks*` route AND the task WS/executor path before any service-owned
  workspace is touched (Codex #14):** S6 walks task create/start/run-checks/judge/pause/reset/
  delete + the task WS upgrade and asserts each returns `os_isolation_unsupported` under isolation
  before `task-runner.ts` runs. Documented in E1.
- **D-B4-2b: doctor + clipboard are TCB, role-gated, no client paths (Codex #14).** The
  onboarding doctor script path is env/server-controlled (`onboarding-doctor.ts:1071`) and its
  mutating routes are already `requireOnboardingAdmin`-gated — stays service-account, documented
  TCB. The clipboard image write currently assembles a path under a shared `/tmp` dir with
  `Date.now()`/`Math.random()` naming (`server.ts:6807-6812`) — S6 hardens it to a **service-owned
  0700 dir** with `O_CREAT|O_EXCL` creation (no predictable-name overwrite, no `/tmp` symlink
  swap), still service-account with no client-controlled path component. Both documented TCB,
  **not** per-user gated.
- **D-B4-3: brokered path policy is lexical + fd-enforced, never realpath.** For brokered
  contexts the server cannot realpath client paths (no traversal rights into 0700 homes) and B1
  Codex #3 demoted app-side realpath to policy anyway. Policy layer: normalize the client path
  (absolute, `path.normalize`, reject any residual `..` segment or NUL), match longest-prefix
  against the actor's **granted** `project_roots`, pass `(root, relpath)` to the helper.
  Containment layer: the helper opens an `O_PATH` fd of the root and resolves `relpath` beneath
  it with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)` — symlink races
  and `..` tricks die in the kernel, as the mapped uid, at operation time.
- **D-B4-4: search is brokered, not denied.** It is the same fixed-argv exec pattern as git; the
  existing secret-exclusion globs, result post-filter, bounds, and per-actor concurrency cap all
  stay server-side and apply unchanged on top of the brokered spawn.
- **D-B4-5: git/search cwd is fd-contained in the broker, never a lexical/realpath string
  (Codex #1).** The server passes `--root <granted-root-abs>` + `--reldir <relpath>` (never a
  single `--cwd`). The broker opens the root fd-safely (§2.3 root-open walk, shared with the fs
  helper), resolves `reldir` beneath it via `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`, and
  the dropped child `fchdir`s into that fd — so a symlinked/swapped path component cannot make
  `git`/`grep` run outside the granted root. This is the same containment guarantee the fs helper
  gives file ops, extended to the two exec profiles.
- **D-B4-6: git is treated as a hardened, config-neutralized execution surface, and network git
  is denied (Codex #5/#6).** Local git can execute arbitrary commands as the mapped uid via hooks,
  `core.fsmonitor`, `diff.external`, textconv, `core.pager`, `credential.helper`, aliases, and
  per-repo `.git/config`. The broker's `git` profile therefore runs with a **fixed hardening
  env/argv**: `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` (repo config still applies
  — the repo is the user's own, and neutralizing it would break legitimate workflows; the mapped
  uid can already run anything in a terminal, so repo-config execution is _within the user's own
  privilege_, not an escalation — the guarantee B4 makes is **containment to the granted root and
  the mapped uid**, not sandboxing the user from themselves), `GIT_TERMINAL_PROMPT=0`
  `GIT_OPTIONAL_LOCKS=0` `GIT_LITERAL_PATHSPECS=1` (Codex #3 — kills `:(top)`/`:/` pathspec
  magic), `GIT_CEILING_DIRECTORIES=<granted-root>` + `--show-toplevel` verified inside the root
  before any mutating op (Codex #4), `-c core.pager=cat -c core.fsmonitor=false` in the base argv.
  **push/pull/fetch route under isolation ⇒ deny `os_isolation_unsupported`** — they need
  network + credential-helper execution the broker can't safely fix in 1.0, and conflict
  resolution "belongs in the terminal" already (the existing route comment). This resolves the
  B1-vs-B4 inventory conflict (Codex #6): the three network routes are the _only_ git surfaces
  that deny; all local git is schema-covered.

## 2. `deckterm-fs-helper` (broker profile `fs`)

### 2.1 Packaging

Python 3 stdlib-only single file (same rationale as the broker: root-owned absolute
interpreter), `scripts/broker/deckterm-fs-helper` in-repo, installed by `install-broker.sh` at
`/usr/local/lib/deckterm/deckterm-fs-helper` root:root 0755. Broker profile:

```json
"fs": { "kind": "exec_stdin", "exec_path": "/usr/local/lib/deckterm/deckterm-fs-helper",
        "properties": { "MemoryMax": "512M", "TasksMax": "16", "CPUWeight": "50" },
        "runtime_max_sec": 30, "nofile": 256 }
```

`kind: exec_stdin` = fixed executable, **zero profile args accepted**, stdin/stdout are pipes
(the broker `__drop` stage already handles non-tty fd 0 — `TIOCSCTTY` is conditional).

### 2.2 Protocol (one request per invocation)

Request: single JSON object on stdin (≤ 32 MiB hard read cap — the request envelope, incl. any
`contentB64`, never exceeds it), then EOF:

```json
{
  "op": "list|stat|read|write|mkdir|delete|rename",
  "root": "/home/alice",
  "path": "projects/x/file.ts", // "" addresses the root itself (list/stat only — Codex #10)
  "toPath": "…", // rename only — must resolve under the SAME root
  "contentB64": "…", // write only
  "expectedMode": null, // write: preserve mode on replace; create mode 0644
  "maxBytes": 2097152, // read: server-supplied cap (route-specific)
  "recursive": false
} // delete only
```

`path: ""` (or absent) means the root directory itself — valid **only** for `list`/`stat`,
rejected for `write`/`mkdir`/`delete`/`rename` (Codex #10). Non-empty paths keep the strict
segment rules (§2.3).

**Size caps are a product decision, not a streaming redesign (Codex #12).** Isolation mode uses
the same caps as legacy: read/edit ≤ `EDITOR_MAX_FILE_BYTES` (2 MiB, `server.ts:5452`), upload
capped per the existing multipart limit. base64-over-stdio within a 2 MiB body is well under the
32 MiB envelope cap and creates no meaningful memory pressure for one-shot helpers; anything
larger is refused `too_large` at the route (as today). Download of a file ≤ 2 MiB uses `read`;
larger downloads are out of scope for isolation mode in 1.0 (documented — legacy mode keeps
streaming). A streaming helper path is a 1.1 item if a real need appears.

Response: single JSON on stdout —
`{ "ok": true, ...op-specific }` or `{ "ok": false, "code": "not_found|too_large|not_regular|
escape_denied|exists|io_error|bad_request", "message": "…" }`. `read` returns
`{ contentB64, size, mode, mtimeMs }`; `list` returns dirents (name, kind, size, mtimeMs — the
shape `/api/browse` needs); `stat` likewise.

### 2.3 Containment rules (the security core — inv 3/4/5)

- **Root open is a full fd-safe walk, not `lstat`+`open` (Codex #2).** `lstat(root)` then
  `open(root, O_NOFOLLOW)` only guards the final component and races on ancestor dirs under
  user-controlled paths. Instead the helper opens the root from `/` **component by component**:
  `open("/", O_PATH|O_DIRECTORY)` then for each segment `openat(dirfd, seg,
O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`, `fstat`ing each to reject symlinks — so no ancestor
  can be swapped for a symlink. (Where available, a single `openat2("/", root-relative,
RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)` does the same in one call.) The resulting fd is the
  containment anchor; all ops are relative to it. Root must be absolute, NUL-free, not `/`.
- `path`/`toPath`: relative, NUL-free, no `.`/`..` segments; empty only for the root-self case
  (list/stat). Resolution via `openat2(dirfd, path, RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|
RESOLVE_NO_MAGICLINKS)`; kernels without `openat2` (< 5.6): component-wise `openat(…,
O_NOFOLLOW|O_PATH)` walk. Any escape/symlink ⇒ `escape_denied`.
- `read`: resolved fd `fstat` must be a regular file, size ≤ `maxBytes` (else `too_large`),
  read via the fd.
- `write` (atomic, B1 §2.5): resolve the **parent** dir fd beneath root; `openat(parentfd,
".deckterm-tmp-<rand>", O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, mode)`; write; `fsync`;
  `renameat(parentfd, tmp, parentfd, basename)`. Replace target pre-checked via
  `openat2` + `fstat`: regular, `st_nlink == 1`, **`st_uid == uid`** (Codex #11 — refuse
  `not_owner` on a group/other-owned file so atomic replace can't clobber or change ownership of
  a file the mapped user doesn't own in a shared root), mode preserved onto the temp file before
  rename. No follow anywhere.
- `delete`: `unlinkat(parentfd, name)` / recursive delete walks **fd-relative** (`fdopendir` of
  an `O_NOFOLLOW`-opened subdir, depth-first `unlinkat`), never path-based; refuses to cross
  device boundaries (`st_dev` change ⇒ abort).
- `rename`: both endpoints resolved beneath the same root fd; `renameat(fromParentFd, name,
toParentFd, name)`; refuses if the destination exists (matches current route semantics).
- `mkdir`: `mkdirat(parentfd, name, 0755)`.
- `search_paths` is NOT an fs-helper op — search spawns grep via its own profile (§4).
- Helper runs entirely as the already-dropped mapped uid — DAC is the second, independent
  boundary; the helper's job is keeping the op inside the _granted root_ even where DAC would
  allow more (e.g. a root scoped to one project inside a home).

### 2.4 Contract tests

`backend/fs-helper-contract.test.ts` runs the helper directly (as the test user, no broker):
escape attempts (`..`, absolute path, symlink at every depth, symlink swapped mid-tree,
hardlinked replace target, FIFO/device nodes), too-large read, atomicity (tmp cleaned on
failure), mode preservation, rename-across-roots refusal, NUL/oversize/malformed JSON refusal.

## 3. Broker `git` profile

`kind: "git"`, `git_path: /usr/bin/git`, per-op exec (30 s server timeout as today's `runGit`).

**fd-based cwd contract (Codex #1/#4).** The verb is `exec --profile git --root <granted-abs>
--reldir <relpath> -- <schema-validated git args>`. The broker opens `root` via the §2.3 fd-safe
walk, resolves `reldir` beneath it with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`, and the
dropped child `fchdir`s into that dir fd (no `--cwd` string, no `realpath`+`chdir`). Before any
mutating subcommand the broker runs `git rev-parse --show-toplevel` in that dir with
`GIT_CEILING_DIRECTORIES=<root>` and refuses (`git_repo_outside_root`) unless the toplevel
resolves **inside** the granted root — so a `.git` above the grant can't be discovered or mutated.

**Hardening env (fixed, per D-B4-6):** `GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1
GIT_CEILING_DIRECTORIES=<parent-of-root> HOME=<user home>`; base argv carries `-c core.pager=cat
-c core.fsmonitor=false -c core.hooksPath=/dev/null`, and `diff`/`show` add `--no-ext-diff
--no-textconv`. `GIT_LITERAL_PATHSPECS=1` neutralizes `:(top)`/`:/`/`:(glob)` pathspec magic
(Codex #3), so a relpath operand can only ever mean a literal path under cwd. **Ceiling is the
root's PARENT** (S2 Codex #1) — a `.git` at the granted root is still discovered, but discovery
never climbs above it. **Containment scope (S2 Codex #2/#4):** with config/pager/hooks/ext-diff/
textconv execution neutralized, the hard guarantee is **cross-uid** isolation; fine-grained root
containment within one uid is best-effort (mount-namespace/chroot is 1.1 container work). The
broker resolves cwd from the canonical (realpath'd) root, so the fd walk and git's ceiling agree
(S2 Codex #3).

Broker-side argv schema table (S2 tmux pattern — validated token-by-token, canonical argv
rebuilt by the broker, never caller strings passed through):

| subcommand  | fixed shape                                                                          |
| ----------- | ------------------------------------------------------------------------------------ |
| `status`    | `--porcelain=v1 -b [-z]`                                                             |
| `rev-parse` | one of `--show-toplevel` / `--abbrev-ref HEAD` / `--git-dir`                         |
| `diff`      | `[--cached] [--stat] [-U<n>] [<rev-token>] -- <relpaths…>`; **`--no-index` refused** |
| `add`       | `-- <relpaths…>` or `-A`                                                             |
| `restore`   | `[--staged] [--worktree] [--source <rev-token>] -- <relpaths…>`                      |
| `commit`    | `-m <msg> [--amend]` (msg = single opaque operand, argv array — no shell)            |
| `branch`    | `[--list] [-a] [--show-current]` / create: `<name-token>`                            |
| `checkout`  | `<name-token> [-b]` / `-- <relpaths…>`                                               |
| `log`       | `[--oneline] [-n <int>] [--format=<fixed-fmt>] [--follow] [-- <relpaths…>]`          |
| `show`      | `<rev-token>:<relpath>` / `<rev-token> [--stat] [--format=<fixed-fmt>]`              |
| `stash`     | `list [--format=<fixed-fmt>]` / `push [-m <msg>] [-- <relpaths…>]` / `pop            | apply | drop [stash@{<int>}]` |
| `clean`     | `-fd -- <relpaths…>` (discard-untracked path only)                                   |
| `worktree`  | **not in 1.0 schema** (tasks denied, D-B4-2)                                         |

Token rules: `<relpaths…>` are relative, no leading `-`, no NUL, no `..`/`.` segment, and (belt
and suspenders over `GIT_LITERAL_PATHSPECS`) no leading `:`; `<rev-token>` matches
`^[A-Za-z0-9._/@{}~^-]{1,128}$` and must not start with `-`; `<name-token>` =
`^[A-Za-z0-9._/-]{1,128}$`, no leading `-`/`.`; `<fixed-fmt>` must be one of the format strings
the routes actually emit (enumerated in the table in-broker, like tmux `-F`). `-c` (except the
two fixed hardening `-c` pairs the broker itself prepends), `--exec`, `--upload-pack`,
`--receive-pack`, `-C`, `--git-dir`, `--work-tree`, and any `--config`-like or `--output`-like
option are **structurally impossible** (schema rebuilds argv; unknown tokens ⇒ refuse).

**Network git denied under isolation (Codex #5/#6):** `push`/`pull`/`fetch` are **not** in the
schema — their routes short-circuit to `os_isolation_unsupported` before reaching the broker
(D-B4-6). A code inventory of `/api/git/*` (done: 13 local routes + the 3-op network loop at
`server.ts:6638`) confirms every remaining git route is schema-covered; the network loop is the
only git deny.

## 4. Broker `search` profile

`kind: "argv_schema"` with a single schema: `<GREP_BINARY> -rnIZ --exclude-dir=… --exclude=…
(-F|-E) -e <pattern> .` — flags fixed by the broker from its config mirror of the server's
exclusion lists (broker refuses unknown flags; pattern is one opaque operand, argv array; a
leading-`-` pattern is passed only after the `-e`, so it can't be parsed as a flag). Env:
`LC_ALL=C`, minimal PATH. **cwd uses the same fd-based `--root`+`--reldir` contract as git
(Codex #1)** — the broker `fchdir`s the dropped child into the `openat2`-resolved subdir beneath
the granted root, and grep runs with `.` as its argument, so a symlinked component can't redirect
it outside the root. Server-side bounds, secret post-filter (`isSecretSearchMatch`), per-actor
concurrency, and result re-validation stay exactly as today (`server.ts:1818+`), applied to
broker stdout instead of local-spawn stdout. (The result re-realpath TOCTOU check is legacy-only;
under isolation the broker's fd-containment is the guarantee, and the server can't realpath into
the user's home anyway — brokered results are trusted as produced within the contained cwd.)

## 5. Server-side wiring

### 5.1 Shared seam (the "broker-call layer" — strong-model slice)

New `backend/services/fs-executor.ts`:

```ts
type FsExecutor = { list; stat; read; write; mkdir; delete; rename }; // op signatures mirror §2.2
function getFsExecutor(ctx: ExecutionContext): FsExecutor;
```

- `legacy` ⇒ the current inline `fs.*` implementations, **moved verbatim** behind the interface
  (byte-identical behavior, same error shapes).
- `brokered` ⇒ ops serialized into §2.2 JSON, `brokerExec({profile:"fs", stdin: payload})`;
  `broker-client.ts` gains stdin-payload support on `brokerExec`.

`runGit(cwd, args)` (server.ts:5750) becomes `runGit(ctx, cwd, args)` — legacy: current
`Bun.spawn`; brokered: `brokerExec({profile:"git", cwd, profileArgs: args})`. A
`assertBrokeredGitArgs(args)` dev-time mirror of the §3 schema fails fast in tests when a route
emits argv the broker would refuse (the broker remains the enforcement point).

### 5.2 Path policy for brokered contexts

New `resolveActorScopedPath(state, actor, ctx, inputPath)` beside `resolveAllowedPath`:

- `legacy` ⇒ `resolveAllowedPath` unchanged (realpath + env allowlist).
- `brokered` ⇒ normalize to **one canonical absolute form** for both roots and input
  (`path.resolve` → collapse `.`/duplicate slashes → strip trailing slash → reject any residual
  `..` segment or NUL), then **segment-boundary-aware longest-prefix** match against
  `project_roots` rows the actor holds `root.use` on (Codex #9: a match requires `input === root`
  or `input.startsWith(root + "/")` — never a raw `startsWith`, so `/home/alice2` can't match
  `/home/alice`; wildcard grants match all registered roots as today). Returns
  `{root, relPath, rootId}` where `relPath` is `""` for the root itself; no realpath, no fs
  touch. `requireFileAccess` keeps writing the same allow/deny audit rows keyed by `rootId`.
  Test matrix (Codex #9): root-equality, trailing/duplicate slash, empty input, `/home/alice` vs
  `/home/alice2`, nested-grant longest-prefix wins.
- `/api/browse` default dir and `resolveTerminalStartDir` for brokered actors default to the
  mapped user's `$HOME` root (fixes the B2 gap where a mapped user's home is outside the
  service-env `ALLOWED_FILE_ROOTS`). Terminal-create cwd validation goes through the same
  actor-scoped resolution when the context is brokered (broker + post-drop chdir already
  enforce traversal as the user).

### 5.3 Per-surface wiring (mechanical slices)

Each route: acquire context once (`resolveExecutionContextForRequest` helper wrapping actor →
`resolveExecutionContext` + deny→403/audit, mirroring `resolvePtyExecutionContext` incl. the
suspend-kill path) → `resolveActorScopedPath` → `getFsExecutor(ctx)` / `runGit(ctx,…)`. The
`denyIfOsIsolationPending` call is **removed per surface as it is brokered**; `files`, `git`
(local), `search` surfaces lift; `tasks` and `git push/pull/fetch` flip to permanent
`os_isolation_unsupported` (D-B4-2/D-B4-6). Audit rows on brokered ops gain `os_uid`,
`os_username`, `brokered:true` (B2 §4.3 pattern).

**Brokered fs/git/search concurrency cap (Codex #13).** A per-uid + global semaphore bounds
in-flight `brokerExec` calls across fs/git/search (each is a `sudo`+`systemd-run` spawn); over
the cap returns `429 { reason: "isolation_busy" }` rather than fork-storming. Search already has
`inFlightSearches` per-actor; the new cap generalizes that to all three brokered exec surfaces
(default per-uid 8, global 64 — env-tunable). Legacy mode is unaffected (no semaphore).

### 5.4 Per-user default root on mapping creation

`POST /api/os-mappings` additionally provisions the mapped account's home as a default root —
but **the home is eligibility-checked first (Codex #7)**, reusing the broker/eligibility probe:
the passwd `$HOME` must be absolute, not `/`, not `/tmp` or any world-writable dir, not the
DeckTerm state/config/broker path, exist, be a non-symlink directory **owned by the mapped uid**
with non-group/world-writable mode. Fail ⇒ the mapping is still created but **no auto-root** is
provisioned (audited `root.provision_skipped` with the reason); the owner grants a root manually.
On success: ensure a `project_roots` row for the normalized home path (created if absent, audited
`root.provision`) and grant `root.use` on that rootId.

**Auto-grants are tied to the mapping (Codex #8).** The auto-created grant carries
`provenance='os_mapping:<userId>'` (a `capability_grants` metadata column already exists, else a
tagged `resourceId` convention) so that **suspend/delete of the mapping revokes exactly the
auto-provisioned grant** — a later remap of the same DeckTerm user to a different unix account
can't leave a stale home-root grant active under the new uid. Manually-added grants are never
touched. No schema migration needed — `project_roots` + `capability_grants` already model this
(confirm the metadata/provenance column exists in S6; if not, it is a tiny additive migration 8).

## 6. Sub-slices (Path A, sequential — `server.ts`/broker are shared files)

| #   | Slice                                                                                                                                               | Files (allowlist)                                                                                                                                                                  | Tests                                                                                                                                                                                                              | Tier                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| S1  | `deckterm-fs-helper` + broker `fs`/`exec_stdin` profile + installer + stdin support in `brokerExec`                                                 | `scripts/broker/deckterm-fs-helper` (new), `scripts/broker/deckterm-broker`, `scripts/broker/broker.json`, `scripts/broker/install-broker.sh`, `backend/services/broker-client.ts` | `backend/fs-helper-contract.test.ts` (§2.4), broker-contract extension (fs profile refusals)                                                                                                                       | **Main loop (Fable), Codex per-slice** |
| S2  | Broker `git` + `search` profiles (schema tables + canonical argv rebuild + fd-cwd `--root`/`--reldir` + git hardening env + repo-top-in-root check) | `scripts/broker/deckterm-broker`, `scripts/broker/broker.json`                                                                                                                     | broker-contract extension: per-subcommand accept/refuse matrix incl. injection vectors (`-c`, `--exec`, glued flags, `--no-index`, `:(top)` pathspec, leading-dash paths, symlinked `--reldir`, `.git`-above-root) | **Main loop (Fable), Codex per-slice** |
| S3  | `fs-executor.ts` + `resolveActorScopedPath` + context-aware `runGit` + `resolveExecutionContextForRequest`                                          | `backend/services/fs-executor.ts` (new), `backend/server.ts` (seam only), `backend/services/broker-client.ts` (types)                                                              | `backend/services/fs-executor.test.ts` (legacy parity + brokered payload assembly, mocked broker), path-policy matrix                                                                                              | **Main loop (Fable)**                  |
| S4  | Files routes → executor (browse, content GET/PUT, upload, download, mkdir, delete, rename) + brokered defaults (§5.2)                               | `backend/server.ts` (files routes region only)                                                                                                                                     | `backend/foundation-b4-files.test.ts` — own chained invocation; legacy suite untouched                                                                                                                             | Sonnet, Fable diff-review              |
| S5  | Git routes + search route → context-aware runners; `assertBrokeredGitArgs` mirror                                                                   | `backend/server.ts` (git/search regions)                                                                                                                                           | `backend/foundation-b4-git.test.ts` — chained; argv-mirror test per route                                                                                                                                          | Sonnet, Fable diff-review              |
| S6  | Mapping-time default root + grant; tasks deny → `os_isolation_unsupported`; terminal-cwd actor-scoped default; docs (E1 addendum, README env table) | `backend/server.ts` (os-mappings + tasks regions), `backend/services/foundation-state.ts` (root provision helper), `docs/security-model.md`, `README.md`                           | extend `foundation-os-isolation.test.ts`                                                                                                                                                                           | Sonnet, Fable diff-review              |

Each brief carries: files-to-read (this doc + B1 §2.5 + B2 §4), the §8 invariants verbatim, the
allowlist, tests, non-goals (§0). Integrated: full `bun run test:unit` + smoke e2e +
`tsc --noEmit` + live legacy check on 4174 + broker/fs-helper live proof with the throwaway
mapped account (B2 harness pattern) → **Codex integrated-diff security pass** → commit.

## 7. Acceptance

- **Unit:** fs-helper contract matrix (§2.4); broker git/search accept/refuse matrix; path-policy
  matrix (granted/ungranted root, `..`, symlinked prefix, wildcard vs scoped grant); executor
  legacy-parity (same bytes/errors as today's inline code); every files/git/search route × context
  {legacy, brokered(mock), deny} in the two new chained test files.
- **Live (dev host, throwaway `deckterm-users` account):** mapped user lists/reads/writes only
  within their granted root; editor save round-trips preserving mode; git status/stage/commit in
  their own repo authors as their account; search returns only their files; every op appears in
  audit with `os_uid`; the service account (via a second actor) still works fully in legacy mode.
- **Legacy suite:** byte-identical — full `test:unit` + smoke e2e green without the flag.

## 8. Invariant checklist (bake verbatim into every brief + diff review)

1. Legacy mode is byte-for-byte unchanged: no brokered code path, no behavior/error-shape drift
   on any route, no new startup refusals; the executor's legacy branch is today's code moved, not
   rewritten.
2. Brokered contexts never realpath client paths and never touch the fs from the service account
   for policy decisions; containment is fd-based in the helper AND for git/search cwd — the root
   fd is opened via a full component-wise symlink-rejecting walk (not `lstat`+`open`, Codex #2),
   ops resolve beneath it with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)`
   (or the `O_NOFOLLOW` fallback); the app-side check is lexical policy only.
3. There is no third state: every fs/git/search request resolves {legacy | brokered | deny};
   deny never falls back to service-account execution (B2 inv 4 restated for B4 surfaces).
4. The helper accepts exactly one JSON request on stdin, zero argv beyond the fixed profile;
   root absolute non-symlink dir (never `/`); `path:""` = root-self (list/stat only); other paths
   NUL-free relative with no `.`/`..`; writes are atomic (`O_EXCL` temp + `renameat`), `O_NOFOLLOW`
   everywhere, replace targets `fstat`-checked regular `st_nlink==1` **and `st_uid==uid`**
   (Codex #11), mode preserved; deletes/renames fd-relative, never path-based.
5. Git/search argv AND cwd reach the broker structurally: argv rebuilt from the schema table (no
   caller string passes through; `-c`/`--exec`/`--git-dir`/`--work-tree`/`--no-index`/config-
   injection impossible; relpaths never lead with `-` or `:`; rev/name tokens match their regexes),
   cwd via `--root`+`--reldir` fd-resolution (Codex #1). Git runs with the fixed hardening env
   (`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, `GIT_LITERAL_PATHSPECS=1`, `GIT_CEILING_DIRECTORIES=root`,
   `GIT_TERMINAL_PROMPT=0`; `-c core.pager=cat -c core.fsmonitor=false`) and refuses if the repo
   toplevel is not inside the granted root (Codex #3/#4).
6. Network git (`push`/`pull`/`fetch`) is denied `os_isolation_unsupported` under isolation —
   never brokered (Codex #5/#6). Local git is fully schema-covered; the git route inventory is
   proven exhaustive (13 local routes + the 3-op network loop).
7. Every brokered surface acquires context through the single resolver (`resolveExecutionContext`)
   with the same suspend-kill semantics as PTYs; every allow/deny is audited with `os_uid`/
   `os_username`/`brokered` (denies via the persisted aggregation counter). Brokered fs/git/search
   are bounded by a per-uid + global concurrency cap → `429 isolation_busy` over the cap
   (Codex #13); legacy mode has no semaphore.
8. Brokered path policy uses one canonical absolute form for roots and inputs and matches on
   **segment boundaries** (`input===root` or `input.startsWith(root+"/")`, Codex #9); ungranted
   roots deny `no_matching_root` exactly as today. Members gain no wildcard anything (B3 inv).
9. Per-user home root is auto-provisioned only after the home passes the eligibility probe
   (absolute, not `/`/`/tmp`/state/config, non-symlink dir owned by the mapped uid, sane mode,
   Codex #7); the auto-grant is tagged to the mapping and revoked on suspend/delete so a remap
   leaves no stale grant (Codex #8); manual grants untouched.
10. Task/onboarding/clipboard never silently execute user-attributed fs work as the service
    account under isolation: every `/api/tasks*` route + task WS/executor denies
    `os_isolation_unsupported` before touching a service-owned workspace (Codex #14); doctor is
    role-gated TCB; clipboard writes to a service-owned 0700 dir via `O_CREAT|O_EXCL`, no client
    path.
11. `DECKTERM_BROKER_PATH`/`DECKTERM_FS_HELPER_PATH` overrides honored only in dev/test; installed
    binaries root:root 0755 verified by the broker's packaging self-check (extended to the helper).
12. Isolation-mode fs read/edit/upload sizes reuse the legacy caps (2 MiB editor cap etc.); the
    helper request envelope is ≤ 32 MiB; downloads > 2 MiB are out of scope for isolation in 1.0
    (Codex #12). No new schema migration unless the grant-provenance column is absent (then a tiny
    additive migration 8); provisioning rows are audited and idempotent.

## 9. Validation record (Codex, 2026-07-03, deep/xhigh)

Initial verdict **no-go as written**; 14 findings, **all incorporated** into §1 decisions, §2–5,
and the §8 invariants. Summary:

1. Git/search cwd was lexical+broker-`realpath` → not fd-contained: added the `--root`+`--reldir`
   fd contract (broker `openat2`-resolves + `fchdir`s the dropped child), §3/§4, D-B4-5, inv 2/5.
2. fs-helper root open was `lstat`+`O_NOFOLLOW` (races ancestors) → full component-wise
   symlink-rejecting walk / `openat2` from `/`, §2.3, inv 2.
3. Git pathspec magic (`:(top)`) could escape the subdir → `GIT_LITERAL_PATHSPECS=1` + reject
   leading `:`/magic/absolute pathspecs, §3/D-B4-6, inv 5.
4. Git repo discovery could cross the grant (`.git` above) → `GIT_CEILING_DIRECTORIES` +
   `--show-toplevel`-inside-root check before mutating ops, §3, inv 5.
5. Git remained an execution surface (hooks/config/pager/credential helpers) → hardening env,
   config neutralized, network git denied; git classified as user-privilege execution contained
   to root+uid, D-B4-6, inv 5/6.
6. B1-vs-B4 git inventory conflict → code inventory done (push/pull/fetch DO exist); network loop
   denies, all local routes schema-covered, §3, inv 6.
7. `$HOME` auto-root provisioning was unchecked → eligibility probe on the home before
   provisioning, §5.4, inv 9.
8. Auto-grants went stale across remaps → grant tagged to the mapping, revoked on suspend/delete,
   §5.4, inv 9.
9. Lexical prefix matching underspecified → canonical form + segment-boundary match + test matrix,
   §5.2, inv 8.
10. Helper couldn't represent root-dir ops → `path:""` root-self semantics for list/stat, §2.2,
    inv 4.
11. Write missing owner check → `st_uid==uid` on replace targets, §2.3, inv 4.
12. Upload/download streaming undesigned → size caps are a product decision (reuse legacy caps,
    32 MiB envelope, >2 MiB download out of scope for isolation 1.0), §2.2, inv 12.
13. One-shot helper could fork-storm → per-uid + global brokerExec concurrency cap → `429`, §5.3,
    inv 7.
14. Task/doctor/clipboard cuts unproven → task deny audited across every route + WS before
    workspace touch; doctor role-gated TCB; clipboard hardened to service-owned 0700 `O_EXCL`,
    D-B4-2/D-B4-2b, inv 10.

**Post-incorporation status: cleared to code.** S1 (fs helper + root-walk + owner check) →
S2 (git/search fd-cwd + hardening + schema) → S3 (executor + path policy + concurrency cap) →
S4/S5/S6 (route wiring + provisioning + cuts). Each coded slice gets a Fable diff-review against
§8; S1/S2 additionally get a Codex per-slice review; the integrated diff gets a Codex security
pass before commit.
