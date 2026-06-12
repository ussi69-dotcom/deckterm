# Task board (kanban MVP) + provider default — design

> 2026-06-12, backlog #3 první řez. Schváleno v nočním plánu (2026-06-10 rozhodnutí).

## Cíl

Task panel umí vedle seznamu i **board pohled** — sloupce podle stavu, karty = tasky.
Read-only MVP: žádný drag-and-drop, karta kliknutím vybere task (stejný detail jako v listu).
Stavové přechody dál dělají existující akce v detailu (Start worker, Run checks, …).

## Sloupce (fixní pořadí, mapování stavů)

| Sloupec   | Stavy                                               |
| --------- | --------------------------------------------------- |
| Ready     | `draft`, `ready`, `paused`                          |
| Running   | `worker-running`, `checks-running`, `judge-running` |
| Needs you | `needs-user`, `needs-judge`                         |
| Done      | `complete`                                          |
| Failed    | `failed`                                            |

Prázdné sloupce se vykreslují (stabilní layout), karta ukazuje title + konkrétní stav +
worker/judge provider. Logika mapování je čistá funkce `groupTasksForBoard(tasks)`
(`web/task-board.js`, unit-testy v `test:unit`).

## UI

- Toggle **List/Board** v hlavičce task panelu (`#task-view-toggle`), volba se drží
  v `localStorage` (`deckterm-task-view`).
- Board nahrazuje `#task-list` (detail pod ním zůstává beze změny).
- Mobil: sloupce horizontálně scrollovatelné.

## Provider default

`createTask` fallback `codex` → `claude` (worker i judge; explicitní volba má přednost),
form selecty mají Claude první a selected. Rozhodnutí 2026-06-10 — codex bez kreditů.
Kryto testem `createTask defaults both providers to claude when unspecified`.

## Mimo scope (další iterace)

Drag-and-drop přechody, model/reasoning picker (jen provider zatím — task-runner
nemá model parametr), WS push (board se obnovuje přes existující refreshTasks +
15s task-signals poll), filtrace/archiv done tasků.
