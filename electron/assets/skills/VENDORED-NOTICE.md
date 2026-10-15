# Vendored Skills Notice

Some skills under `electron/assets/skills/` are vendored (adapted) from an
external open-source skill collection. They are PROMPT CONTENT ONLY: the prompt
approach is preserved, but external publish/label plumbing (GitHub / Linear /
generic issue-tracker writes and triage labels) was stripped and re-targeted to
Ace's native control plane — the **Mission Board** (work authority) and the
**ace-ops wiki** (glossary + ADRs + rehydration spine). Frontmatter was
rewritten to match Ace's SKILL.md format (`name` + `description`).

## Source

- Upstream: github.com/mattpocock/skills ("Skills for Real Engineers")
- Author: Matt Pocock
- Vendored on: 2026-05-28

Credit and thanks to Matt Pocock. These adaptations are derivative prompt content;
the original approach and wording belong to the upstream project.

## Vendored skills

Each is renamed `mp-<id>` and keeps the original id in its description.

| Ace skill        | Upstream id        | Purpose                                                        |
| -------------------- | ------------------ | -------------------------------------------------------------- |
| `mp-grill-with-docs` | `grill-with-docs`  | Primary glossary-aware PRD-grilling (wiki glossary + ADRs)     |
| `mp-grill-me`        | `grill-me`         | No-glossary fallback grilling                                  |
| `mp-to-prd`          | `to-prd`           | Brain-dump / context -> PRD posted to Mission Board            |
| `mp-to-issues`       | `to-issues`        | PRD -> sliced Mission Board cards with AFK/HITL tags           |
| `mp-tdd`             | `tdd`              | Test-first build contract + test-quality rubric               |
| `mp-diagnose`        | `diagnose`         | Systematic debugging / regression discipline                  |
| `mp-handoff`         | `handoff`          | Cross-agent context transfer (into the card Goal Ledger)       |
| `mp-caveman`         | `caveman`          | Token-cheap terse communication mode                          |

## Ace adaptations applied

- Issue-tracker writes (`to-prd`, `to-issues`) re-pointed to the Mission Board; no
  GitHub/Linear publish, no `ready-for-agent` external label.
- `to-issues` slice tags mapped to Ace semantics: **AFK** = suitable for
  unattended root-GoalAgent validation and scoped PR/check handoff; **HITL** =
  hold at the gate for the owner.
- Glossary (`CONTEXT.md`) and ADRs (`docs/adr/`) re-pointed to the ace-ops wiki
  glossary + ADR sections.
- `handoff` document target changed from the OS temp dir to the card's Goal Ledger
  (or `.ace/scratch` when outside a card scope).
- DONE:/BLOCKED: trailer conventions added to each skill so they fit the worker
  contract; `mp-caveman` explicitly exempts the trailer from compression.

## Source-access notes

Upstream repo tree and most raw `SKILL.md` files were fetched directly and
reproduced faithfully (`grill-with-docs`, `grill-me`, `to-prd`, `to-issues`, `tdd`,
`diagnose`, `handoff`, `caveman`), including the `grill-with-docs` CONTEXT-FORMAT
and ADR-FORMAT references. No source gaps; content reflects the upstream prompts as
of the vendoring date with only the Ace adaptations listed above.

## License copies and additional adaptations

The existing source-access notes above describe the original import record.
The following license snapshots were independently checked on 2026-10-15;
their commit identifiers establish the license evidence, not the original
vendoring revision.

- The eight `mp-*` adaptations above and the additional `grill-me` skill are
  derived from Matt Pocock's skills. Copyright (c) 2026 Matt Pocock. The full
  [MIT license](licenses/mattpocock-skills-MIT.txt) is included from upstream
  commit `49dd158d1076134a641b33efb035946536778336`.
- `skill-cleaner` is adapted from `steipete/agent-scripts`. Copyright (c) 2026
  Peter Steinberger. The full [MIT license](licenses/steipete-agent-scripts-MIT.txt)
  is included from upstream commit `9989fe852a3f63f3933a1bdc20b4a25321240759`.
- `steipete-frontend-design` is adapted from the frontend-design skill in
  `steipete/agent-scripts`. Its specific upstream license is Apache-2.0,
  Copyright 2024 Anthropic PBC; it is not covered by an assumption that every
  skill in that repository uses its root MIT license. The full
  [skill-specific license](licenses/anthropic-frontend-design-Apache-2.0.txt) is
  included from upstream commit `9989fe852a3f63f3933a1bdc20b4a25321240759`.
- `autoreview` is adapted from `openclaw/agent-skills`. Copyright (c) 2026
  openclaw. The full [MIT license](licenses/openclaw-agent-skills-MIT.txt) is
  included from upstream commit `3008b58824c9acbdc9a2fe2b79f8b3567c3db8ac`.

See the repository's `THIRD_PARTY_NOTICES.md` for the wider inventory and
outstanding provenance checks. ACE CODER adaptations do not remove the
upstream licenses or their required notices.
