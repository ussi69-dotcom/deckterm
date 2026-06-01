# Sessions drawer — attach / open-here (design)

> Datum: 2026-06-01 · Větev: `dev` · Souvisí: follow-ups backlog (mimo původní #1–#8, nový UX nález)
> **Stav: ✅ implementováno (2026-06-01).** `web/session-actions.js` (+ 7 unit testů),
> `app.js` (`createTerminal` cwd override, `refreshSessionsPanel` render, `handleSessionRowActivate`
> dispatch + klávesová obsluha), `styles.css` `.session-row`, `index.html` script + cache bump.
> Playwright `tests/sessions-attach.spec.ts` (focus + planner attach) zelený; živě na 4174
> ověřeno, že klik na živou-ale-neotevřenou session reálně připojí tab (`reconnectToTerminal`).

## Problém

Session Manager (drawer, C1b-07 `bb256e0`) listuje serverový katalog sessions
(`GET /api/terminals`), ale kliknutí na řádek volá `switchTo(id)`, který má hned
na začátku guard:

```js
switchTo(id) {
  if (!this.terminals.has(id)) return;  // ← tiše skončí
  ...
}
```

Takže klik na session, kterou **tenhle prohlížeč nemá lokálně otevřenou** (ale je
živá na serveru — tmux běží), neudělá nic. Drawer má být záchranná/navigační
cesta, ale pro odpojené session je mrtvý. Uživatel navíc nevěděl, že řádek je
tlačítko (chybí affordance).

### Co bylo ověřeno (a NENÍ v rozsahu)

- **Auto-reconnect funguje.** `ReconnectingWebSocket` (max 10 pokusů, exp.
  backoff), po 3 pokusech katalog-check → `dead`, po 10 → overlay
  „Connection lost / Retry". „Reconnecting 7/10" na screenshotu byl **transient**
  způsobený restarty dev serveru, ne standing bug.
- **Backend WS attach funguje.** On-demand `restoreRecordedTmuxSession` obnoví
  živou tmux session po restartu serveru — ověřeno živým WS testem proti
  `037d398b` (owner `tunnel`): otevřelo se, přišel `replay-start` + PTY buffer.
- **Owner-match sedí.** Session vlastní `ussi69@gmail.com`; přístup přes tunnel
  nese `Cf-Access-Authenticated-User-Email` → stejný actor → attach povolen.

Drawer attach je tedy **manuální záchrana** pro případ, kdy auto-reconnect
vyčerpá pokusy.

## Chování

Stav každého řádku se odvodí z katalogu + lokální mapy `this.terminals`:

| Stav session     | Podmínka                                             | Akce kliknutí                                                       | Label         |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| Otevřená lokálně | `this.terminals.has(id)`                             | `switchTo(id)`                                                      | **Focus**     |
| Živá, neotevřená | `status !== "inactive" && sessionStatus !== "ended"` | `reconnectToTerminal(id, cwd, savedSession, opts)` → `switchTo(id)` | **Attach**    |
| Ended / inactive | jinak                                                | `createTerminal(false, { cwd })` (nový terminál v cwd)              | **Open here** |

Po úspěšné akci se drawer zavře. Reconnectabilita používá **stejnou podmínku
jako bootstrap** (`checkExistingTerminals`: `sessionStatus !== "ended" &&
status !== "inactive"`), aby drawer a auto-reconnect rozhodovaly konzistentně.

## Architektura

### Čistá rozhodovací funkce (testovatelná bez DOM)

Nový `web/session-actions.js` ve stylu `git-error.js` / `bootstrap-routing.js`:

```js
planSessionRowAction(session, { isLocallyOpen });
// → { kind: "focus" | "attach" | "open-here", label, statusClass }
```

Nese veškerou rozhodovací logiku. `refreshSessionsPanel()` ji volá per řádek pro
render, klik-handler pro dispatch. Export jako global (script tag) + CommonJS
(test), stejně jako `git-error.js`.

### Frontend wiring (`app.js`)

- **`createTerminal`** rozšířen o `options.cwd` (opt-in override):
  `const cwd = cwdOverride || this.getCurrentDirectoryValue() || undefined;`
  Stávající call-sites beze změny.
- **`refreshSessionsPanel()`** — render karty: status badge (`● active` zelená /
  `○ ended` šedá), `id.slice(0,8)`, cwd, meta (`status · mode · tmux`), vpravo
  akční tlačítko s labelem z `planSessionRowAction`. Karta nese `data-session-id`
  (klik = zkratka), tlačítko `data-session-action`. Katalog se uloží do
  `this._sessionCatalog`, aby klik-handler měl cwd/flags.
- **Klik dispatch** (`setupSessionsPanel`):
  ```js
  const s = this._sessionCatalog.find((x) => x.id === id);
  const action = planSessionRowAction(s, {
    isLocallyOpen: this.terminals.has(id),
  });
  switch (action.kind) {
    case "focus":
      this.switchTo(id);
      break;
    case "attach":
      await this.reconnectToTerminal(id, s.cwd, this.sessionRegistry.get(id), {
        backendMode: s.backendMode || null,
        supportsLinkedView: Boolean(s.supportsLinkedView),
      });
      this.switchTo(id);
      break;
    case "open-here":
      await this.createTerminal(false, { cwd: s.cwd });
      break;
  }
  this.closeSessionsPanel();
  ```

### Chyby

Žádná nová error cesta. `reconnectToTerminal` vytvoří tab +
`ReconnectingWebSocket`, takže selhání (404/403) spadne do existujícího overlaye
(„Connection lost / Retry", „Terminal no longer exists / New Terminal").

### CSS (`styles.css`)

`.session-row` hover/pointer, `.session-badge.active`/`.ended` (zelená/šedá
tečka), `.session-row-action` tlačítko vpravo přes flex. Bump cache verzí
(`app.js`, `session-actions.js`, `styles.css`) v `index.html`.

## Testy

- **Unit** (`web/session-actions.test.js`, přidat do `test:unit`): pokrytí
  `planSessionRowAction` — focus / attach / open-here, `inactive`, `ended`,
  chybějící status (bezpečný default = živá).
- **Playwright** (`tests/sessions-attach.spec.ts`): vytvořit terminál → drawer →
  ověřit badge + akční tlačítko + label; klik na lokálně otevřenou session zavře
  drawer a zůstane na tabu.
- **Živě na 4174**: ručně projít focus / attach / open-here.

## Soubory

- `web/session-actions.js` (nový) + `web/session-actions.test.js` (nový)
- `web/app.js` — `createTerminal` cwd, `refreshSessionsPanel` render, klik dispatch
- `web/styles.css` — styly řádku
- `web/index.html` — script tag pro `session-actions.js` + cache bump
- `package.json` — `session-actions.test.js` do `test:unit`
- `tests/sessions-attach.spec.ts` (nový)

## Mimo rozsah

Auto-reconnect/overlay, backend WS attach/`restoreRecordedTmuxSession`,
cold-start 500 (samostatný nález).
