# Runbook: prod přepnutí `cloudflare-tunnel` → `cloudflare-access` (+ tmux ops změny)

> Stav: **provedeno 2026-06-12 večer** (team `waginy`, AUD pinned, admin `ussi69@gmail.com`).
> Postmortem: premisa „prod DB nemá admina" (krok 0) byla mylná — DB obsahovala legacy `anonymous`
> admin řádek z C0 éry (2026-05-12), takže `ensureBootstrapToken` hlásil bootstrap jako hotový,
> Setup se nenabídl a CF identita neměla žádné granty (`terminal.create` → deny `missing_capability`).
> Oprava: jednorázová datová remediace v prod DB (user + auth identita + default granty, audit
> `env_admin_manual_remediation`) + fix v `foundation-state.ts` — legacy `anonymous` řádek se
> nepočítá jako dokončený bootstrap, pokud k němu neexistuje `bootstrap.admin.create` audit řádek
> (test ve `foundation-c1.test.ts`).
> Proč: v `cloudflare-tunnel` módu server plně věří edge — bootstrap i granty se obcházejí a všichni
> příchozí jsou jeden aktér `tunnel`. V `cloudflare-access` módu si DeckTerm **sám validuje**
> `Cf-Access-Jwt-Assertion` (team + AUD), každý uživatel je reálná identita a foundation gates
> (bootstrap, granty, audit per-user) jsou aktivní. Obrana do hloubky: kompromitace/chyba CF policy
> už neznamená volný shell.

## 0. Co se tím změní (přečíst celé, je tam jeden zádrhel)

|                     | tunnel (teď)            | cloudflare-access (cíl)                                   |
| ------------------- | ----------------------- | --------------------------------------------------------- |
| Validace JWT        | jen na CF edge          | edge **+ server** (`CF_ACCESS_TEAM_NAME`/`CF_ACCESS_AUD`) |
| Aktér               | jeden sdílený `tunnel`  | per-user (CF `sub`/email)                                 |
| Bootstrap gate      | obcházen (edge-trusted) | **aktivní**                                               |
| Granty/capabilities | obcházeny               | **aktivní**                                               |
| Audit               | jeden aktér             | reálné identity                                           |

**Zádrhel:** prod `~/.deckterm/deckterm.db` dnes nemá žádného admina (gate byl vždy obcházen).
Po přepnutí módu se gate aktivuje → **bez bootstrapu se nikdo nedostane k terminálům**.
Proto je v sekvenci `DECKTERM_BOOTSTRAP_ADMIN_EMAIL` — první CF-ověřený požadavek s tímhle
e-mailem projde Setup flow a vytvoří admina (env-admin path, `POST /api/bootstrap`, token: null).

## 1. Pre-flight (CF Zero Trust dashboard, ~5 min)

1. Zero Trust → Access → Applications → aplikace pro `deckterm.learnai.cz`.
2. Zkopíruj **Application Audience (AUD) tag** → `CF_ACCESS_AUD`.
3. Team name = subdoména v `https://<team>.cloudflareaccess.com` → `CF_ACCESS_TEAM_NAME`.
4. Ověř, že Access policy povoluje tvůj e-mail (ussi@seznam.cz / ussi69@gmail.com — ten, kterým se reálně přihlašuješ; musí se shodovat s `DECKTERM_BOOTSTRAP_ADMIN_EMAIL` níže).

## 2. Env diff na produ (release `.env`, tj. soubor, na který ukazuje `current/.env`)

```diff
-DECKTERM_PUBLISH_MODE=cloudflare-tunnel
+DECKTERM_PUBLISH_MODE=cloudflare-access
-CF_ACCESS_REQUIRED=0
+CF_ACCESS_REQUIRED=1
+CF_ACCESS_TEAM_NAME=<team z kroku 1>
+CF_ACCESS_AUD=<aud z kroku 1>
+DECKTERM_BOOTSTRAP_ADMIN_EMAIL=<tvůj CF login e-mail>
```

Pozn.: `TRUSTED_ORIGINS=https://deckterm.learnai.cz` musí zůstat.

## 3. Sekvence přepnutí

```bash
# 1) edituj prod .env dle kroku 2
systemctl --user restart deckterm.service
# 2) zdraví procesu (lokálně projde bez JWT jen /api/health — je v allowlistu? pokud 401, je to OK known-fact, pokračuj přes prohlížeč)
curl -s http://localhost:4173/api/health   # 200 i v access módu — /api/health je
# záměrně vyjmutý z JWT validace (deploy pipeline ho gatuje přes 127.0.0.1;
# origin binduje loopback, takže to nic neexponuje — backend/health-allowlist.test.ts)
# 3) v prohlížeči otevři https://deckterm.learnai.cz (projdeš CF login)
#    → Setup obrazovka tě provede bootstrapem (env-admin: žádný token, jen shoda e-mailu)
# 4) po bootstrapu ověř GATED akci (ne jen health!): vytvoř terminál, napiš příkaz,
#    otevři file explorer. Per memory: zelené health ≠ funkční prod.
```

## 4. Ověření, že server skutečně validuje (důležité)

```bash
# přímý požadavek na origin BEZ JWT musí dostat 401 (dřív v tunnel módu prošel):
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4173/api/terminals   # očekávej 401
```

V audit logu (`~/.deckterm/deckterm.db`, tabulka `audit_events`) se objeví reálné e-maily místo `tunnel`.

## 5. Rollback (2 min)

Vrať env diff (mode `cloudflare-tunnel`, `CF_ACCESS_REQUIRED=0`, ostatní řádky můžou zůstat —
v tunnel módu se nepoužijí) a `systemctl --user restart deckterm.service`. Vytvořený admin v DB
nevadí, v tunnel módu se gate stejně obchází.

## 6. Související prod ops změny z 2026-06-12 (aplikuj při stejné údržbě)

Tyto dvě věci jdou s nočními commity na `dev` a týkají se prodů při příští promotion do `main`:

1. **`KillMode=process` do `deckterm.service`** (`~/.config/systemd/user/deckterm.service`,
   pak `systemctl --user daemon-reload`). Bez toho každý restart služby zabije tmux server
   (child bunu v cgroupě) a s ním všechny "perzistentní" sessions. Dev unit už to má,
   šablona v `docs/install-dedicated-server.md` taky.
2. **Migrace tmux socketu** (commit `2618203`): socket se přesouvá z
   `/tmp/deckterm/deckterm_deckterm.sock` (sdílený dev+prod!) na
   `$DECKTERM_STATE_DIR/tmux/deckterm_deckterm.sock`. **Jednorázový dopad:** první start prodů
   s novým kódem označí staré sessions za zombie a ukončí je — naplánuj promotion na moment,
   kdy na produ nevisí nic důležitého.

## 7. Co bylo ověřeno na dev (2026-06-12)

- Doctor profil `cloudflare-access` na 4174: všechny checky OK (cloudflared installed,
  port bound localhost, trusted origins set). Plná JWT validace se na dev bez reálných
  CF secrets ověřit nedá — unit testy `cloudflare-access-guards.test.ts` pokrývají guard logiku.
- Bootstrap env-admin path je krytý `foundation-bootstrap.test.ts` (token path) a
  `foundation-state.ts` (env-admin mód, `expectedEmail`).
- tmux socket izolace + KillMode=process ověřeny živě na dev: session přežila restart služby,
  klient se sám reattachnul včetně obnovy scrollbacku.
