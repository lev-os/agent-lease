# Agent-Lease Proof Protocol

## Overview

The proof protocol ensures every validation runner produces verifiable, auditable evidence. Proofs are captured, hashed, archived, and referenced in git commit trailers so that any reviewer (human or AI) can verify what validations were run and what they produced.

## How Proof Capture Works

### 1. Runner Execution

When `agentguard release` is invoked, each configured runner executes in sequence:

```
Runner "typecheck" --> tsc --noEmit --> stdout captured
Runner "lint"      --> eslint src/  --> stdout captured
Runner "haiku"     --> claude -p .. --> stdout captured
```

Each runner's combined stdout + stderr is captured in memory.

### 2. Hashing

Each runner's output is hashed using **SHA-256**, then truncated to **7 characters**:

```
sha256(runner_stdout) --> full_hash --> first 7 chars = proof_hash
```

Example:
```
sha256("All checks passed.\n0 errors, 0 warnings.") = "a1b2c3d..."
proof_hash = "a1b2c3d"
```

The 7-character truncation provides sufficient uniqueness for referencing while keeping trailers compact.

### 3. Archive Storage

Full runner output is archived to:

```
.agentguard/proofs/{proof_hash}.txt
```

Example:
```
.agentguard/proofs/a1b2c3d.txt   # typecheck output
.agentguard/proofs/e4f5g6h.txt   # lint output
.agentguard/proofs/i7j8k9l.txt   # haiku review output
```

## Archive Structure

```
.agentguard/
  proofs/
    a1b2c3d.txt                    # Individual runner proof (by hash)
    e4f5g6h.txt                    # Individual runner proof (by hash)
    i7j8k9l.txt                    # Individual runner proof (by hash)
    commit-abc1234.json            # Consolidated report for commit
```

### Individual Proof File Format

Plain text, exact runner output:

```
$ tsc --noEmit
All checks passed.
0 errors, 0 warnings.
```

### Consolidated Report JSON Format

```json
{
  "version": "1.0",
  "timestamp": "2026-02-03T12:00:00Z",
  "commit": {
    "hash": "abc1234",
    "branch": "feature/validation",
    "message": "feat: add input validation"
  },
  "runners": [
    {
      "name": "typecheck",
      "command": "tsc --noEmit",
      "trigger": "commit",
      "status": "pass",
      "exit_code": 0,
      "duration_ms": 2300,
      "proof_hash": "a1b2c3d",
      "proof_file": ".agentguard/proofs/a1b2c3d.txt"
    },
    {
      "name": "lint",
      "command": "eslint src/",
      "trigger": "commit",
      "status": "pass",
      "exit_code": 0,
      "duration_ms": 1100,
      "proof_hash": "e4f5g6h",
      "proof_file": ".agentguard/proofs/e4f5g6h.txt"
    },
    {
      "name": "haiku",
      "command": "claude -p 'Quick check: {{diff}}'",
      "trigger": "commit",
      "status": "pass",
      "exit_code": 0,
      "duration_ms": 4700,
      "proof_hash": "i7j8k9l",
      "proof_file": ".agentguard/proofs/i7j8k9l.txt"
    }
  ],
  "summary": {
    "total": 3,
    "passed": 3,
    "failed": 0,
    "total_duration_ms": 8100
  }
}
```

## Git Trailer Format

After successful validation, the `prepare-commit-msg` hook appends trailers to the commit message:

```
feat: add input validation

Implemented form validation with zod schemas.

agentguard-proof: typecheck=a1b2c3d lint=e4f5g6h haiku=i7j8k9l
agentguard-duration: typecheck=2.3s lint=1.1s haiku=4.7s
agentguard-report: .agentguard/proofs/commit-abc1234.json
```

### Trailer Definitions

| Trailer                | Content                                          |
|------------------------|--------------------------------------------------|
| `agentguard-proof`    | Space-separated `runner=hash` pairs              |
| `agentguard-duration` | Space-separated `runner=duration` pairs           |
| `agentguard-report`   | Path to consolidated JSON report                 |

## How to Verify Proof

Given a commit with trailers, anyone can verify the proof:

### Step 1: Read the trailer

```bash
git log -1 --format='%(trailers:key=agentguard-proof)'
# Output: typecheck=a1b2c3d lint=e4f5g6h haiku=i7j8k9l
```

### Step 2: Look up the proof file

```bash
cat .agentguard/proofs/a1b2c3d.txt
# Shows the full typecheck output
```

### Step 3: Verify the hash

```bash
sha256sum .agentguard/proofs/a1b2c3d.txt | cut -c1-7
# Should output: a1b2c3d
```

### Step 4: Read the consolidated report

```bash
cat .agentguard/proofs/commit-abc1234.json | jq .
# Full structured report with all runners, statuses, durations
```

## Proof Retention

By default, proofs are retained indefinitely. Projects can configure retention in `.agentguard.json`:

```json
{
  "proof": {
    "capture": true,
    "archive": true,
    "retention": {
      "max_age_days": 90,
      "max_count": 500
    }
  }
}
```

## Gitignore Considerations

The `.agentguard/proofs/` directory should generally be committed to the repository for full auditability. However, for large projects or projects with frequent commits, it may be appropriate to gitignore proofs and archive them externally:

```gitignore
# Option A: Keep proofs in git (recommended for small teams)
# (don't gitignore anything)

# Option B: External archival (large teams / CI)
.agentguard/proofs/*.txt
# Keep reports for reference
!.agentguard/proofs/commit-*.json
```

## Security Properties

- **Tamper evidence**: Changing proof content changes its hash, breaking the trailer reference
- **Non-repudiation**: Proof files show exactly what the validator produced
- **Auditability**: Consolidated reports provide structured metadata for tooling
- **Reproducibility**: Commands are recorded in the report, allowing re-execution
