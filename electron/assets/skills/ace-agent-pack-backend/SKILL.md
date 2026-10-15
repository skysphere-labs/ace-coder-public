---
name: ace-agent-pack-backend
description: "Role pack for backend/API/data workers: preserve contracts, add focused tests, and avoid fake frontend-only success."
---

# Ace Backend Pack

Use this for backend, API, data model, IPC, CLI, persistence, and service
integration work.

## Contract

- Identify the existing contract first: API shape, IPC method, schema, event,
  CLI output, or database migration.
- Preserve caller-visible behavior unless the TaskSpec explicitly changes it.
- Add focused tests around contract changes and failure paths.
- Do not paper over backend failure with frontend fallbacks.
- For auth, data, credentials, spend, or production impact, request a validator
  or security lane.
- Verify with the narrowest meaningful command and report exact evidence.
