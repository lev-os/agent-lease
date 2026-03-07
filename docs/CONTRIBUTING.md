# Contributing to agentguard

Thanks for your interest in contributing to agentguard! This project is part of the [lev-os](https://github.com/lev-os) ecosystem, sponsored by [kinglystudio.ai](https://kinglystudio.ai).

---

## Development Setup

```bash
# Clone the repo
git clone https://github.com/chidev/agentguard.git
cd agentguard

# Link globally for local development
npm link

# Verify it works
agentguard --help
```

---

## Running Tests

All 23 tests must pass before submitting a PR:

```bash
npm test
```

This runs:
- `test/e2e.js` — End-to-end tests covering the full lock/lease/runner cycle in isolated git repos
- `test/stress.js` — Stress tests for concurrent access and edge cases

Tests create temporary git repos, so they are self-contained and safe to run.

---

## Adding Custom Runners

Runners follow a simple contract:

- **Exit 0** = pass
- **Exit 1** = fail
- **stdout** = review text (displayed to user)

### Steps

1. Create your runner script or CLI command
2. Add it to `.agentguard.json` in the `runners` array:

```json
{
  "name": "my-runner",
  "command": "my-command '{{diff}}'",
  "on": "commit"
}
```

3. Test it: `npx agentguard release --audit-proof`
4. If contributing a built-in runner, add tests in `test/`

### Available Template Variables

| Variable | Value |
|----------|-------|
| `{{diff}}` | Git diff (staged or origin..HEAD) |
| `{{files}}` | Changed file paths |
| `{{project}}` | Project name |
| `{{branch}}` | Current branch |
| `{{hash}}` | Commit hash |

---

## Project Structure

```
agentguard/
  bin/           # CLI entry point
  hooks/         # Git hook scripts (pre-commit, pre-push)
  lib/           # Core logic (lock-manager, runner execution)
  test/          # E2E and stress tests
  docs/          # Documentation (article, guide, tweets)
  examples/      # Example configurations
  package.json
  README.md
  LICENSE
```

---

## Submitting Changes

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm test` (all 23 must pass)
5. Commit with clear message
6. Open a PR against `main`

### PR Guidelines

- Keep PRs focused (one feature or fix per PR)
- Include tests for new functionality
- Update README.md if adding user-facing features
- Update docs/GUIDE.md if changing agent interaction patterns

---

## Code Style

- Plain JavaScript (no transpilation step)
- No external dependencies (keep it zero-dep)
- XDG compliance for file storage
- Exit codes: 0 = success, 1 = failure

---

## Reporting Issues

File issues at [github.com/chidev/agentguard/issues](https://github.com/chidev/agentguard/issues).

Include:
- OS and Node.js version
- agentguard version (`agentguard --version`)
- Steps to reproduce
- Expected vs actual behavior

---

## Sponsor

This project is sponsored by [kinglystudio.ai](https://kinglystudio.ai).

Part of the [lev-os](https://github.com/lev-os) ecosystem.

---

## License

MIT
