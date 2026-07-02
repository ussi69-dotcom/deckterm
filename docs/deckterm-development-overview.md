# DeckTerm — přehled vývoje a stav projektu

> **Datum:** 2026-05-29 · **Delta 2026-06-16 viz sekce 0z**

## 0z. Delta 2026-06-16 — VS Code-grade workspace HOTOVÝ (fáze 2 + 3 + 4)

**Fáze 2 — VS Code-grade git panel (na `dev`):** git-scm pure helpery, strom změn
(staged/changes/untracked, status písmena+barvy, hover akce), `@codemirror/merge`
split+inline diff editor, header sync akce (pull/push/fetch/stash) za capability
gatem, stash list (apply/pop/drop), amend toggle. Side fix: přidán `.prettierignore`
— quality-gate prettier hook expandoval minifikovaný `web/vendor/codemirror.js`
(33 → ~30k řádků) při každém editu.

**Fáze 3 — explorer⇄git dekorace + timeline + editor gutter (na `dev`,
impl plán `docs/plans/2026-06-16-vscode-phase3-explorer-git-timeline.md`):**

- **Backend `root` field** (`2ba8ead`): `GET /api/git/status` vrací absolutní git
  toplevel, aby šly mapovat porcelain (repo-relativní) cesty na absolutní.
- **Editor gutter** (`a7ebfce`): `@codemirror/merge` `unifiedMergeView`
  (`mergeControls:false`, jen change-bary) vs HEAD; edit/save/undo/selection
  ověřeny bez regrese; bez gutteru pro untracked/not-a-repo.
- **Explorer dekorace** (`ca5fea4`): sdílený `web/git-status-store.js` (cache +
  `refreshStatus` + listener) → `web/git-decorations.js` → status badge+barva na
  řádcích exploreru; reuse `statusLetter`/`statusClass` z `git-scm.js`.
- **Per-file timeline** (`8da0284`): „Timeline" tab v pravém panelu nad
  `GET /api/git/log?path=`; klik na commit → diff revize přes existující
  `renderMergeDiff`. Scope: current-path only; root/add diff fallbackuje na
  prázdnou stranu (backend `show` regex odmítá `<sha>~1`/`^`, proto se jako prevRef
  bere full hash předchozího log entry, root → empty-tree sha).
- Testy: `git-status-store.test.js`, `git-decorations.test.js`, `git-timeline.test.js`,
  `editor-git-gutter.test.js` (vše v `test:unit`), e2e `explorer-git-decorations.spec.ts`,
  `git-timeline.spec.ts`, `editor-git-gutter.spec.ts`. Full unit + 19 e2e zelené na 4174.
- **Orchestrace:** fáze 3 dělaná přes paralelní subagenty (Task 0‖C, pak A→B);
  návrh prošel Codex (gpt-5.5) druhým názorem (chytil root/add diff + rename scope).
  Pozn.: agent worktree izolace zde dala zastaralou bázi → tasky běžely v hlavním checkoutu.

**Fáze 4 — settings UI (na `dev`, impl plán
`docs/plans/2026-06-16-vscode-phase4-settings-ui.md`):**

- **Schema registry** (`web/settings-schema.js`, `0f780c8`): deklarativní
  `SETTINGS_SCHEMA` (13 nastavení, 7 kategorií) + pure helpery `searchSchema`/
  `categoriesOf`/`defaultsOf`/`coerceValue` — single source of truth pro UI i klíče.
- **env-info endpoint** (`3ecc556`): `GET /api/settings/env-info` — hardcoded
  allowlist, secrets vyloučené, path-valued config (`ALLOWED_FILE_ROOTS`,
  `DECKTERM_STATE_DIR`) coarsené (label+count) a přesné cesty jen za filesystem
  capability (`actorHoldsFilesystemCapability`, read-only bez audit-deny).
- **Settings okno + runtime** (`1ec1dd4`): VS Code two-pane SurfaceWindow (sidebar
  - search + controls ze schématu, read-only Server Config sekce), centrální
    `web/settings-runtime.js` aplikuje side-effecty i bez otevření okna; entry pointy
    v command palette + toolbaru.
- **Migrace** (`f1b7fb6`): 6 legacy localStorage klíčů → kanonické klíče přes
  `web/settings-migration.js` (presence-test, flush-před-flagem `settings.migratedV1`,
  žádný legacy fallback u konzumentů). Při tom opraven latentní bug: kolize
  `const Schema` napříč `<script>` tagy tiše abortovala settings-runtime.
  Pozn.: `terminal.autoCopy` default je teď `false` (schema = source of truth).
- Testy: `settings-schema/-ui/-runtime/-migration.test.js`, `foundation-env-info.test.ts`
  (vše v `test:unit`), e2e `settings-ui.spec.ts`, `settings-migration.spec.ts`.
  Full unit (exit 0) + 13 e2e zelené na 4174.

**→ Tím je celý VS Code-grade workspace (fáze 1–4) HOTOVÝ.** Orchestrace fází
3 i 4 přes paralelní/serializované subagenty s Codex (gpt-5.5) druhým názorem na
každý plán.

---

## 0a. Delta 2026-06-12 (večer) — VS Code-grade workspace, fáze 1

Směr schválen uživatelem: UI dotáhnout na úroveň VS Code **uvnitř DeckTermu**
(žádný embedovaný code-server — obcházel by foundation gates). Deštníkový design:
`docs/plans/2026-06-12-vscode-grade-workspace-design.md` (4 fáze), impl plán fáze 1:
`docs/plans/2026-06-12-workspace-windows.md`.

**Fáze 1 hotová (vše na `dev`, ověřeno Playwrightem na 4174):**

- **Surface windows** (`web/surface-windows.js`): Files/Git/Tasks/Editor jsou na
  desktopu (≥768px) přesouvatelná, resizovatelná okna se snapem (poloviny/kvadranty/
  maximalizace, Windows/VS Code styl) a z-orderem; mobil nechává fullscreen sheets.
  Files+Git mohou být otevřené současně (padla vzájemná exkluzivita right-surface).
- **Bottom dock**: akce „Dock" (overflow + palette) přepne terminálovou plochu do
  spodního VS Code-style panelu se sashem (15–75 %, dblclick reset); size-warning
  je v dock módu potlačen.
- **Settings KV**: `user_settings` tabulka (migrace 4) + `GET/PUT /api/settings`
  (actor-scoped, merge sémantika, null maže klíč) + `web/settings-store.js`
  (debounced batch PUT, localStorage fallback). Geometrie oken a dock stav se
  obnovují napříč zařízeními/prohlížeči.
- Testy: `foundation-settings.test.ts` (samostatný chain link v `test:unit`),
  `settings-store.test.js`, `surface-windows.test.js`, e2e `workspace-windows.spec.ts`;
  upraven `file-explorer-surface.spec.ts` (koexistence oken je teď záměr).

**Fáze 2–4 (plánované):** VS Code-grade git panel (strom změn, `@codemirror/merge`
diffy, push/pull/fetch/discard/stash za capability gatem) → explorer⇄git dekorace +
per-file timeline + editor gutter → settings UI (kategorie + search, migrace
localStorage klíčů).

---

## 0. Delta 2026-06-12 — noční QoL/direction session

Směrové rozhodnutí (uloženo i v agent memory): DeckTerm je **agent-aware dev cockpit**
pro jednoho vývojáře + pár důvěryhodných lidí — ne multi-tenant; kontejnerová izolace
max. pro task runs, až po UX. Plán noci: `docs/plans/2026-06-10-overnight-qol-and-direction.md`.

**Opravené bugy (zásadní):**

- **Sdílený tmux socket dev+prod** (`/tmp/deckterm/deckterm_deckterm.sock` — oba `.env`
  mají namespace `deckterm`) + `KillMode=control-group` ⇒ každý restart služby zabil tmux
  server i sessions druhé instance. Fix `2618203`: socket je `$DECKTERM_STATE_DIR/tmux/…`,
  dev unit má `KillMode=process` (tmux přežívá restart — ověřeno živě vč. obnovy scrollbacku).
  **Prod čeká:** KillMode + jednorázová ztráta starých sessions při příštím deployi —
  runbook `docs/plans/2026-06-12-cloudflare-access-switch-runbook.md`.
- **test:unit červený lokálně** — testy dědily env z DeckTerm service (legacy bypass,
  tunnel mode); fix `5fcd118` izoluje env ve foundation testech.
- **Reconnect klasifikace** běžela jen na 3. pokusu a neuměla ended-in-catalog ⇒ klient
  mlel 10/10 místo přesného overlay; fix `c24c306` (+ live countdown příštího pokusu).
- Mrtvý kód pryč: OpenCode proxy (-215 řádků v server.ts) a `gateway.py` (`90a736e`).

**Nové funkce:** scrollback search Ctrl+Shift+F (`6893240`) · palette módy `@` sessions /
`$` saved commands (`6ed2b4c`) · vysvětlitelné 403 (strukturované deny payloady +
`access-denied.js`, `ce92c5e`) · task badge v toolbaru + transition toasty (`9d801f8`) ·
kanban board v task panelu + default provider claude (`bff50f5`) · **in-browser editor
souborů** — CodeMirror 6, atomický save s mtime conflict guardem, audit (`572b261`).

**Bezpečnost/deploy:** `/api/health` vyjmut z CF Access JWT validace (deploy gate jede
přes loopback; `2c0011f`) a připraven kompletní runbook na přepnutí prodů
`cloudflare-tunnel → cloudflare-access` (per-user identity, aktivace gates) — provádí
Lukáš ručně dle runbooku.

Pozn.: scrollback replay po reconnectu (Hermes tip) **už existoval** (delta replay přes
`lastEventId` → `capture-pane -S -2000` fallback) — jen nebyl ověřený; teď je.

---

> **Účel:** Jeden dokument, ze kterého pochopíš, kde DeckTerm je, jak vznikal, jak se nasazuje na nový server, co je autoconfig, jak je navržen multisession a k čemu slouží tasky.
> **Pro koho:** pro tebe (orientace po delší době) i pro někoho nového, kdo by projekt přebíral.

Tohle je živý přehledový dokument. Detailní rozhodnutí a plány jsou v `docs/plans/`; tady je propojuju do celkového obrázku.

---

## 1. Co DeckTerm je (v jedné větě)

Browser-based terminálový workspace pro dlouhoběžící vzdálené dev session: perzistentní tmux shelly, plovoucí/dlaždicový window manager, mobile-first ovládání, file explorer + git panel omezený na povolené rooty, agent-aware status badge a supervizovaný task runner.

**Stack:** Bun runtime (kvůli `Bun.Terminal` PTY API) · Hono (routing/CORS) + nativní Bun WebSocket · vanilla JS + xterm.js frontend · `bun:sqlite` pro foundation state · tmux pro perzistenci. Jediné runtime dependency: `hono`, `@hono/cloudflare-access`.

Klíčová vlastnost z hlediska rizika: **je to mocný nástroj na host-shell a filesystem.** Proto poslední ~3 měsíce vývoje nejsou nové terminálové fíčury, ale **bezpečnostní foundation**.

---

## 2. Časová osa vývoje

Vývoj má dvě jasně oddělené éry:

### Éra A — produktové UI fíčury (leden–duben 2026)

Většina commitů do ~dubna byla o použitelnosti terminálu a UI:

- terminal UI stabilita, scaling fix, clipboard overhaul, platform-adaptivní UI
- lazygit-style git panel + git API
- file explorer sidebar
- command palette + navigation layer, jump-layer MVP, recent workspaces
- shell action hierarchy + customizovatelné layouty toolbaru
- desktop tab wrap, toolbar overflow density, tab signal priority, merged workspace tab summary
- agent state badges (telemetry klasifikuje výstupní fázi agenta)
- foreground-running detekce

Tyhle věci dělají z DeckTermu příjemný terminál v prohlížeči. Plány k nim jsou v `docs/plans/2026-01-*` až `2026-04-*`.

### Éra B — bezpečnostní foundation (květen 2026 → teď)

V květnu proběhl review (`docs/plans/2026-05-12-deckterm-foundation-decisions.md`) s jedním zásadním rozhodnutím:

> **DeckTerm nepřepisovat. Posilovat funkční produkt malými, mergeable, bezpečnostně orientovanými řezy.**

Z toho vznikla série řezů **C0 → C1a → C1b → C2**, každý se ships _s testy_. Tohle je dominantní recent work a to, v čem ses začal ztrácet — rozepisuju to v sekci 3.

```
9462319  docs: capture DeckTerm foundation plan      ← rozhodnutí (C0/C1/C2 split)
4df04e3  feat: foundation bootstrap gate             ← C0
c85e992  feat: foundation capability grants          ← C0/C1 příprava
1ce7245  feat: C1a Multiuser Foundation + C1b design  ← C1a (actor/grants/sessions)
b1c8324  feat(tmux): opaque session names            ← C1b-01
4ffc893  feat(tmux): isolated tmux socket            ← C1b-02
1fda83b  feat(sessions): catalog reconnect flow      ← C1b-03
3768fe5  refactor: TerminalBackend interface         ← C1b-04
38b082c  feat: terminal.write mode + events log      ← C1b-05 & C1b-06
bb256e0  feat(ui): sessions drawer + mode indicators ← C1b-07
a908737  feat(cleanup): zombie reconciliation + reapers + OS isolation warnings ← C1b-08
ac208cd  feat(security): file/git/task gates + doctor hardening ← C2  (HEAD)
```

---

## 3. Bezpečnostní foundation — jak to dnes funguje

Princip: **strangler refactor.** Doménová logika postupně migruje z monolitického `server.ts` do `backend/services/foundation-*.ts`. Route handlery zůstávají tenké a volají služby.

### 3.1 Datový model (`backend/services/foundation-state.ts`)

`bun:sqlite` databáze v `$DECKTERM_STATE_DIR/deckterm.db` (default `$HOME/.deckterm`) s číslovanými migracemi. Tabulky:

| Tabulka             | Co drží                                                        | Řez    |
| ------------------- | -------------------------------------------------------------- | ------ |
| `users`             | uživatelské identity                                           | C0     |
| `project_roots`     | povolené rooty (import z `ALLOWED_FILE_ROOTS`)                 | C0     |
| `terminal_sessions` | vlastnictví + metadata terminálů (zdroj pravdy pro autorizaci) | C0/C1a |
| `audit_events`      | allow/deny rozhodnutí (actor, resource, action, reason, ts)    | C0     |
| `auth_identities`   | mapování Cloudflare Access `sub` → user                        | C1a    |
| `scoped_grants`     | konkrétní granty (capability + resource_type + resource_id)    | C1a    |
| `terminal_events`   | sekvenční log výstupu/control událostí pro recovery cursor     | C1b    |

Capabilities (granty): `terminal.create`, `terminal.attach`, `terminal.write`, `terminal.manage`, `root.use`.

**Gotcha:** `foundationStatePromise` je **module-level singleton** — jeden foundation state na proces. Proto API testy drží jeden foundation-bearing test na soubor (viz `task-api.test.ts`).

**Gotcha (state dir, 2026-06-01):** `DECKTERM_STATE_DIR` je rovněž module-level const zmražený při importu `server.ts`. Runtime služby v `createWebApp()` (task runner) proto resolvují state dir **za běhu** přes `resolveStateDir()` — jinak by test, který nastaví temp dir až po importu, psal task workspace do živého `~/.deckterm/tasks` (leakly `api-task-*` do reálného UI). Prod beze změny (env je při startu stabilní). `task-api.test.ts` má guard, že task přistál pod temp dir.

### 3.2 Bootstrap gate (C0)

Čerstvý/produkční start zablokuje host-terminal přístup, dokud neexistuje admin. Dvě cesty k prvnímu adminovi:

1. **Env-admin (preferováno pro prod):** když `CF_ACCESS_REQUIRED=1` a přijde validní Cloudflare Access identita shodující se s `DECKTERM_BOOTSTRAP_ADMIN_EMAIL`, vytvoří se první admin a bootstrap mód se spotřebuje.
2. **One-time token (self-hosted/local):** token v `$DECKTERM_STATE_DIR/bootstrap-token`, mód `0600`, single-use, TTL 1h.

Escape hatche (jen pro migraci/dev, tvrdě guardované proti produkci):

- `DECKTERM_LEGACY_NO_BOOTSTRAP=1` — obejde bootstrap (jen CI/test/dev; **migrace path, nezahazovat**). Hlučný warning při startu + doctor warning.
- `DECKTERM_DEV_INSECURE_LOCAL_ADMIN=1` — jen explicitní dev/local, ignoruje se v produkci / při CF Access / non-localhost bind.

### 3.3 Actor a granty (C1a)

- **Identita aktéra** se v produkci řeší **výhradně z Cloudflare Access** (`backend/services/foundation-actors.ts`): `sub` = stabilní subjekt, `email` = zobrazované jméno. Vlastní login/heslo je explicitně mimo scope.
- `backend/services/foundation-authorization.ts` — `canUseCapability()` / `authorizeTerminalSessionAccess()`, route capability registry, admin/wildcard sémantika.
- **Auth flow host-access endpointu:** vyřeš aktéra → namapuj path/resource na povolený root → vyžaduj capability grant → zapiš allow/deny audit row.

### 3.4 File/git/task gates (C2)

Sdílený `requireFileAccess()` gate v `server.ts` rozšiřuje stejnou actor/root/grant rezoluci na file API, git endpointy (přes `validateGitCwd`) a task create (`projectRoot`). Legacy path-only volání se neloguje spamem, ale zapisuje jako queryable audit-lite signál (`legacy_path_resolution`).

### 3.5 OS-level disclaimer (důležité!)

Multiuser permissions izolují přístup **na aplikační úrovni**. Všechny terminály a tmux session ale běží pod **stejným Unix uživatelem** (`deploy`). DeckTerm tedy **neposkytuje OS-level izolaci** procesů/souborů/secrets mezi uživateli. Pro tvrdou multi-tenant izolaci jsou potřeba kontejnery/VM/samostatní Unix uživatelé — to je plánováno (viz sekce 5), ale není hotové. Tenhle disclaimer je v `docs/operations-guide.md` a v onboarding/admin statusu.

---

## 4. Multisession — návrh a stav

Plný návrh: `docs/plans/2026-05-24-multisession-design.md`. Schváleno Lukášem 2026-05-24.

### 4.1 Závazná architektonická rozhodnutí

1. **tmux je implementační detail backendu.** Frontend ani autorizace nikdy neparsuje tmux session names. Identita terminálu žije v SQLite (`terminal_sessions`) přes opaque ID.
2. **tmux session names jsou opaque** — `deckterm_<instance>_<opaqueTerminalId>`, žádný email/owner/sub. (Dřív leakoval `ownerId` do `ps`/`tmux ls`.)
3. **izolovaný tmux socket** — `tmux -S $DECKTERM_STATE_DIR/tmux/<instance>.sock`, dir `0700`. Dev (4174) a prod (4173) instance se nekříží.
4. **bezpečnostní hranice je aplikační, ne OS-level** (viz 3.5).
5. **granulární autorizace** — `terminal.attach` = read-only monitoring, `terminal.write` = interaktivní vstup. Linked view není implicitně write.
6. **session recovery** — UI ukazuje active/detached session, explicitní reconnect, reconnect protokol s `lastEventId` cursorem.

### 4.2 Co je HOTOVO (C1b-01 až C1b-08, na `dev`)

- ✅ Opaque tmux session names + odstraněn owner parsing z recovery
- ✅ Izolovaný tmux socket wrapper
- ✅ `TerminalBackend` interface se dvěma impl: `raw-terminal-backend.ts` (přímý `Bun.Terminal`) a `tmux-terminal-backend.ts` (perzistence; `TMUX_BACKEND=1`, default v nasazení). tmux helpery vytaženy ze `server.ts`.
- ✅ Session catalog + reconnect flow
- ✅ `terminal.write` capability + WS `mode=read|write` (read-only attach blokuje input, audituje deny)
- ✅ `terminal_events` sekvenční log + `lastEventId` recovery cursor
- ✅ Sessions drawer v UI + mode indikátory (read-only / write / detached / reconnecting…)
- ✅ Zombie reconciliation, detached reapers (osiřelé session se zabíjejí po **8 h** neaktivity), OS isolation warnings

### 4.3 Cílový rozhodovací model (kdo smí co)

- Owner má implicitně `attach` + `write` + `manage` nad svým terminálem.
- Admin/global grant může mít wildcard.
- Non-owner s pouhým `terminal.attach` dostane **read-only** view; "take control" vyžaduje explicitní `terminal.write`.
- **Plán do budoucna:** každý aktér (dle své Cloudflare OTP identity) má vlastní dedikované session; cílem je plná kontejnerizace uživatelských profilů.

### 4.4 Persistence po reloadu

Po reloadu prohlížeče se automaticky obnovují session, které běžely předtím (frontend layout cache v `localStorage` přes `SessionRegistry`), backend to podpoří stabilní perzistencí v DB + plynulým reconnectem. Pravda o existenci a oprávnění session je **vždy server**, localStorage je jen layout cache.

### 4.5 Co ještě NENÍ (multisession backlog)

- `terminal_clients` tabulka byla v plánu jen jako volitelná — online clients se drží in-memory + audit connect/disconnect.
- Plný structured-event protokol "v2" pro všechny clienty (zatím se posílá i raw output kvůli kompatibilitě).
- Permission editor UI pro správu grantů.

---

## 5. Tasks — k čemu jsou

`backend/task-runner.ts` — **supervizovaný task runner.** Rozdíl proti "quick terminálu":

- **Quick terminal** = low-friction, otevřu shell a píšu. Zůstává.
- **Task** = strukturovaný workflow pro práci agenta/člověka s historií a výsledkem.

Co task dělá: rozjede pracovní workspace s **worker/judge terminály**, spouští **checks**, volitelně používá **git worktrees** pro izolaci. Provideři přes `DECKTERM_TASK_PROVIDERS` (`codex,claude`), max kol `DECKTERM_TASK_MAX_ROUNDS` (5). Task má registrovaný `projectRoot`, který od C2 prochází stejným file-access gate jako všechno ostatní.

> **Status sync & worktree deps (2026-05-31).** Když worker/judge terminál skončí, task se sám posune z `worker-running`/`judge-running` na `needs-user` (`taskRunner.handleTerminalExit`, napojeno přes module-level `onTerminalExit` registry v `closeAndRemoveTerminal`) — dřív visel navždy. A `createWorktree` symlinkuje `node_modules` z repo rootu do worktree, takže dep-importující checks (`bun run test:unit`) v izolovaném worktree nepadají na `Cannot find package`.

> **Follow-up úklid (2026-06-01).** Git panel: commit selhání teď surfacuje reálný důvod ("nothing to commit") — git ho píše na stdout, ne stderr, takže backend fallbackuje na stdout a `commit()` ho zobrazí inline (`#git-commit-status`) místo prázdného `alert()`; `git-error.js` zobecněn na `formatGitError`. Help: `?` už neotevírá help při psaní v inputu (`isEditableTarget`), `F1` funguje všude. Detaily a stav: `docs/plans/2026-05-29-followups-backlog.md` (#5/#7/#8).

> **Sessions drawer attach (2026-06-01).** Klik na řádek v Session Manageru uměl jen `switchTo` lokálně otevřené session; živá-ale-neotevřená session (tmux běží, ale tenhle prohlížeč ji nedrží) tiše nic. Nově čistá funkce `planSessionRowAction` (`web/session-actions.js`) rozhodne **focus / attach / open-here** z katalogu + lokální mapy a drawer renderuje status badge + kontextové akční tlačítko; attach jde přes existující `reconnectToTerminal`, open-here přes `createTerminal({cwd})`. Auto-reconnect i backend WS attach byly ověřeny jako funkční — drawer je manuální záchrana, když auto-reconnect vyčerpá pokusy. Design: `docs/plans/2026-06-01-sessions-drawer-attach-design.md`, backlog #9.

> **DB busy_timeout + dev/prod state izolace (2026-06-01).** Vytvoření terminálu občas padalo na 500 „Failed to create terminal" — `SQLITE_BUSY`: **dev (4174) i prod (4173) defaultně sdílely `~/.deckterm/deckterm.db`** a WAL DB neměla `busy_timeout`, takže souběžný zápis hned vyhodil výjimku. Fix: `openFoundationDb` nastavuje `PRAGMA busy_timeout = 5000` (souběžný zapisovatel počká); `createTerminal` surfacuje reálný backend důvod místo generické hlášky; **dev systemd unit dostal `DECKTERM_STATE_DIR=/home/deploy/.deckterm-dev`** → dev už nezapisuje do prod bezpečnostního stavu (prod zůstává `~/.deckterm`). ⚠️ **Pozn. pro budoucí session: dev foundation DB je teď `~/.deckterm-dev/deckterm.db`, ne `~/.deckterm`.** Backlog #10.

> **Follow-up k izolaci (2026-06-01).** Po splitu jela dev na fresh **nebootstrapnuté** DB → terminál se vytvořil, ale WS attach (`/ws/terminals/:id`) je gatovaný `isBootstrapComplete || isFoundationLegacyBypassEnabled`, takže vracel 403 „bootstrap required" → klient zacyklil na „Reconnecting…" (HTTP create projde, dead-check projde, ale socket se nikdy neotevře — „Expected 101"). Fix: dev unit dostal i `DECKTERM_LEGACY_NO_BOOTSTRAP=1` (ctí se jen s `DECKTERM_RUNTIME_ENV=development`, takže dev-only). **Dev unit teď drží: `DECKTERM_STATE_DIR=/home/deploy/.deckterm-dev` + `DECKTERM_LEGACY_NO_BOOTSTRAP=1` — při resetu dev DB nech obě.**

> **Reconnect klasifikace permanentního selhání (2026-06-01).** Aby se „Reconnecting… 10/10" na trvalém 403 už neopakovalo zbytečně: `ReconnectingWebSocket` na 3. pokus klasifikuje přes `web/reconnect-classify.js` (`classifyReconnectFailure` → `gone`/`blocked`/`retry`, probe `/api/terminals` + `/api/foundation/status`). `blocked` (401/403 katalog nebo terminál v katalogu + nebootstrapnutý server) → nový overlay `setup_required` (🔒 Open Setup / Retry / Close), smyčka se zastaví. Backlog #11, commit `50bc7cc`.

Záměr (z foundation rozhodnutí #18): **hybrid** — terminál pro rychlou práci, task pro strukturovanou agentní práci s auditovatelným outcome. Terminálové session můžou být buď připojené k tasku, nebo standalone.

> Pozn.: v C2 byla parkována změna defaultního providera `codex → claude` — je to _mimo_ bezpečnostní řez a čeká na samostatné rozhodnutí (model-research doporučuje držet codex jako delegátora). Default zatím zůstává `codex`.

**Co NENÍ:** native agent adaptéry (Claude/Codex/OpenCode/Hermes jako first-class) jsou zatím jen command-template profily. Plný redesign task/run/event-logu je odložený.

---

## 6. Nasazení na nový server — co jde z GitHubu a co ručně

Návod: `docs/install-dedicated-server.md`. Stručná pravda na otázku _"dotáhl by to někdo nový jen z GitHubu včetně CF?"_:

### Co jde "z GitHubu" (aplikace samotná)

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt-get install -y git tmux curl
git clone https://github.com/ussi69-dotcom/deckterm.git /home/deploy/deckterm
cd /home/deploy/deckterm
bun install --frozen-lockfile
cp .env.example .env   # a vyplnit
# systemd user service (šablona je v install docu) → enable --now
```

Aplikace samotná se rozjede z gitu bez problému. Bootstrap gate tě donutí vytvořit prvního admina (token nebo CF env-admin).

### Co ručně (Cloudflare a okolí)

**Tohle z GitHubu samo nepřijede** — vyžaduje to konfiguraci v Cloudflare Zero Trust dashboardu:

1. Vytvořit self-hosted **Access application** pro `https://deckterm.example.com`.
2. Přidat email/domain/group policy.
3. Zkopírovat **application audience tag** do `CF_ACCESS_AUD`, team name do `CF_ACCESS_TEAM_NAME`.
4. Vytvořit **Cloudflare Tunnel** a nasměrovat hostname na `http://127.0.0.1:4174`.
5. `cloudflared` nainstalovat a spustit jako službu (config šablona: `deploy/cloudflared/config.example.yml`).

To je inherentně manuální/dashboard krok — nedá se commitnout do repa (jsou to účty, tokeny, DNS).

### Publish módy (`DECKTERM_PUBLISH_MODE`)

- `cloudflare-tunnel` — tunel; enforcement na CF edge, server-side JWT validace **vypnutá**.
- `cloudflare-access` — tunel + DeckTerm si **sám validuje** Cf-Access JWT (potřebuje `CF_ACCESS_TEAM_NAME` + `CF_ACCESS_AUD`).
- `nginx` / `local` / `direct` — jiné tvary nasazení.

### Závěr

**Aplikace ano, Cloudflare ne plně automaticky.** Z GitHubu rozjedeš server jednou sérií příkazů, ale Cloudflare Zero Trust (Access policy + Tunnel) je vždy ruční dashboard setup. Neexistuje (a ani nemůže existovat) jeden skript, co ti nakonfiguruje cizí CF účet.

---

## 7. Autoconfig — co existuje a co je v plánu

### Co UŽ existuje: Setup Doctor / Setup Wizard

`backend/onboarding-doctor.ts` je nejblíž "autoconfigu", co dnes máme. Není to plně automatický bootstrap, ale **asistovaná konfigurace**:

- **Health checks** — ověří state-dir + práva, DB writability, bootstrap-token práva, přítomnost binárek (`cloudflared`/`nginx`/`tmux`), bind adresu, CF Access nastavení, trusted origins.
- **Profilově orientovaná doporučení** — vybereš publish profil (`cloudflare-tunnel`, `cloudflare-access`, `nginx`, `local`, `direct`) a doctor vygeneruje:
  - `.env` updaty,
  - **systemd snippet**, **cloudflared snippet**, **nginx snippet**, **firewall snippet**,
  - manuální kroky, co musíš dodělat (např. CF dashboard).
- **Remediace** — `applyOnboardingRemediation()` (C2) umí aplikovat fix (např. zapsat `.env` updaty) a znovu spustit doctor. Endpointy:
  - `GET /api/onboarding/doctor?profile=cloudflare-tunnel`
  - `POST /api/onboarding/apply`
  - `POST /api/onboarding/remediate`
- Dostupné i z prohlížeče: **More → Setup → Run Doctor**, plus CLI `bash scripts/doctor.sh .env`.

Takže: **doctor ti vygeneruje konfiguráky a ukáže, co dodělat ručně. Negeneruje Cloudflare účet ani sám nespustí systemd.**

### Co je v plánu (a co ne)

Z foundation rozhodnutí (#27 config hierarchy): `defaults < config file < env vars < CLI flags + config doctor`, plus "effective config printing s redakcí" — částečně se rozvíjí přes doctor. Plný "one-command bootstrap" pro nový server **není explicitně naplánovaný**; směr je spíš dotahovat setup wizard (víc remediací, víc profilů), ne psát black-box installer.

---

## 8. CI/CD a prostředí

Detail: `docs/operations-guide.md`.

### Prostředí

|        | Dev                         | Prod                                                      |
| ------ | --------------------------- | --------------------------------------------------------- |
| Cesta  | `/home/deploy/deckterm_dev` | release symlink `/home/deploy/apps/deckterm/prod/current` |
| Branch | `dev`                       | `main`                                                    |
| Port   | **4174**                    | **4173**                                                  |
| Služba | `deckterm-dev.service`      | `deckterm.service`                                        |

**Všechny testy běží proti 4174, nikdy proti prod 4173.** Prod už neběží z live checkoutu — `main` se deployuje přes GitHub Actions.

### Git flow

`feature/*` → `dev` (validace na 4174) → `main` (produkce, atomický rollout).

### Workflows

- **`ci.yml`** — joby `unit` + `smoke-e2e` na push/PR.
- **`deploy-main.yml`** — verify-and-package (testy + smoke E2E + tarball) → deploy přes SSH (gated `ENABLE_PROD_DEPLOY=1`): release dir, symlink env, install, candidate na `PROD_CANDIDATE_PORT`, health check, repoint `current`, restart služby, verify, **rollback na `previous` při selhání**.
- **`promote-dev-to-main.yml`** — vytvoří/aktualizuje promotion PR `dev → main`.

Po "push to main" vždy ověř, že workflow **Deploy Main** prošel, než prohlásíš prod za aktualizovaný. Prod ručně nedeployovat, pokud to není explicitně vyžádané.

### Testy

- `bun run test:unit` — kanonický correctness gate. Nový `*.test.ts/js` **musí** být přidán do `test:unit` v `package.json`, jinak ho CI přeskočí.
- `tsc --noEmit` na čistém HEAD **padá** (pre-existing errors) — neslouží jako gate, testy ano.
- E2E: `bun run test:e2e:smoke` / `test:e2e` / `test:all`.

---

## 9. Roadmapa / co dál (backlog)

Explicitně **odloženo** (z foundation rozhodnutí — nestaví se teď):

- Permission editor UI (správa grantů z UI)
- Secrets manager (později: 1Password/Vault/Doppler/SOPS adaptéry)
- Native agent adaptéry (zatím command-template profily)
- Plný task/run/event-log redesign
- Artifacts auto-collection
- **Docker/kontejnerová izolace** uživatelských profilů (cílový stav pro tvrdou multi-tenant izolaci)
- Transcript policy UI (modes `none`/`commands`/`full`)
- Postgres/S3 storage (dnes SQLite + filesystem)
- Stabilní veřejné REST API garance

Nejbližší logické pokračování po C2: dotáhnout multisession backlog (sekce 4.5), případně začít permission editor UI nebo kontejnerizaci podle priority.

---

## 10. Mapa klíčových souborů a dokumentů

**Kód:**

- `backend/server.ts` — ~5.3k řádků, celý HTTP/WS povrch. Seamy: `createWebApp()`, `startWebServer()`, `reconcileSessionsOnStartup()`.
- `backend/services/foundation-state.ts` — DB, migrace, granty, sessions, audit.
- `backend/services/foundation-authorization.ts` — autorizační rozhodnutí, route registry.
- `backend/services/foundation-actors.ts` — Cloudflare Access → aktér.
- `backend/services/{raw,tmux}-terminal-backend.ts` — `TerminalBackend` impl.
- `backend/task-runner.ts` — supervizovaný task runner.
- `backend/onboarding-doctor.ts` — setup wizard / autoconfig asistent.
- `backend/telemetry.ts` — agent badge klasifikace.
- `web/app.js` — ~12k řádků frontendu (TileManager, TerminalManager, ReconnectingWebSocket, SessionRegistry).

**Dokumenty:**

- `docs/plans/2026-05-12-deckterm-foundation-decisions.md` — **kořenová rozhodnutí** (C0/C1/C2 split, grant model, 35 decision-log bodů).
- `docs/plans/2026-05-13-c1a-multiuser-foundation.md` — C1a plán.
- `docs/plans/2026-05-24-multisession-design.md` — **kompletní multisession návrh** (C1b).
- `docs/plans/2026-05-29-c2-file-git-task-gates.md` — C2 plán.
- `docs/install-dedicated-server.md` — instalace na nový server.
- `docs/operations-guide.md` — prostředí, CI/CD, deploy/rollback, security model.
- `docs/product-guide.md` — produktový pohled.
- `docs/plans/2026-05-12-comparable-projects-research.md` — srovnání s konkurencí.
  </content>
  </invoke>
