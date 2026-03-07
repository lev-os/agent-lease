# Commit Message Validation Gate

## Format Check
- [ ] Commit message follows conventional commits format
- [ ] Subject line is under 72 characters
- [ ] Body explains the "why" not just the "what"

## Runners
{{runners}}

When everything checks out:
  npx agentguard lease commit-msg --audit-proof='<describe what you validated>'
