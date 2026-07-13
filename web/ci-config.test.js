import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readText = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

test("promote workflow exists for dev to main handoff", () => {
  const promoteWorkflowPath = fileURLToPath(
    new URL("../.github/workflows/promote-dev-to-main.yml", import.meta.url),
  );

  expect(existsSync(promoteWorkflowPath)).toBe(true);
});

test("deploy workflow stays gated behind explicit production enable flag", () => {
  const deployWorkflow = readText("../.github/workflows/deploy-main.yml");

  expect(deployWorkflow).toContain("ENABLE_PROD_DEPLOY");
  expect(deployWorkflow).toContain("Production deploy is currently disabled.");
  expect(deployWorkflow).toContain("deckterm.service");
});

test("dependabot targets the dev integration branch", () => {
  const dependabotConfig = readText("../.github/dependabot.yml");

  expect(dependabotConfig).toContain('target-branch: "dev"');
});

test("CI and deploy smoke runs use explicit temporary bootstrap compatibility bypass", () => {
  const ciWorkflow = readText("../.github/workflows/ci.yml");
  const deployWorkflow = readText("../.github/workflows/deploy-main.yml");

  expect(ciWorkflow).toContain("DECKTERM_LEGACY_NO_BOOTSTRAP=1");
  expect(deployWorkflow).toContain("DECKTERM_LEGACY_NO_BOOTSTRAP=1");
});

test("CI smoke server explicitly enables the development-only E2E namespace", () => {
  const ciWorkflow = readText("../.github/workflows/ci.yml");

  expect(ciWorkflow).toContain("DECKTERM_RUNTIME_ENV=development");
});

test("deploy scripts target user-level systemd services", () => {
  const deployScript = readText("../scripts/deploy_release.sh");
  const rollbackScript = readText("../scripts/rollback_release.sh");

  expect(deployScript).toContain("systemctl --user restart");
  expect(rollbackScript).toContain("systemctl --user restart");
});
