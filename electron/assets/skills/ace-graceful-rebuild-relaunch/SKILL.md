---
name: ace-graceful-rebuild-relaunch
description: Rebuild a user-selected ACE CODER installation while preserving its data and verifying the result.
---

# Rebuild and relaunch

Identify the exact checkout, installed application, and selected data profile. Save active work and back up the user's application data before an authorized replacement. Do not shut down unrelated agent sessions.

Run focused tests and npm run build. Use the platform packaging command documented in README.md and inspect its output. Verify native database and terminal dependencies match the packaged Electron version.

Replace or relaunch the installed application only when the user has authorized that interruption. Verify startup, a disposable workspace, terminal creation, and data persistence after relaunch. Report checks actually performed and any untested platform.

No repository, application path, signing identity, remote publisher, or user profile is implied by this skill. This release has no hosted updater.
