# Self-hosted browser assets

DeckTerm serves its browser dependencies from `web/assets/`. The build script
copies the pinned npm packages and checks their bytes without contacting the
network. `web/assets/manifest.json` records every served file, its byte count,
SHA-256 hash, source path or URL, version, license, and any documented transform.

## Sources

| Asset                        | Version | Source                                                                                                     | License                                        |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Lucide UMD                   | 1.41.0  | `node_modules/lucide/dist/umd/lucide.min.js`, with its development-only `sourceMappingURL` trailer removed | ISC, plus MIT for listed Feather-derived icons |
| diff2html JavaScript and CSS | 3.4.56  | `node_modules/diff2html/bundles/`                                                                          | MIT                                            |
| JetBrains Mono 400           | 5.0.0   | `node_modules/@fontsource/jetbrains-mono/400.css` and its referenced font files                            | SIL OFL 1.1                                    |
| Symbols Nerd Font Mono       | v3.4.0  | Nerd Fonts commit `fa7b859994228a9c8759f99c55a8d31ee92a1b5e`                                               | MIT                                            |

The Nerd Fonts TTF and license are committed inputs. They came from the
immutable `v3.4.0` tag, not the moving `master` branch. Their expected hashes
are enforced by the build script:

```
SymbolsNerdFontMono-Regular-v3.4.0.ttf  f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60
licenses/nerd-fonts-v3.4.0-LICENSE       84a7a98c82140fb12c37fe42b93805baa16024cb3e5acc599b7ffe612c55d847
```

Lucide 1.41.0 references a source map that is not shipped with the selected asset.
`scripts/build-assets.ts` removes only that trailing `sourceMappingURL` line and records
`Remove development-only sourceMappingURL trailer` in the manifest source metadata. It does
not otherwise transform the asset.

Run `bun run assets:build` after intentionally changing a pinned asset dependency.
Run `bun run assets:check` in CI or before review. The check compares the
committed outputs with the installed, exact dependency versions and never
starts the application or fetches the network.
