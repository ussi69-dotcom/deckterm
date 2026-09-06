import { resolve } from "node:path";

/** Every non-privileged unit/contract test must have an explicit CI invocation.
 * Separate Bun processes in test:unit preserve foundation singleton isolation. */
export async function uncoveredTests(
  root = resolve(import.meta.dir, ".."),
): Promise<string[]> {
  const pkg = await Bun.file(resolve(root, "package.json")).json();
  const commands = [pkg.scripts["test:unit"], pkg.scripts["test:push"]].join(
    " ",
  );
  const mentioned = new Set(
    commands.match(/(?:backend|web|scripts)\/[^\s]+\.test\.(?:ts|js)/g) || [],
  );
  const uncovered: string[] = [];
  for (const directory of ["backend", "web", "scripts"]) {
    for await (const file of new Bun.Glob("**/*.test.{ts,js}").scan({
      cwd: resolve(root, directory),
    })) {
      // Explicitly privileged Alice/Bob installation test, with its own harness.
      if (directory === "scripts" && file.startsWith("isolation-e2e/"))
        continue;
      const path = `${directory}/${file}`;
      if (!mentioned.has(path)) uncovered.push(path);
    }
  }
  return uncovered.sort();
}

if (import.meta.main) {
  const missing = await uncoveredTests();
  if (missing.length) {
    console.error(`Tests missing from the CI census:\n${missing.join("\n")}`);
    process.exit(1);
  }
  console.log("All unit and contract tests have an explicit CI invocation.");
}
