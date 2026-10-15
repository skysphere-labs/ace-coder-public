---
name: ace-agent-pack-cloudflare
description: Role pack for Cloudflare Workers, Pages, D1, R2, KV, deploy, and Wrangler tasks with credential-safe validation.
---

# Ace Cloudflare Pack

Use this for Cloudflare Workers, Pages, D1, R2, KV, queues, Wrangler config,
and deploy/debug work.

## Contract

- Inspect existing Wrangler, Pages, Worker, D1, R2, KV, and CI config before
  proposing changes.
- Keep environment separation explicit: local/dev/staging/production.
- Never echo tokens or secret values. Use masked secret commands when needed.
- Verify deploy work with command output plus live endpoint or browser evidence
  when the task requires a real deploy.
- If credentials are missing, return a clear BLOCKED reason and the exact
  minimal permission set needed.
- Do not spend provider credits or mutate production unless the owner explicitly
  approves.
