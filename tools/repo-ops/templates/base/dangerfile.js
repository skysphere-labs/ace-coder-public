// Rubric hard-gates enforced on every PR (see RUBRIC.md). Danger injects
// `danger`, `warn`, `fail`, and `message` as globals — no import needed.

const pr = danger.github.pr
const modified = danger.git.modified_files.concat(danger.git.created_files)

const codeFiles = modified.filter((f) => /^src\/.*\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f))
const testFiles = modified.filter((f) => /\.test\.ts$/.test(f))

// 1) Tests accompany non-trivial code changes.
if (codeFiles.length > 0 && testFiles.length === 0) {
  warn('Code changed under `src/` without any test changes — add or update tests (RUBRIC #3).')
}

// 2) Conventional PR title.
if (!/^(feat|fix|chore|docs|refactor|test|perf|build|ci)(\(.+\))?!?:\s.+/.test(pr.title)) {
  fail(
    `PR title must be Conventional Commits (\`type(scope): summary\`). Got: "${pr.title}" (RUBRIC #5).`,
  )
}

// 3) Description present.
if (!pr.body || pr.body.trim().length < 20) {
  warn('PR description is thin — say what changed and how to verify it.')
}

// 4) Reviewable size.
const bigChanges = pr.additions + pr.deletions
if (bigChanges > 400) {
  warn(`Large PR (${bigChanges} changed lines). Consider splitting for reviewability.`)
}

message('✅ Rubric checks ran. The owner reads the one-paragraph summary above before approving.')
