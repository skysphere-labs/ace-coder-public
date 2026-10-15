# Security policy

## Maintenance status

This repository is a read-only source snapshot of Skysphere ACE CODER. No version
has a guaranteed security maintenance window, response deadline, or patch
commitment. An archived release mirror should not be treated as an actively
maintained distribution. Maintainers of independent forks are responsible for
their own dependency updates, security review, and releases.

## Reporting a vulnerability

If the repository's [Security tab](https://github.com/skysphere-labs/ace-coder-public/security)
offers **Report a vulnerability**, use that private GitHub form. Include the
affected revision, a minimal reproduction using synthetic data, the impact,
and any proposed mitigation. Do not include real credentials or other people's
private data.

If that private form is unavailable, this release mirror does not provide an
alternative private intake channel. Do not open a public issue or pull request
containing credentials, personal data, or an exploit report. For a vulnerability
in an independently maintained fork or a third-party component, use that
maintainer's published security policy. Reporting a finding does not imply a
guaranteed response or fix from Skysphere Labs.

## Operating boundaries

Coding agents and their tools can execute commands and change files with the
permissions of the account running them. Git worktrees separate working copies;
they are not an operating-system sandbox. Review the commands, permissions,
third-party skills, and MCP servers you enable.

Local databases and transcripts can contain source code, prompts, filesystem
paths, and other sensitive material. Your chosen agents and integrations may
send data to model providers, GitHub, MCP services, or browser destinations.
The application is not a guarantee that project data stays on the device.

Remote access is optional. A paired device can control the workspace. Use a
network and devices you trust, revoke devices you no longer use, and disable
remote access when it is unnecessary. This application is not designed as an
untrusted multi-tenant hosting service.

The public source does not include a Skysphere-operated authentication backend,
Cloudflare release service, or private automatic updater. Keep your own builds,
agent CLIs, and dependencies current, and review changes before installing them.
