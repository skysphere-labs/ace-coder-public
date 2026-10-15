# repo-ops — Ace project scaffolding + GitHub enforcement

Implements the `ace-github-flow` doctrine. One command scaffolds a
best-practice Cloudflare-stack repo; another creates the GitHub repo and enforces
the branch model. Every Ace agent uses these so all repos we set up are
managed identically.

## Commands

```bash
# 1. Scaffold a new project (Enterprise dev/prod, or Solo trunk)
node tools/repo-ops/bin/new-project.mjs --name my-app --mode enterprise   # or --mode solo

# 2. Create the GitHub repo + apply rulesets, prod environment, merge queue
cd my-app
node ../tools/repo-ops/bin/gh-bootstrap.mjs --repo <owner>/my-app --mode enterprise

# 3. Solo: easy auto-resolving merge to main (git rerere)
node tools/repo-ops/bin/solo-merge.mjs feat/my-change
```

## Layout
- `bin/new-project.mjs` — renders `templates/base` + `templates/<mode>` into a new
  repo, substitutes `{{project_name}}` / `{{owner}}` / `{{compat_date}}`, enables
  `git rerere`, writes `.ace/repo.json`, makes the first commit.
- `bin/gh-bootstrap.mjs` — `gh repo create` + push, create `dev`, apply
  `rulesets/{dev,prod}.json`, create the approval-gated `production` environment,
  set merge defaults. Tolerant: a failed step is logged, not fatal.
- `bin/solo-merge.mjs` — fetch + rebase onto base with rerere auto-resolution +
  fast-forward. Exit 3 means a genuinely new conflict to resolve once (then
  remembered).
- `templates/base/**` — stack shared by both modes (Workers + Hono + D1 + Drizzle,
  Biome, Vitest, strict TS; CI, security, Danger rubric, Dependabot, CODEOWNERS).
- `templates/enterprise/**` — approval-gated `deploy.yml`, `conflict-detector.yml`,
  `pr-summary.yml`, and `rulesets/{dev,prod}.json`.
- `templates/solo/**` — simple `deploy.yml` (direct deploy on green main).

## Stack (free + secure only)
Cloudflare Workers · Hono · D1 + Drizzle ORM · Biome · Vitest · strict TypeScript.
Security gates: `pnpm --frozen-lockfile`, `pnpm audit`, OSV-Scanner, Dependabot.
better-auth is the recommended auth layer (add per project).
