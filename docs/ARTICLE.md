# Stop Deploying Broken Code: Building Forced Validation Gates for Git

Every developer has felt that moment. You push code. CI fails. Netlify deploy crashes. TypeScript errors you could have caught locally. You stare at the red X on your PR and think "I'm an idiot."

But you're not. It's a workflow gap, not a skill issue.

## The Problem: Validation is Optional When It Should Be Mandatory

Here's the cycle:
1. You make changes
2. You forget to run the build
3. You commit and push
4. CI catches the error
5. You feel dumb
6. Repeat

The cost isn't just emotional. It's time. CI cycles take minutes. Deploy rollbacks take longer. Broken deploys on Friday afternoon? Career-limiting.

The real issue: **there's no forcing function**. Nothing physically prevents you from committing broken code. You rely on discipline. Discipline fails.

## Why Husky and Lefthook Aren't Enough

You might say "just use pre-commit hooks!" You'd be right to try. Tools like Husky and Lefthook exist for this exact reason. They run validation during git commits.

But they have problems:

**They're slow.** A full build + lint + test suite can take 30 seconds. Devs bypass them with `--no-verify` because waiting sucks.

**They're optional.** There's no enforcement. New team member doesn't know about them? Broken commits. Frustrated dev in a hurry? `git commit --no-verify`.

**They don't prove anything happened.** Hook ran. Did it pass? Who knows. The commit went through either way if someone bypassed it.

The core issue: these tools run validation **during** the commit. What we need is a tool that requires validation **before** the commit is allowed.

## The Lock/Lease Pattern: Borrowed from Distributed Systems

In distributed systems, when multiple processes need to coordinate access to a resource, they use locks and leases:

1. Process A wants to write → acquires lock
2. Lock blocks other processes
3. Process A does work, proves work completed
4. Process A releases lock with proof
5. Resource is now safe to access

We can apply this to git commits:

**First commit attempt:**
- Pre-commit hook detects no validation proof
- Creates `.agentguard.json` lock file
- **BLOCKS THE COMMIT**
- Shows message: "Validation required. Run `npx agentguard release` after validating."

**Developer runs validation:**
- Runs build, lint, tests (whatever is required)
- Runs `npx agentguard release --audit-proof`
- Tool verifies validation passed
- Stamps lock file with proof + timestamp

**Second commit attempt:**
- Pre-commit hook sees valid proof
- Allows commit to proceed
- Archives proof to `.agentguard/audit-trail/`

This forces the step. No accidents. No bypassing. You **must** validate before the commit succeeds.

## The Discovery Process: How an Agent Should Approach This

When an AI agent (like Claude) is helping you set up a project, it should discover validation needs through a B→A→C protocol:

### Phase B: DISCOVERY
Audit the current state. What exists? What's broken?

```bash
# Check existing hooks
ls .git/hooks/
cat .git/hooks/pre-commit

# Check CI configuration
cat .github/workflows/*.yml

# Check recent CI failures
gh run list --limit 20 --json conclusion,name
```

Parse the failures. Count how many were preventable with local validation. If >30% of CI failures are linting, types, or build errors — you have a workflow gap.

### Phase A: INTERVIEW
Ask the human:
- "What errors should be caught before commits?"
- "How long does full validation take locally?"
- "Are there cases where you need to bypass validation?"
- "Do you want validation to run automatically or on demand?"

This surfaces requirements. Maybe they only need TypeScript checks, not full tests. Maybe they need a bypass for WIP commits on feature branches.

### Phase C: IMPLEMENTATION
Present a dashboard:

```
┌─────────────────────────────────────────────────┐
│ VALIDATION GATE PROPOSAL                        │
├─────────────────────────────────────────────────┤
│ Current State:                                  │
│ • No pre-commit hooks                           │
│ • 12/20 recent CI failures were preventable     │
│ • Average CI cycle: 4.2 minutes                 │
│                                                  │
│ Proposed Gate:                                  │
│ • Require TypeScript build (tsc --noEmit)       │
│ • Require ESLint pass                           │
│ • Estimated local validation time: ~8 seconds   │
│                                                  │
│ Implementation:                                  │
│ 1. Install agentguard                          │
│ 2. Configure .agentguard.config.js             │
│ 3. Test with dummy commit                       │
│                                                  │
│ Approve? [Y/n]                                  │
└─────────────────────────────────────────────────┘
```

Get explicit approval. Then build.

## Agentic Runners: AI Code Review on Every Commit

This is where agentguard v2 gets interesting. Instead of just running build tools, you can pipe your diff into **any LLM CLI**.

The contract is simple: **exit 0 = pass, exit 1 = fail, stdout = review text.**

### Examples

**Claude (via Anthropic CLI):**
```json
{
  "name": "claude-review",
  "command": "claude -p 'Review this diff for bugs and security issues: {{diff}}'",
  "on": "commit"
}
```

**OpenAI Codex:**
```json
{
  "name": "codex-review",
  "command": "codex -q 'Check this code for issues: {{diff}}'",
  "on": "push"
}
```

**Local Ollama:**
```json
{
  "name": "llama-review",
  "command": "ollama run llama3 'Audit this diff: {{diff}}'",
  "on": "commit"
}
```

The `{{diff}}` variable is automatically replaced with `git diff --cached` (for commits) or `git diff origin..HEAD` (for pushes).

### Model Cascading: Fast + Thorough

Here's the pattern that actually works in practice:

**Small model on commit (fast feedback):**
- Haiku or GPT-3.5
- Catches obvious bugs
- Takes 2-5 seconds
- Runs every commit

**Large model on push (thorough review):**
- Opus or GPT-4
- Deep security/correctness analysis
- Takes 10-30 seconds
- Runs before push to main

**Config:**
```json
{
  "runners": [
    { "name": "build", "command": "npm run build", "on": "commit" },
    { "name": "haiku", "command": "claude -p 'Quick check for obvious bugs: {{diff}}'", "on": "commit" },
    { "name": "opus", "command": "claude --model opus -p 'Deep review for security and correctness: {{diff}}'", "on": "push" }
  ]
}
```

You get constant AI review without slowing down your workflow. Commit freely with haiku. Push confidently with opus.

### Template Variables

Commands can use rich context:

| Variable | Value | Example |
|----------|-------|---------|
| `{{diff}}` | Staged changes or full PR diff | `git diff --cached` or `git diff origin..HEAD` |
| `{{files}}` | Changed file paths | `src/auth.ts src/user.ts` |
| `{{project}}` | Project name | `my-app` |
| `{{branch}}` | Current branch | `feature/add-auth` |
| `{{hash}}` | Commit hash | `a1b2c3d` |

**Example with multiple variables:**
```json
{
  "name": "contextual-review",
  "command": "claude -p 'Review {{project}} branch {{branch}} files {{files}}: {{diff}}'",
  "on": "push"
}
```

### Why This Works

1. **LLMs catch different bugs than linters.** Type errors vs logic errors.
2. **Fast models are cheap.** Haiku costs ~$0.001 per commit.
3. **You can't bypass it.** The lock forces the step.
4. **It learns your patterns.** Same model reviews your code consistently.

I've caught real bugs with this. Null pointer dereferences. Race conditions. Off-by-one errors. Stuff that passed TypeScript and ESLint but would have crashed in prod.

## Implementation: The Code

Here's how agentguard works under the hood.

### Pre-commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit

LOCK_FILE=".agentguard.json"

if [ -f "$LOCK_FILE" ]; then
  # Lock exists, check for proof
  PROOF=$(jq -r '.audit_proof // "none"' "$LOCK_FILE")

  if [ "$PROOF" == "PASSED" ]; then
    # Validation proven, allow commit
    mkdir -p .agentguard/audit-trail
    mv "$LOCK_FILE" ".agentguard/audit-trail/$(date +%s).json"
    exit 0
  else
    echo "❌ Agent-lease lock exists but no audit proof found"
    echo "Run: npx agentguard release --audit-proof"
    exit 1
  fi
else
  # No lock, create one and block
  cat > "$LOCK_FILE" <<EOF
{
  "locked_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "audit_proof": null,
  "reason": "First commit attempt requires validation"
}
EOF

  echo "🔒 Agent-lease lock created"
  echo "Validation required before commit"
  echo "Run: npx agentguard release --audit-proof"
  exit 1
fi
```

### Release Command

```javascript
// src/cli.js
async function release(options) {
  const lockFile = '.agentguard.json';

  if (!fs.existsSync(lockFile)) {
    console.error('No agentguard lock found');
    process.exit(1);
  }

  if (options.auditProof) {
    // Run validation
    const config = loadConfig(); // reads .agentguard.config.js
    const results = await runValidation(config.validators);

    if (results.every(r => r.passed)) {
      // Stamp proof
      const lock = JSON.parse(fs.readFileSync(lockFile));
      lock.audit_proof = 'PASSED';
      lock.validated_at = new Date().toISOString();
      lock.validators_run = results.map(r => r.name);
      fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2));

      console.log('✅ Validation passed, lock released');
      console.log('You can now commit');
    } else {
      console.error('❌ Validation failed:');
      results.filter(r => !r.passed).forEach(r => {
        console.error(`  - ${r.name}: ${r.error}`);
      });
      process.exit(1);
    }
  }
}
```

### Config File

```json
{
  "runners": [
    {
      "name": "build",
      "command": "npm run build",
      "on": "commit"
    },
    {
      "name": "lint",
      "command": "npm run lint",
      "on": "commit"
    },
    {
      "name": "haiku-review",
      "command": "claude -p 'Quick check for bugs: {{diff}}'",
      "on": "commit"
    },
    {
      "name": "test",
      "command": "npm test",
      "on": "push"
    },
    {
      "name": "opus-review",
      "command": "claude --model opus -p 'Deep review for security and correctness: {{diff}}'",
      "on": "push"
    }
  ],
  "lockDir": "auto",
  "projectName": "my-app"
}
```

**Runner phases:**
- `"commit"` — Runs on `git commit` (fast checks: build, lint, quick AI review)
- `"push"` — Runs on `git push` (thorough checks: tests, deep AI review)
- `"both"` — Runs on both commit and push (critical security checks)

**Lock directory options:**
- `"auto"` — XDG_RUNTIME_DIR if available, else /tmp
- `"local"` — .agentguard/locks/ in project
- `"xdg"` — XDG_RUNTIME_DIR/agentguard/
- `"/custom/path"` — Any absolute path

**Environment variable overrides:**
```bash
export AGENTGUARD_LOCK_DIR=/custom/locks
export AGENTGUARD_PROJECT=my-project
export AGENTGUARD_RUNNERS="build:npm run build,lint:npm run lint"
```

## Agent-Native Design: Built for AI-Assisted Development

This tool is designed for the future where AI agents help you code. Here's the workflow:

**You:** "Add auth to the user service"

**Claude:** *makes changes, writes tests*

**You:** "Commit this"

**Claude:** *attempts commit, sees agentguard lock*

**Claude:** "Agent-lease lock detected. Running validation gates..."

**Claude:** *runs `npx agentguard release --audit-proof`*

**Claude:** *validation passes, releases lock*

**Claude:** *commits successfully*

**Claude:** "Committed changes with validation proof. TypeScript build and ESLint passed."

The agent thinks "oh shit, forgot to build" **for you**. It knows the protocol. It forces itself to validate.

This is the key insight: when humans write code, we rely on discipline. When agents write code, we can **program the discipline into the workflow**.

## The Meta Layer: Observability

Agent-lease creates an audit trail. Every commit has proof of validation:

```bash
$ ls .agentguard/audit-trail/
1738512000.json  # Feb 2, 2026 14:00:00
1738512430.json  # Feb 2, 2026 14:07:10
1738513200.json  # Feb 2, 2026 14:20:00
```

Each file contains:

```json
{
  "locked_at": "2026-02-02T14:00:00Z",
  "validated_at": "2026-02-02T14:00:15Z",
  "audit_proof": "PASSED",
  "validators_run": [
    "TypeScript Build",
    "ESLint"
  ],
  "commit_sha": "abc123...",
  "author": "you@example.com"
}
```

You can query this. How many commits passed validation? How often do we bypass? What's the average validation time?

This data feeds back into process improvement. If validation takes too long, devs will bypass it. Measure it. Optimize it.

## Open Source

Agent-lease is open source and available now:

**GitHub:** github.com/yourusername/agentguard (replace with actual link)

**Install:**
```bash
npm install --save-dev agentguard
npx agentguard init
```

**Configure:**
Edit `.agentguard.config.js` with your validators.

**Use:**
```bash
git add .
git commit -m "Add feature"  # creates lock, blocks
npx agentguard release --audit-proof  # runs commit-phase runners, releases
git commit -m "Add feature"  # succeeds with proof
git push  # creates lock, blocks (if push runners configured)
npx agentguard release --audit-proof --phase push  # runs push-phase runners
git push  # succeeds
```

**With agentic runners:**
```bash
# Configure Claude review
cat > .agentguard.json <<'EOF'
{
  "runners": [
    { "name": "build", "command": "npm run build", "on": "commit" },
    { "name": "haiku", "command": "claude -p 'Quick bug check: {{diff}}'", "on": "commit" },
    { "name": "opus", "command": "claude --model opus -p 'Deep review: {{diff}}'", "on": "push" }
  ]
}
EOF

# Commit with AI review
git commit -m "Add feature"  # blocked
npx agentguard release --audit-proof  # build + haiku review
git commit -m "Add feature"  # succeeds

# Push with deep AI review
git push  # blocked
npx agentguard release --audit-proof --phase push  # opus review
git push  # succeeds
```

**Contribute:**
This is early. Issues and PRs welcome. Built this because I kept shipping broken code and got tired of feeling dumb.

## The Bigger Picture

This isn't just about git hooks. It's about forcing functions in software development.

We have linters. We have tests. We have CI. But they're all optional. You can bypass them. You can ignore them. You can "fix it later."

What if we couldn't?

What if every commit **required** proof of validation? What if every deploy **required** passing tests? What if every production release **required** a security scan?

We'd ship better software. Not because we're more disciplined. Because the workflow wouldn't let us ship broken code.

Agent-lease is a small step toward that world. Try it. Break it. Tell me what sucks.

Let's stop deploying broken code.
