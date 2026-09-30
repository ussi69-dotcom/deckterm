# Repair acceptance evidence

This folder retains sanitized results and eight manually reviewed UI component screenshots from the authorized audit repair. The full acceptance record is [the repair plan](../../plans/2026-09-05-audit-repairs.md). `verification.json` records gate outcomes, restore evidence and screenshot hashes; a running browser status is not a passing result.

The screenshots show only controlled fixture files, UI controls and the relevant root label. They exclude terminal output, raw browser DOM, host file inventories, credentials and request dumps. Desktop was 1440×960; narrow layout was 390×844. Separate tests cover touch/modal behavior. Icons, fonts and diff code were served locally with external HTTP requests blocked, and no page errors or CSP violations occurred.

These are manual visual observations, not an image-diff baseline, a physical iOS/Safari test or an assistive-technology certification. Production was not tested or changed. Full development logs are retained locally under `/tmp/deckterm-repair-*.log`; only derived results belong here.
