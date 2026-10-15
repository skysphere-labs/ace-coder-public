# Third-party notices

ACE CODER's project license is Apache-2.0; see [LICENSE](LICENSE). Third-party
material retains its own applicable license and attribution. The project license
does not replace those terms or grant rights to third-party trademarks.

## Bundled skill adaptations

These are adapted prompt documents shipped under `electron/assets/skills/`.
License copies are included with the skills so the notices travel with that
bundle. Upstream license snapshots were checked on 2026-10-15; the snapshot
commits below identify the license evidence, not the original import commits.

| Bundled material | Upstream and retained attribution | License copy |
| --- | --- | --- |
| `mp-grill-with-docs`, `mp-grill-me`, `mp-to-prd`, `mp-to-issues`, `mp-tdd`, `mp-diagnose`, `mp-handoff`, `mp-caveman`, and `grill-me` | [mattpocock/skills](https://github.com/mattpocock/skills), Copyright (c) 2026 Matt Pocock | [MIT](electron/assets/skills/licenses/mattpocock-skills-MIT.txt) |
| `skill-cleaner` | [steipete/agent-scripts](https://github.com/steipete/agent-scripts), Copyright (c) 2026 Peter Steinberger | [MIT](electron/assets/skills/licenses/steipete-agent-scripts-MIT.txt) |
| `steipete-frontend-design` | [steipete/agent-scripts frontend-design](https://github.com/steipete/agent-scripts/tree/main/skills/frontend-design), Copyright 2024 Anthropic PBC | [Apache-2.0](electron/assets/skills/licenses/anthropic-frontend-design-Apache-2.0.txt) |
| `autoreview` | [openclaw/agent-skills](https://github.com/openclaw/agent-skills), Copyright (c) 2026 openclaw | [MIT](electron/assets/skills/licenses/openclaw-agent-skills-MIT.txt) |

The Matt Pocock adaptations and their changes are described in
[VENDORED-NOTICE.md](electron/assets/skills/VENDORED-NOTICE.md). Other listed
skills have been condensed or adapted to ACE CODER's workflows. They are not
unmodified upstream releases.

License evidence:

- Matt Pocock: [`LICENSE` at `49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/LICENSE).
- Peter Steinberger: [`LICENSE` at `9989fe852a3f63f3933a1bdc20b4a25321240759`](https://github.com/steipete/agent-scripts/blob/9989fe852a3f63f3933a1bdc20b4a25321240759/LICENSE).
- Anthropic frontend design: [`skills/frontend-design/LICENSE.txt` at `9989fe852a3f63f3933a1bdc20b4a25321240759`](https://github.com/steipete/agent-scripts/blob/9989fe852a3f63f3933a1bdc20b4a25321240759/skills/frontend-design/LICENSE.txt).
- OpenClaw: [`LICENSE` at `3008b58824c9acbdc9a2fe2b79f8b3567c3db8ac`](https://github.com/openclaw/agent-skills/blob/3008b58824c9acbdc9a2fe2b79f8b3567c3db8ac/LICENSE).

## Package dependencies

`package.json` and `package-lock.json` identify the npm dependencies. The license
files, copyright notices, and any additional notices in the exact packages
remain authoritative. Preserve them when distributing source bundles,
JavaScript bundles, installed dependencies, or application binaries.

The inspected lockfile contains 1,287 non-root package entries, including nested
versions and development dependencies. This is an inventory of declared
metadata, not a count of unique projects or a complete license audit:

| Declared license expression | Entries |
| --- | ---: |
| MIT | 1,063 |
| ISC | 127 |
| Apache-2.0 | 32 |
| BSD-2-Clause | 18 |
| BSD-3-Clause | 17 |
| BlueOak-1.0.0 | 17 |
| (MIT OR CC0-1.0) | 2 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (WTFPL OR MIT) | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| 0BSD | 1 |
| CC-BY-4.0 | 1 |
| Python-2.0 | 1 |
| Unlicense | 1 |
| WTFPL | 1 |
| WTFPL OR ISC | 1 |
| Missing in lockfile metadata | 1 |

Specific findings:

- `khroma@2.1.0` lacks a license field in the lockfile. Its published npm tarball
  contains `package/license`, the MIT license with Copyright (c) 2019-present
  Fabio Spampinato, Andrew Maney. The inspected tarball matched the lockfile's
  SHA-512 integrity value. This resolves the metadata gap for that package;
  preserve its actual license file.
- `dompurify@3.4.11` declares `MPL-2.0 OR Apache-2.0`. The alternative license
  expression should not be reported as an unavoidable GPL/AGPL obligation.
- `caniuse-lite@1.0.30001788` declares `CC-BY-4.0`. Preserve its applicable
  attribution and license when redistributing its data.
- The Electron runtime, native modules, generated assets, and files copied by
  the packaging process need a separate check against the contents of each
  distributable. Top-level npm license labels do not inventory all embedded
  third-party material.

## Third-party artwork and names

The source contains third-party service and agent artwork under
`src/assets/images/`, including `brands/`, `mcp/`, and `skills/`. Those names
and marks identify their respective services; inclusion does not imply
endorsement or grant trademark rights. Their redistribution provenance and
applicable artwork terms have not been established by this dependency review.
Record source and terms for each retained asset, or replace it with artwork
whose redistribution rights are established, before public release.

This file records known notices and outstanding evidence. It is not a statement
that every source file, asset, dependency, or binary has received legal clearance.
