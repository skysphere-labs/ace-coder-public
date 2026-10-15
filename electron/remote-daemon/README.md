# Remote SSH daemon

The public source distribution does not include prebuilt remote daemon binaries.
Build them from this directory before using remote SSH workspaces or packaging
an application with remote SSH support.

With Go 1.22 or newer and Bash installed, run from the repository root:

```sh
bash electron/remote-daemon/build.sh
```

This cross-compiles the retained source for Linux and macOS on amd64 and arm64
and writes `electron/bin/ace-coder-daemon-<os>-<arch>`. The Go module pins the PTY
dependency in `go.mod` and `go.sum`; the first build may download that dependency.
The daemon supports Linux and macOS hosts, not Windows hosts. Run `go test ./...`
inside this directory on a supported host before distributing your builds.

The desktop app installs the selected binary over the user's configured SSH
connection under `~/.ace-coder/ace-coder-daemon`, with clipboard images under
`~/.ace-coder/pastes`. It does not reuse the legacy private daemon installation.
Normal SSH host verification and configured credentials remain in effect.
