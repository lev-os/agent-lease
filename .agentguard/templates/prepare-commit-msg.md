# Prepare Commit Message Gate

## Automatic Enrichment
This hook enriches the commit message with validation trailers.

## Runners
{{runners}}

When everything checks out:
  npx agentguard lease prepare-commit-msg --audit-proof='<describe what you validated>'
