import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const assetsRoot = resolve(repositoryRoot, "web/assets");

const NERD_FONTS_TAG = "v3.4.0";
const NERD_FONTS_COMMIT = "fa7b859994228a9c8759f99c55a8d31ee92a1b5e";

type Source = {
  path: string;
  sha256: string;
  transform?: string;
};

type PlannedFile = {
  path: string;
  content: Buffer;
  source: Source;
};

function sha256(content: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function readRepositoryFile(path: string): Buffer {
  return readFileSync(resolve(repositoryRoot, path));
}

function packageFile(packageName: string, path: string): PlannedFile {
  const sourcePath = `node_modules/${packageName}/${path}`;
  const content = readRepositoryFile(sourcePath);
  return {
    path: "",
    content,
    source: { path: sourcePath, sha256: sha256(content) },
  };
}

function assertPinnedDependency(packageName: string, version: string): void {
  const packageJson = JSON.parse(readRepositoryFile("package.json").toString());
  const declaredVersion = packageJson.devDependencies?.[packageName];
  if (declaredVersion !== version) {
    throw new Error(
      `${packageName} must be pinned to ${version} in devDependencies (found ${declaredVersion ?? "none"}).`,
    );
  }

  const installedPackage = JSON.parse(
    readRepositoryFile(`node_modules/${packageName}/package.json`).toString(),
  );
  if (installedPackage.version !== version) {
    throw new Error(
      `${packageName} in node_modules must be ${version} (found ${installedPackage.version ?? "none"}).`,
    );
  }
}

function copiedPackageFile(
  packageName: string,
  version: string,
  sourcePath: string,
  targetPath: string,
): PlannedFile {
  assertPinnedDependency(packageName, version);
  const file = packageFile(packageName, sourcePath);
  return { ...file, path: targetPath };
}

function jetBrainsFontFiles(): PlannedFile[] {
  const packageName = "@fontsource/jetbrains-mono";
  const version = "5.0.0";
  assertPinnedDependency(packageName, version);

  const css = packageFile(packageName, "400.css");
  const localizedCss = Buffer.from(
    css.content
      .toString()
      .replaceAll("url(./files/", "url(./jetbrains-mono-5.0.0-files/"),
  );
  const filenames = [
    ...css.content.toString().matchAll(/\.\/files\/([^')]+)/g),
  ].map(([, filename]) => filename);
  const uniqueFilenames = [...new Set(filenames)].sort();
  if (uniqueFilenames.length === 0) {
    throw new Error("JetBrains Mono 400.css did not reference any font files.");
  }

  return [
    {
      path: "jetbrains-mono-5.0.0-400.css",
      content: localizedCss,
      source: css.source,
    },
    ...uniqueFilenames.map((filename) => {
      const font = packageFile(packageName, `files/${filename}`);
      return {
        ...font,
        path: `jetbrains-mono-5.0.0-files/${filename}`,
      };
    }),
  ];
}

function committedNerdFontFiles(): PlannedFile[] {
  const sources = [
    {
      targetPath: "SymbolsNerdFontMono-Regular-v3.4.0.ttf",
      sourceUrl:
        "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf",
      sha256:
        "f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60",
    },
    {
      targetPath: "licenses/nerd-fonts-v3.4.0-LICENSE",
      sourceUrl:
        "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/NerdFontsSymbolsOnly/LICENSE",
      sha256:
        "84a7a98c82140fb12c37fe42b93805baa16024cb3e5acc599b7ffe612c55d847",
    },
  ];

  const files = sources.map(
    ({ targetPath, sourceUrl, sha256: expectedHash }) => {
      const target = resolve(assetsRoot, targetPath);
      if (!existsSync(target)) {
        throw new Error(
          `Missing committed Nerd Fonts source ${targetPath}; restore it from ${sourceUrl}.`,
        );
      }
      const content = readFileSync(target);
      const actualHash = sha256(content);
      if (actualHash !== expectedHash) {
        throw new Error(
          `Committed Nerd Fonts source ${targetPath} has SHA-256 ${actualHash}; expected ${expectedHash}.`,
        );
      }
      return {
        path: targetPath,
        content,
        source: { path: sourceUrl, sha256: expectedHash },
      };
    },
  );

  const nerdCss = Buffer.from(
    `@font-face {\n  font-family: "Symbols Nerd Font";\n  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n  src: url("./SymbolsNerdFontMono-Regular-v3.4.0.ttf") format("truetype");\n}\n`,
  );
  files.push({
    path: "nerd-fonts-v3.4.0.css",
    content: nerdCss,
    source: {
      path: `generated from Nerd Fonts ${NERD_FONTS_TAG} (${NERD_FONTS_COMMIT})`,
      sha256: sha256(nerdCss),
    },
  });
  return files;
}

function withoutSourceMap(file: PlannedFile): PlannedFile {
  return {
    ...file,
    content: Buffer.from(
      file.content.toString().replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, ""),
    ),
    source: {
      ...file.source,
      transform: "Remove development-only sourceMappingURL trailer",
    },
  };
}

function plannedFiles(): PlannedFile[] {
  const files = [
    withoutSourceMap(
      copiedPackageFile(
        "lucide",
        "1.41.0",
        "dist/umd/lucide.min.js",
        "lucide-1.41.0.min.js",
      ),
    ),
    copiedPackageFile(
      "diff2html",
      "3.4.56",
      "bundles/js/diff2html.min.js",
      "diff2html-3.4.56.min.js",
    ),
    copiedPackageFile(
      "diff2html",
      "3.4.56",
      "bundles/css/diff2html.min.css",
      "diff2html-3.4.56.min.css",
    ),
    copiedPackageFile("lucide", "1.41.0", "LICENSE", "licenses/lucide-ISC.txt"),
    copiedPackageFile(
      "diff2html",
      "3.4.56",
      "LICENSE.md",
      "licenses/diff2html-MIT.txt",
    ),
    copiedPackageFile(
      "@fontsource/jetbrains-mono",
      "5.0.0",
      "LICENSE",
      "licenses/jetbrains-mono-OFL-1.1.txt",
    ),
    ...jetBrainsFontFiles(),
    ...committedNerdFontFiles(),
  ];

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path))
      throw new Error(`Duplicate generated asset ${file.path}.`);
    seen.add(file.path);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function manifestFor(files: PlannedFile[]): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedBy: "scripts/build-assets.ts",
        dependencies: {
          "@fontsource/jetbrains-mono": {
            version: "5.0.0",
            license: "SIL OFL 1.1",
          },
          diff2html: { version: "3.4.56", license: "MIT" },
          lucide: {
            version: "1.41.0",
            license: "ISC and MIT for listed Feather-derived icons",
          },
        },
        nerdFonts: {
          repository: "https://github.com/ryanoasis/nerd-fonts",
          tag: NERD_FONTS_TAG,
          commit: NERD_FONTS_COMMIT,
          license: "MIT",
        },
        files: files.map((file) => ({
          path: file.path,
          bytes: file.content.byteLength,
          sha256: sha256(file.content),
          source: file.source,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

function expectedFiles(): PlannedFile[] {
  const files = plannedFiles();
  files.push({
    path: "manifest.json",
    content: manifestFor(files),
    source: {
      path: "generated by scripts/build-assets.ts",
      sha256: "not-applicable",
    },
  });
  return files;
}

function filePaths(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) return filePaths(entryPath);
    if (entry.isFile()) return [relative(assetsRoot, entryPath)];
    return [];
  });
}

export function verifyAssets(): string[] {
  try {
    const files = expectedFiles();
    const expected = new Map(files.map((file) => [file.path, file.content]));
    const errors: string[] = [];
    for (const [path, content] of expected) {
      const target = resolve(assetsRoot, path);
      if (!existsSync(target)) {
        errors.push(`Missing asset ${path}.`);
      } else if (!readFileSync(target).equals(content)) {
        errors.push(`Asset bytes differ for ${path}.`);
      }
    }
    for (const path of filePaths(assetsRoot)) {
      if (!expected.has(path)) errors.push(`Unexpected asset ${path}.`);
    }
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function buildAssets(): void {
  for (const file of expectedFiles()) {
    const target = resolve(assetsRoot, file.path);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target) || !readFileSync(target).equals(file.content)) {
      writeFileSync(target, file.content);
    }
  }
  const errors = verifyAssets();
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: bun scripts/build-assets.ts [--check]");
  }
  if (args[0] === "--check") {
    const errors = verifyAssets();
    if (errors.length > 0) throw new Error(errors.join("\n"));
  } else {
    buildAssets();
  }
}
