import { expect, test } from "bun:test";
import { buildBashIntegrationRcContents } from "./shell-integration";

test("DeckTerm launches Codex inline so terminal scrollback is preserved", () => {
  const rc = buildBashIntegrationRcContents();

  expect(rc).toContain(
    'codex() { __deckterm_run_agent codex --no-alt-screen "$@"; }',
  );
});

test("DeckTerm leaves the Claude launch mode unchanged", () => {
  const rc = buildBashIntegrationRcContents();

  expect(rc).toContain('claude() { __deckterm_run_agent claude "$@"; }');
  expect(rc).not.toContain("claude --no-alt-screen");
});
