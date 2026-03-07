# Agent-Lease v2 Launch Thread

---

**Tweet 1: The Hook**

You've done it. We've all done it.

Push broken code → CI fails → feel dumb → fix → push again

It's not a skill issue. It's a workflow gap.

I built agentguard v2 to fix this. It FORCES validation before commits using a lock/lease pattern + pluggable runners.

Thread 🧵

---

**Tweet 2: Pluggable Runners**

v2 supports ANY CLI command with a simple contract:

exit 0 = pass, exit 1 = fail, stdout = review text

Traditional runners:
• `npm run build`
• `npm run lint`
• `npm test`

Agentic runners:
• `claude -p "Review: {{diff}}"`
• `codex -q "Check: {{diff}}"`
• `ollama run llama3 "Audit: {{diff}}"`

---

**Tweet 3: Model Cascading**

Smaller models review every commit (fast).
Larger models review on push (thorough).

Config:
```json
{
  "runners": [
    { "name": "haiku", "command": "claude -p 'Quick check: {{diff}}'", "on": "commit" },
    { "name": "opus", "command": "claude --model opus -p 'Deep review: {{diff}}'", "on": "push" }
  ]
}
```

Fast feedback + deep validation.

---

**Tweet 4: Template Variables**

Commands support rich context:

• `{{diff}}` → git diff (staged or origin..HEAD)
• `{{files}}` → changed files
• `{{project}}` → project name
• `{{branch}}` → current branch
• `{{hash}}` → commit hash

Pipe full context to any LLM CLI.

---

**Tweet 5: XDG-Compliant + Env Overrides**

Lock storage:
• `"auto"` → XDG_RUNTIME_DIR or /tmp
• `"local"` → .agentguard/locks/
• `"xdg"` → XDG_RUNTIME_DIR/agentguard/

Env overrides:
• AGENTGUARD_LOCK_DIR
• AGENTGUARD_PROJECT
• AGENTGUARD_RUNNERS

Zero-config or full control.

---

**Tweet 6: Phase Support**

Commit vs push runners:

• commit → build, lint, haiku review (fast)
• push → tests, opus review (thorough)
• both → critical security checks

Optimize for speed without sacrificing quality.

---

**Tweet 7: E2E Tested**

23 E2E + stress tests covering:
• Lock/lease cycle
• Runner execution
• Template expansion
• Phase filtering
• Concurrent access
• XDG compliance

Real git repos, real hooks, real edge cases.

---

**Tweet 8: Open Source**

Available now:

📦 `npm install -g agentguard`
⚙️ `npx agentguard init`
🔒 Commit → blocked until validated
🤖 Pipe diff to any LLM

GitHub: [link]

Built this because I kept shipping broken code and got tired of it.

---

**Tweet 9: The Meta**

Built with Claude using team mode + agentguard v2.

The agent that helped me build it now:
• Forces itself to validate before committing
• Runs haiku on commits, opus on pushes
• Pipes diffs to Claude for self-review

Software building software that forces software to be better.

Wild.
