---
name: ace-memory
description: How every Ace agent uses the unified knowledge base - the browse-first retrieval ladder, trust tiers and decay, and recording durable claims (dumps only, never canon).
---

# Ace Memory — the unified knowledge base

One search across the ops wiki, every project wiki, dump intake, memory candidates, goal ledgers, and (read-only) Hermes memories. Retrieval is browse-first: search is the fallback, not the front door.

## The retrieval ladder (cheapest first)

1. **Spawn pointer** — your spec's `## Knowledge` section + `ACE_KNOWLEDGE_PACK` env name your pack and project. Start there.
2. **Role pack** (1 read) — `.ace/wiki/00_index/agent-pack-<role>.json`: project status, next actions, recent decisions. Read it before asking anything.
3. **Index pages** (1 read each) — `00_index/PROJECTS.md`, `NEXT_ACTIONS.md`, `RECENT_CHANGES.md` answer "what's going on" without any search.
4. **Search specifics** — `ace memory search "<topic>" --project <id>` (filters: `--tier`, `--tag`, `--kind`, `--limit`). Snippets only.
5. **Fetch one page** — `ace memory get <path>` for the single hit that matters (16KB cap). Never paste large results into your context.

## Trust tiers and decay (how to weigh results)

- `canon` > `working` > `external` > `raw`. **Cite canon paths in evidence.** Raw/dump results are unverified claims — corroborate before relying on them; never present them as authoritative.
- Results carry `decay` + `decayReasons` (contamination, expired-fact, superseded-duplicate, stale-canon). Decayed content is deprioritized for a reason — do not cite it as authoritative. `--include-decayed` exists for forensics only.
- `external` = Hermes memories (read-only source). Useful context about the owner; not project ground truth.

## Recording knowledge (write rules)

- **You never write canon.** Canon pages are written only by the nightly curator and the electron wiki-updater. `ace wiki update` is role-gated and will refuse worker/validator roles.
- Record durable learnings as **untrusted intake** the curator promotes nightly:
  - `ace memory remember "<one clear claim>" --category lesson|decision|fact|todo [--tag <vocab-or-x/free>]`
  - or `memoryCandidates[]` in your completion.json, or `ace wiki dump` for structured session evidence.
- Before `DONE:`, dump anything a future agent would need: hard-won lessons, decisions made, pitfalls hit. One claim per remember; link evidence paths instead of pasting content.
- Secrets are scanned, redacted, and quarantined at every gate — but never paste tokens/keys anywhere in the first place.
- Hermes memory directories are read-only; no knowledge write may target them.

## Hygiene

- Tags come from the controlled vocabulary (ace, project, lesson, decision, pitfall, pattern, todo, daily, life, infra, person, research, ...). Free tags only as `x/<name>`.
- Prefer fresh results; a `stale-canon` hit may still be right — verify against live evidence (`ace`, `gh`) before acting on it.
- Live evidence always wins over recalled memory.
