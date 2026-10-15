# {{project_name}}

Cloudflare Workers app scaffolded by **ace-github-flow**. Stack: Workers +
Hono + D1 + Drizzle, Vite-free Worker build, Biome, Vitest, strict TypeScript.
Free + secure dependencies only.

## Quickstart
```bash
pnpm install
pnpm run dev          # http://localhost:8787
curl localhost:8787/health   # -> {"ok":true,...}   <- success criterion
```

## Scripts
| Script | What |
| --- | --- |
| `pnpm dev` | Local Worker (wrangler dev) |
| `pnpm build` | `wrangler deploy --dry-run` (validates the bundle) |
| `pnpm test` | Vitest unit tests |
| `pnpm lint` | Biome check |
| `pnpm type-check` | `tsc --noEmit` |
| `pnpm security-audit` | `pnpm audit --audit-level=high` |
| `pnpm deploy` | `wrangler deploy` (prefer the CI deploy gate) |

## Branch & deploy model
This repo is mode-aware (`.ace/repo.json`).
- **Enterprise**: push feature branches → PR into `dev` (auto Cloudflare preview) →
  PR `dev` → `main` requires owner approval; prod deploy waits on the
  `production` environment reviewer.
- **Solo**: short-lived branches → PR into `main`; `node solo-merge.mjs <branch>`
  auto-resolves conflicts via `git rerere` and fast-forwards.

## CI/CD
`.github/workflows/`: `ci` (lint/type/test + e2e on merge queue), `security`
(audit + OSV + Dependabot), `deploy` (preview on PR, approval-gated prod), and —
enterprise only — `conflict-detector` and `pr-summary` (the owner's one-paragraph
review). Branch protection lives in `rulesets/`.

See the `ace-github-flow` skill for the full doctrine.
