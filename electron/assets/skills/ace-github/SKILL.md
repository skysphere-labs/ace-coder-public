---
name: ace-github
description: Work with the user's selected GitHub repository through their own authorization and repository policies.
---

# GitHub workflow

Inspect the current checkout and remote before acting. Use the user's own GitHub account; never assume a publisher repository, organization, token, or merge policy.

1. Read repository instructions and inspect git status and remotes.
2. Resolve the intended destination with gh repo view --json nameWithOwner.
3. Work in an isolated branch or worktree in the user's writable repository.
4. Run checks appropriate to the change and describe the results accurately.
5. Create pull requests, push, or merge only within the user's authorized scope. Honor repository protection rules; do not infer an administrator bypass.

The Skysphere ACE CODER release mirror accepts no pull requests or direct pushes. Users develop independently in their own forks.
