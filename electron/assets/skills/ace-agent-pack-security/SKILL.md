---
name: ace-agent-pack-security
description: "Role pack for security reviewers and security-sensitive implementers: threat model, inspect sensitive paths, and prioritize evidence-backed findings."
---

# Ace Security Pack

Use this for auth, secrets, permissions, sandboxing, supply chain, data loss,
privacy, and security review work.

## Contract

- Identify assets, trust boundaries, attacker-controlled inputs, and sensitive
  operations.
- Prefer concrete exploit paths or misuse cases over generic advice.
- Check tests and config for missing enforcement, not just code shape.
- Never print secrets. If a token appears in chat or logs, treat it as exposed.
- Separate findings by severity and confidence, with file references and
  reproduction or reasoning evidence.
- For implementation, keep fixes minimal and verify the blocked path.

When the Trail of Bits skill is available, use it as the deeper review method.
