# Third-Party Notices

DeckTerm includes concepts and normalization logic derived from third-party
open-source projects. This file records the required attribution for that
derived work; it does not cover DeckTerm's own runtime dependencies (see
`package.json`).

## traycerai/traycer

The tool-input summary normalization (`toSummaryLine` in
`backend/telemetry.ts`) and the default-suppress nesting policy concept used
in DeckTerm's shell-integration telemetry are derived from
[traycerai/traycer](https://github.com/traycerai/traycer), licensed under the
Apache License, Version 2.0.

```
Copyright Traycer AI (traycerai/traycer contributors)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## herdrdev/herdr

The agent screen-rule data in `backend/agent-rules/claude.toml` and
`backend/agent-rules/codex.toml` is derived from
[herdrdev/herdr](https://github.com/herdrdev/herdr)
`src/detect/manifests/claude.toml` and `src/detect/manifests/codex.toml` at
commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` (v0.9.5), modified by
DeckTerm (each file's header lists the edits). The region and matcher
semantics in `backend/agent-screen-rules.ts` are ported from
`src/detect/manifest.rs`, and the hysteresis constants in
`backend/agent-status.ts` from `src/pane/agent_detection.rs`, at the same
commit. herdr is licensed under the Apache License, Version 2.0. herdr ships
no NOTICE file and its copyright line is the unfilled template, so the holder
is recorded as "herdr contributors".

```
Copyright herdr contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
