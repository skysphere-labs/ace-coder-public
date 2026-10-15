# Agent development map

Start with [ARCHITECTURE.md](ARCHITECTURE.md) and [FEATURES.md](FEATURES.md). Repository instructions are in [AGENTS.md](../AGENTS.md).

Use focused tests next to the module you change. `npm run test:public` covers public profile isolation, local startup, GitHub, secure vault, pairing, transcript fixtures, and build metadata. `npm run build` compiles Electron sources and the renderer. Native database/PTY tests require compatible native dependencies.

The synthetic showcase requires no production account, cloud deployment, or maintainer data. Its fixtures illustrate the interface; they are not evidence of live model execution.
