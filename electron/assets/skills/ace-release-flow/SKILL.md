---
name: ace-release-flow
description: Prepare and verify local ACE CODER builds for a user-owned distribution.
---

# Local release preparation

Read the repository README, LICENSE, THIRD_PARTY_NOTICES.md, and packaging scripts. Verify the exact checkout and preserve user data before replacing an installed app.

Run npm ci, npm run test:public, and npm run build. Packaging targets are npm run package:mac and npm run package:win; native dependencies and platform build tools are required. Remote SSH helpers must be built from electron/remote-daemon/ when needed.

Inspect packaged files for credentials, user data, development caches, and unintended generated code. Sign and notarize distributions using the distributor's own credentials where required. Record artifact checksums and the source commit.

This source release does not include a hosted updater or publishing workflow. Publishing a binary, changing repository visibility, or replacing an installation requires authorization for that action. Never assume access to publisher infrastructure.
