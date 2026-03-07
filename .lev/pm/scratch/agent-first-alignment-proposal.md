# Agent-First Alignment Proposal

**Date:** 2026-02-04
**Swarm:** 4 agents (code, readme, docs, templates)
**Aggregate Confidence:** 0.53 — significant changes needed

---

## Core Insight

agentguard is an **agent-first** tool. The AI agent is the one doing `git commit` and `git push`. The human is an observer who reviews the audit trail after the fact. Current code, docs, and templates are written as if a human developer is the primary actor.

## Corrected Mental Model

```
WRONG:  Human commits → blocked → human runs validation → human commits again
RIGHT:  Agent commits → blocked → agent reads gate → agent validates → agent commits
        Human reviews audit trail after the fact
```

---

## Findings by Area

### 1. Code (Confidence: 0.75)

Core mechanics are sound. Scattered human-centric language needs cleanup.

| File | Line/Area | Issue | Fix |
|------|-----------|-------|-----|
| `bin/agentguard.js` | Output messages | "You can commit freely" | "Gate cleared, commit may proceed" |
| `bin/agentguard.js` | Help text | Addresses "you" (human) | Address the agent workflow |
| `lib/config.js` | `bypassWarning` var | Implies human override | Rename to `enforceValidation` or remove |
| `lib/config.js` | `DEFAULT_COMMIT_TEMPLATE` | "Did you update docs?" (human checklist) | Rephrase as agent decision criteria |
| `lib/config.js` | `DEFAULT_PUSH_TEMPLATE` | Same human checklist framing | Same fix |
| `lib/runner.js` | JSDoc comments | "Review text (captured for audit trail)" implies human review | "Validation output (for proof archive)" |

### 2. README (Confidence: 0.40) — Most Work Needed

| Section | Issue | Proposed Change |
|---------|-------|-----------------|
| **Tagline** | "Git hooks that FORCE validation. No escape." | "Validation gates for AI agents. Every commit has proof." |
| **The Cycle** | Human shame/burnout narrative | Reframe: agents are goal-driven, compress checks — this forces the step |
| **Quick Start** | Shows human running commands | Show agent workflow: agent hits lock → agent reads gate → agent submits proof |
| **Lock/Lease diagram** | `$ git commit` (human prompt) | Label as agent action |
| **"Why Lock/Lease?"** | "You must explicitly run validation" | "Agent must produce validation proof" |
| **Husky section** | `exec < /dev/tty` (interactive TTY) | Remove — agents don't have TTY |
| **CLI Reference** | Uses old `release --audit-proof` commands | Update to v4 `lease <topic>` syntax |
| **Config section** | Still shows old `.agentguard.json` format | Add v4 topics format alongside |
| **Template Variables** | Missing `{{topic}}`, `{{args}}`, `{{env:VAR}}` | Add to table |
| **Test badge** | "31 passing" | Update to "43 passing" |
| **Missing** | No "Agent-First Design" lead section | Add before "The Cycle" |
| **Missing** | No multi-agent pipeline example | Add Agent A codes → Agent B reviews pattern |
| **Missing** | No "Audit Trail for Humans" section | Add: what humans should review |

### 3. Docs/Content (Confidence: 0.82)

| File | Issue | Priority |
|------|-------|----------|
| `docs/ARTICLE.md` | Leads with "Stop Deploying Broken Code" (blame) | Reframe: "Stop Deploying Without Proof" |
| `docs/ARTICLE.md` | Human emotional angle ("I'm an idiot") | Keep the personality but add agent-first framing |
| `docs/content/ARTICLE.md` | Duplicate of above | Same changes |
| `docs/GUIDE.md` | Uses "You:" and "Developer:" labels | Lead with "Agent:" interactions |
| `docs/content/CLAUDE_GUIDE.md` | Already agent-focused | Minor: update to v4 `lease` commands |
| `skills/agentguard/SKILL.md` | Strong agent protocol | No changes needed |

### 4. Templates (Confidence: 0.15) — Complete Rethink Needed

Templates are read by **agents**, not humans. Current format:

```markdown
## Standards Check
- [ ] Did you update docs if you changed public APIs?
- [ ] Did you add tests for new functionality?
```

**Problem:** Agents can't check boxes. They need structured decision criteria.

**Proposed rewrite:**

```markdown
# Pre-Commit Validation Gate

## Required Validations
Run each configured runner. All must exit 0.

{{runners}}

## Decision Criteria
- IF public API changed → docs MUST be updated
- IF new functionality → tests MUST exist
- IF production code → no console.log/debug statements

## Changed Files
{{files}}

## Proof Submission
After running all validators, submit proof:

  npx agentguard lease pre-commit --audit-proof='
  Runner: <name>
  Status: PASS | FAIL
  Output: <summary>
  ...
  Summary: <assessment>'
```

**Key changes:**
- Checklist → decision rules (IF/THEN)
- "Did you" → declarative requirements
- Clear proof format template inline
- Runners listed with expected behavior

---

## Implementation Priority

| Priority | Area | Effort | Impact |
|----------|------|--------|--------|
| **P0** | Templates rewrite | Low | High — agents read these every commit |
| **P1** | README agent-first reframe | Medium | High — first thing users/agents see |
| **P1** | CLI output messages | Low | Medium — agent reads these |
| **P2** | README v4 syntax update | Low | Medium — docs match code |
| **P2** | Code comments cleanup | Low | Low — internal only |
| **P3** | ARTICLE reframe | Medium | Low — marketing, not runtime |
| **P3** | GUIDE update | Low | Low — onboarding doc |

---

## Version Impact

These are messaging/docs changes, not breaking API changes. Appropriate for **0.2.0** (minor bump — new templates, updated docs, same API).

---

## Summary

The tool works correctly. The framing is wrong. agentguard isn't a tool that blocks developers — it's a protocol that forces agents to prove their work before it propagates. Fix the messaging, fix the templates, and the tool matches its purpose.
