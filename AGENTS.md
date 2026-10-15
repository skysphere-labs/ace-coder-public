# Skysphere ACE CODER contributor guidance

This is an independent source release. Develop in your own fork: this upstream mirror does not accept pull requests or direct contributions.

- Read README.md, docs/FEATURES.md, and docs/ARCHITECTURE.md before changing behavior.
- Preserve SQLite schemas and migration paths. Never commit application databases, provider sessions, credentials, or personal transcripts.
- Keep desktop startup local. Provider accounts and generic GitHub authorization belong to each installation's user.
- Work in isolated branches or worktrees in your own repository. Never assume permission to push, merge, publish, or connect a service.
- Use synthetic fixtures and run relevant checks. Report pre-existing failures separately from regressions.
- Preserve LICENSE, THIRD_PARTY_NOTICES.md, and third-party copyright notices.
- Do not reintroduce private deployment endpoints, signing keys, owner-specific paths, or automated release services.

See CONTRIBUTING.md for the release-mirror policy and SECURITY.md for the security model.
