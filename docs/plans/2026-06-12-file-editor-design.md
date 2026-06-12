# In-browser file editor (backlog #6 MVP) — design

> 2026-06-12. Schváleno v nočním plánu: CodeMirror 6 vendored, save za requireFileAccess gate.

## Cíl

Z file exploreru jde soubor otevřít a editovat přímo v prohlížeči (✎ akce na řádku),
se syntax highlightingem, Ctrl+S save a ochranou proti ztracené souběžné editaci.
MVP, ne IDE: jeden soubor naráz, modal, žádné taby/diff/LSP.

## Backend

`GET /api/files/content?path=` → `{path, content, mtimeMs, size}`; limity: 2 MB (413),
binární detekce null-bytem (415). `PUT /api/files/content` `{path, content, expectedMtimeMs}`
→ atomický zápis (tmp + rename), `expectedMtimeMs` nesouhlasí ⇒ **409 mtime_conflict**
(optimistic concurrency — dva editory si nepřepíšou změny). Oba endpointy za
`resolveAllowedPath` + `requireFileAccess` (strukturované 403), save píše audit row
`file.write/editor_save`. Testy: `foundation-c2.test.ts` C2-2b/C2-2c.

## Vendoring (frontend bez build stepu)

CodeMirror 6 je modulární — bundle se předgeneruje commitnutým skriptem:
`bun build scripts/build-codemirror-vendor.js --outfile web/vendor/codemirror.js --format=esm --minify`
(~660 kB; basicSetup, jazyky js/ts/json/md/py/html/css, oneDark). Balíčky jsou
devDependencies; runtime deps se nemění. Frontend ho načítá lazy přes dynamic
`import()` až při prvním otevření editoru — žádný dopad na startup.

## Frontend

`web/file-editor.js`: čisté `detectEditorLanguage(path)` + `isProbablyEditable(path)`
(unit testy) a třída `FileEditor` (modal, dirty indikátor přes updateListener,
Ctrl+S save / Esc close s confirm při dirty, 409 → vysvětlení bez zahození bufferu,
403 → `describeAccessDenied`). File explorer dostal `onOpenFile` callback (✎ tlačítko),
app.js ho napojuje na `FileEditor.open`.

## Mimo scope (další iterace)

Více souborů/taby, autosave, diff proti gitu, vytvoření nového souboru z exploreru,
in-editor search (CM6 basicSetup už má Ctrl+F), mobile UX ladění.
