# Follow-ups backlog (zachyceno 2026-05-29)

> Nálezy z ruční validace dev instance při mergi C2 → main. **Žádný z nich není C2 regrese** — jsou to pre-existing product gaps. Seřazeno dle hodnoty × velikosti. Kandidát na budoucí kanban (à la Hermes).

## Task runner (nejvyšší hodnota — uživatel ho aktivně zkoušel a nefunguje end-to-end)

1. ✅ **HOTOVO (2026-05-31).** **Worker → status sync.** Status `worker-running` se nikdy sám neposune — mění se jen explicitními akcemi (`task-runner.ts:647/675/695`), není listener na exit worker terminálu/agenta. Po ukončení session task visí na `worker-running`.
   - _Fix:_ detekovat ukončení workeru (exit terminálu / tmux session gone přes telemetrii) a posunout status (→ `checks-running` nebo `needs-user`).
   - _Velikost:_ střední.
   - _Řešení:_ `taskRunner.handleTerminalExit(ownerId, terminalId)` posune `worker-running`/`judge-running` task na `needs-user` + zaloguje `worker-exited`/`judge-exited`; napojeno přes module-level `onTerminalExit` registry volaný v `closeAndRemoveTerminal` (raw i tmux backend).

2. ✅ **HOTOVO (2026-05-31).** **Worktree nemá `node_modules`.** `Run checks` v git worktree (`~/.deckterm/worktrees/...`) padá `Cannot find package 'hono'` — git worktree nekopíruje `node_modules`, takže jakýkoli dep-importující check (`test:unit`) selže. Vidět jako 11 fail testů, není to regrese kódu.
   - _Fix:_ při vytvoření worktree spustit `bun install` nebo nasymlinkovat `node_modules` z project rootu.
   - _Velikost:_ malý–střední.
   - _Řešení:_ `createWorktree` symlinkuje `node_modules` z repo rootu do worktree (`ln -s`), pokud repo má nainstalované závislosti — instantní a sdílené, bez per-task `bun install`.

3. **Model / reasoning picker + kanban (à la Hermes).** Možnost vybrat model a reasoning level (ideálně auto) per task; větší kus → vlastní kanban board nad tasky.
   - _Velikost:_ velký (samostatný projekt, chce brainstorming).

## Git panel

4. ✅ **HOTOVO (2026-05-31).** **Surfacovat git stderr** místo holého „Checkout failed". Checkout typicky selže kvůli konfliktu (větev už checked-out v jiném worktree / dirty tree); panel by měl ukázat důvod. Backend stderr už vrací (`server.ts:3509`), jde o frontend zobrazení.
   - _Velikost:_ malý.
   - _Řešení:_ nový `web/git-error.js` → `formatGitCheckoutError({error, message})` složí `error: <stderr>`; napojeno v obou checkout call-sites (`switchBranch`, `switchGitBranchFromPalette`).

5. ✅ **HOTOVO (2026-06-01).** **Tlačítka working tree / staged / commit.** Ověřeno: endpointy (`server.ts:3294–3459`) i frontend wiring (commit btn → `commit()`, per-file stage/unstage → `toggleStage()`, diff-mode taby, klávesy) byly **kompletní a funkční** — backlog tipoval „nefunguje" mylně. Reálný bug: commit bez naStageovaných změn ukázal prázdné „Commit failed:", protože git píše „nothing to commit" na **stdout**, ne stderr, a backend surfacoval jen stderr.
   - _Velikost:_ malý.
   - _Řešení:_ backend `/api/git/commit` při selhání fallbackuje na stdout (`reason = stderr || stdout`); `git-error.js` zobecněn na `formatGitError(payload, fallback)` (+ unit testy), `commit()` ho používá místo `alert()` a píše inline `#git-commit-status` (error/success). Paralela k surfacingu checkout stderr (9860441).

6. **VSCode-like file/git panel** — plnohodnotné otevírání/editace souborů (teď file explorer jen browse + download, vytváří jen složky), bohatší git workflow. Větší product směr.
   - _Velikost:_ velký.

## Drobnosti

7. ✅ **HOTOVO (2026-06-01).** **`?` keybinding** zapínal help i uvnitř task/textových inputů — global handler (`app.js:~7413`) nerespektoval focus.
   - _Velikost:_ malý.
   - _Řešení:_ nový top-level helper `isEditableTarget(target)` (INPUT/TEXTAREA/SELECT/contenteditable); `?` otevře help jen mimo editovatelný focus (`F1` zůstává všude). Bonus: xterm skrytý textarea je „editable", takže `?` v terminálu jde do shellu. Ověřeno Playwrightem.

8. ✅ **HOTOVO (2026-06-01).** **Test leak do živého state diru.** `~/.deckterm/tasks/anonymous/` obsahoval 5 `api-task-*` z 2. 5. (owner `anonymous` = před tunnel-actor změnou e92a5db; dnešní default actor je `tunnel`). Příčina leaku: `DECKTERM_STATE_DIR` je module-const zmražený při importu `server.ts`, takže task runner mohl psát do živého diru, když const zamrzl dřív, než test nastavil temp.
   - _Velikost:_ malý.
   - _Řešení:_ (a) smazány stale `api-task-*` (zachován reálný `novy-task-16b6b34d`); (b) `createWebApp` resolvuje task-runner stateDir **za běhu** přes nový `resolveStateDir()` (prod beze změny — env je při startu stabilní), takže task workspace vždy následuje aktuální `DECKTERM_STATE_DIR`; (c) regresní guard v `task-api.test.ts` ověřuje, že task přistál pod temp dir (sken napříč owner segmenty). Celý `test:unit` zelený (144), 0 leaků.

## UX nálezy (po #1–#8)

9. ✅ **HOTOVO (2026-06-01).** **Sessions drawer nepřipojí odpojené session.** Klik na řádek volal `switchTo(id)`, který má guard `if (!this.terminals.has(id)) return` — takže pro session živou na serveru (tmux běží), ale neotevřenou v tomhle prohlížeči, klik tiše nic neudělal. Řádek navíc nevypadal jako tlačítko. Auto-reconnect i backend WS attach byly ověřeny jako funkční — drawer je manuální záchrana, když auto-reconnect vyčerpá pokusy.
   - _Velikost:_ malý–střední. Design: `docs/plans/2026-06-01-sessions-drawer-attach-design.md`.
   - _Řešení:_ čistá funkce `planSessionRowAction` (nový `web/session-actions.js`, 7 unit testů) rozhodne focus/attach/open-here z katalogu + lokální mapy; `refreshSessionsPanel` renderuje status badge + kontextové akční tlačítko, `handleSessionRowActivate` dispatchuje (`switchTo` / `reconnectToTerminal`→`switchTo` / `createTerminal({cwd})`), klávesová obsluha (Enter/Space) pro `role=button` řádky; `createTerminal` rozšířen o `options.cwd`. Playwright `sessions-attach.spec.ts` + živé ověření attachu na 4174. `test:unit` 151 zelený.

10. ✅ **HOTOVO (2026-06-01).** **„Open here" (a obecně vytvoření terminálu) občas vracelo 500 „Failed to create terminal".** Příčina nebyla v „Open here" — byl to `SQLITE_BUSY` ve foundation DB: **dev (4174) i prod (4173) defaultně píšou do stejné `~/.deckterm/deckterm.db`** (ani jeden nenastavoval `DECKTERM_STATE_DIR`), DB je ve WAL ale bez `busy_timeout`, takže souběžný zápis (`recordTerminalSession`/`writeAuditEvent`) hned hodil výjimku → 500. Frontend navíc zahazoval reálný důvod (zdvojené „Failed to create terminal: Failed to create terminal").
    - _Velikost:_ malý (kód) + config.
    - _Řešení:_ (a) `openFoundationDb` přidává `PRAGMA busy_timeout = 5000` — souběžný zapisovatel počká na zámek místo pádu (zápisy jsou sub-ms, 5 s strop clash serializuje); asertováno v `foundation-c0.test.ts`. (b) `createTerminal` parsuje backend tělo a hodí reálný `error`/`message` místo generické hlášky. (c) **Izolace:** dev systemd unit dostal `DECKTERM_STATE_DIR=/home/deploy/.deckterm-dev`, takže dev už nepíše do prod bezpečnostního stavu (prod nedotčen, zůstává `~/.deckterm`; busy_timeout zůstává jako pojistka). Ověřeno živě: 3× `POST /api/terminals` → 200 s běžícím prodem, 0× `SQLITE_BUSY`. `test:unit` 151 zelený.
    - _Navazující fix (config):_ izolovaná dev DB je nebootstrapnutá → WS attach (`/ws/terminals/:id`) gatovaný `isBootstrapComplete || isFoundationLegacyBypassEnabled` vracel 403 → klient zacyklil na „Reconnecting…". Dev unit dostal i `DECKTERM_LEGACY_NO_BOOTSTRAP=1` (dev-only, ctí se jen s `DECKTERM_RUNTIME_ENV=development`). Commit `94b20a9` (docs).

11. ✅ **HOTOVO (2026-06-01).** **Permanentní selhání WS attach se retried jako přechodné.** Když WS upgrade selže na 403 (server nebootstrapnutý / přístup zamčený), prohlížeč to vidí jen jako „Expected 101", takže to vypadalo stejně jako výpadek sítě → klient ukázal „Reconnecting… 10/10" bez užitečné informace.
    - _Velikost:_ malý.
    - _Řešení:_ nový `web/reconnect-classify.js` → čistá `classifyReconnectFailure({catalogOk, catalogStatus, terminalInCatalog, bootstrapped})` → `gone`/`blocked`/`retry` (6 unit testů); 401/403 katalog nebo „terminál v katalogu, ale server nebootstrapnutý" = `blocked`, nejednoznačné = `retry`. `ReconnectingWebSocket` na 3. pokus volá `classifyReconnect` (probe `/api/terminals` + `/api/foundation/status`) a `blocked` mapuje na nový overlay `setup_required` (🔒 + Open Setup / Retry / Close), který smyčku zastaví a tab označí disconnected. `test:unit` 157 zelený; transient reconnect + sessions specy dál procházejí. Commit `50bc7cc`.
