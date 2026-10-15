# Optional provider usage meters

Provider usage collection is disabled in a fresh ACE CODER profile. Agent login
and agent execution work independently of these meters.

To enable collection, create `usage-settings.json` in the public profile's
`ACE_HOME` directory with this content, then restart ACE CODER:

```json
{ "enabled": true }
```

For the packaged app, `ACE_HOME` is the `.ace` folder inside its `ACE CODER`
application-data directory: `%APPDATA%/ACE CODER/.ace` on Windows,
`~/Library/Application Support/ACE CODER/.ace` on macOS, or the platform's
application-data directory on Linux. Development builds have a separate profile
whose name begins with `ACE CODER-`. An explicitly selected external storage
root keeps this file in that root's `.ace` directory.

Enabling the meters allows ACE CODER to read local Claude account labels and
plan information, read Codex session logs for usage measurements, and watch
those usage sources for changes. It also installs a Claude Code statusline
wrapper in the selected Claude configuration, preserving its prior command in
a backup and chaining it. Meter reports can be sent to devices that you pair
with ACE CODER. Collection does not send these files to a hosted ACE service.

To disable collection, set `enabled` to `false` or remove this file, then restart.
This stops ACE CODER's readers and watchers. A previously installed Claude
statusline wrapper may continue writing its local cache when Claude runs; restore
your previous statusline command from the profile's `usage/statusline-backup-*`
record in the selected Claude `settings.json` to remove that separate hook.
Missing, corrupt, and non-boolean settings keep collection disabled.
