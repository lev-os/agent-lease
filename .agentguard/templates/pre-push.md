# Pre-Push Validation Gate

## Standards Check
- [ ] Did you update docs if you changed public APIs?
- [ ] Did you add tests for new functionality?
- [ ] No console.log in production code?
- [ ] All commits follow conventional commits?

## Changed Files
{{files}}

## Runners
{{runners}}

When everything checks out:
  npx agentguard lease pre-push --audit-proof='<describe what you validated>'
