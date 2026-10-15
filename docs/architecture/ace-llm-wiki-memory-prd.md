# Ace LLM Wiki / Memory Architecture — PRD (as built)

- **Mission:** msn-a204c57b · **Feature:** ft-4b07a844
- **Owner:** Chief · **Build:** autonomous GoalAgent (Claude), no merge/release
- **Status:** vertical slice IMPLEMENTED (phases 0–6); phases 7–8 are documented
  evidence gates (below). Companion: `ace-llm-wiki-memory-rubric.md`,
  `ace-llm-wiki-memory-root-cause.md`.

## 1. Goal

Turn Ace's wiki/memory/retrieval/writeback layer into a reliable
Markdown-first LLM wiki:

```
raw evidence → KnowledgeEvent → WikiCandidate → tiered gate
            → OKF-ish Markdown canon → FTS/retrieval → cited retrieval → health/audit
```

Immediate defect fixed: dump-only workspaces (`.ace/wiki-dump/` but no
`.ace/wiki/`) never bootstrap canon (see root-cause note).

## 2. Locked decisions (from the grill)

| # | Decision | Ruling (as built) |
|---|----------|-------------------|
| D1 | Source of truth | **Markdown-first canon, hard invariant.** External stores/indexes are caches/evidence only. Retrieval (`memory explain`) reads canon Markdown directly; the FTS index is explicitly a disposable helper. |
| D2 | On-disk format | **Google OKF** (Markdown + YAML frontmatter, `index.md`, `log.md`, `00_index/`) extended with Ace frontmatter (`sources`, `confidence`, `sensitivity`, `status`). |
| D3 | Promotion gate | **Tiered.** Auto-promote only when sourced + confidence ≥ threshold (default 0.8) + non-sensitive (public/internal) + non-contradicting. Contradiction/supersede or sensitive (restricted/forbidden) ALWAYS → inbox, regardless of confidence (the BEE-scar guard). |
| D4 | Build-vs-buy | **Native-first.** FTS5 + Markdown; no MemPalace/Supermemory/BEE in the live path. |
| D5 | First trigger | root GoalAgent `DONE`/`BLOCKED` → `WIKI_UPDATE` packet → KnowledgeEvents. |
| D6 | Surface | **CLI is the spine**; `WikiHealthPanel` extended for the UI. |

## 3. Architecture (as built)

| Stage | Where |
|-------|-------|
| raw evidence | `.ace/wiki-dump/**` (existing curator), `.ace/wiki-events.ndjson` (new) |
| KnowledgeEvent (append-only, content-addressed, idempotent) | `tools/ace/src/wiki-knowledge.cts` `appendKnowledgeEvent` |
| WikiCandidate (sourceEventIds, confidence, sensitivity, contradicts/supersedes) | `wiki-knowledge.cts` `eventToCandidates` |
| Tiered gate (D3) | `wiki-knowledge.cts` `gateCandidate` / `detectContradiction` |
| Inbox (owner review) | `.ace/wiki-inbox.ndjson` · `readInbox`/`resolveInbox`/`promoteInboxEntry` |
| OKF canon | `project-wiki-curator.cts` (single canon writer) — `bootstrapWikiSkeleton`, `backfillProject`; promotion writes a durable dump (id=candidateId) then re-curates so canon = union of all evidence |
| Bootstrap/backfill enumeration fix | `electron/wiki-bootstrap.cts` + one delegation in `local-core.knowledgeNightly` |
| Canon-first retrieval / explain | `electron/harness/knowledge-contract.cts` `explainFromResults` (trust-ranked, forbidden never returned, raw fallback labeled, citations) |
| Health/audit | `knowledge-contract.summarizeWikiHealth` (+ `electron/wiki-health.cts`), `wiki health` / `memory status` CLI, `WikiHealthPanel.tsx` |

### Frontmatter / contracts
- Sensitivity: `public | internal | restricted | forbidden`; gates promotion AND
  retrieval (`forbidden` never promoted, never returned).
- Page status: `draft | candidate | canon | superseded | deprecated`.
- `KnowledgeEvent` kinds + `WikiCandidate` types + `DEFAULT_PROMOTE_CONFIDENCE`
  (0.8) are single-sourced in `knowledge-contract.cts`.

### WIKI_UPDATE packet (D5 / §5.4)
```
WIKI_UPDATE:
  project: <projectId>
  events:
    - kind: <event kind>
      summary: <one line>
      sourceRef: <PR#|runId|path>
      sensitivity: <class>
      confidence: <0-1>
```
Parsed by `wiki-knowledge.parseWikiUpdatePacket` — **independent of**
`verdict.cts`, so DONE/BLOCKED/VERDICT/scorecard parsing is unaffected (proven by
test). `ace wiki writeback` ingests it into KnowledgeEvents (no direct canon
write; promotion is the separate gated step → A4.3 evidence-only).

## 4. CLI surface (new)
`wiki backfill`, `wiki writeback`, `wiki curate-events`, `wiki inbox`,
`wiki promote`, `wiki health`, `memory explain`, `memory status` — all
local-first (read the Markdown canon directly; no running app required).
Existing: `wiki dump/candidates/nightly/pack/audit/update`, `memory
search/get/remember/reindex`.

## 5. Phase status

- **Phase 0 — Root-cause + repro:** DONE. Failing-then-green test + root-cause note.
- **Phase 1 — Bootstrap + backfill:** DONE. OKF skeleton + `wiki backfill` +
  autonomous-nightly enumeration fix; idempotent.
- **Phase 2 — Event + candidate spine:** DONE. KnowledgeEvent + WikiCandidate.
- **Phase 3 — Tiered gate + inbox:** DONE. `wiki inbox` / `wiki promote`.
- **Phase 4 — Writeback (WIKI_UPDATE):** DONE for the D5 trigger; verdict compat proven.
- **Phase 5 — Canon-first retrieval:** DONE. `memory explain` (citations, labeled
  raw fallback, forbidden excluded), `memory status`.
- **Phase 6 — Health/audit:** DONE (CLI + panel). Computer-use ⊙ items DEFERRED to
  the Codex validator.
- **Phase 7 — Accelerator indexes:** GATE (documented). Link-graph already exists
  (`wiki-graph-indexer.cts` + `WikiGraphPanel`). Vector/embedding index is
  **omitted behind an evidence gate**: FTS5 × trust × freshness × decay is the
  owner-calibrated default (rich organization, simple technology; no BEE
  auto-extract). A vector index ships only if a retrieval eval shows FTS5
  insufficient — no silent dependency added.
- **Phase 8 — Migration:** GATE (documented). `wiki backfill` IS the migration for
  dump-only projects (idempotent, re-run safe); the autonomous nightly migrates
  on the next run. A broad one-shot migration of legacy stale pages is deferred
  as not required for the vertical slice and to avoid touching unrelated content.

## 6. Security / privacy
- `sensitivity` gates promotion + retrieval; `forbidden` never promoted/returned.
- Secret scanning + redaction + contamination quarantine inherited from the
  curator/contract and applied to KnowledgeEvents on append.
- No personal URLs/IDs hardcoded; project scoping via `--project-dir`/ids.

## 7. Out of scope / not done (honest)
- No merge/release/rebuild. No new third-party runtime dependency.
- `WikiHealthPanel` renders the `AceWikiHealth/v1` metrics when supplied; the
  data-feed slice/IPC would touch `ops-status.cts` (off-limits this card), so the
  authoritative health surface is the CLI. Full UI data-wiring is a documented
  follow-up; computer-use validates the panel.
- `local-core.cts` and `ops-status.cts` are outside ALWAYS-EDIT; only a single
  contained `knowledgeNightly` delegation was made to `local-core` (the headline
  defect), noted in the PR.
