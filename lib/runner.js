#!/usr/bin/env node
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

/**
 * LLM Steering Markers
 * When a runner has llm: true, we wrap its prompt with these markers
 * and parse the structured response between them.
 */
const LLM_START = '<AGENTGUARD_START>';
const LLM_END = '<AGENTGUARD_END>';

/**
 * Runner engine for agentguard
 *
 * Runners are abstract CLI commands with a simple contract:
 *   - exit 0 = pass
 *   - exit 1 = fail
 *   - stdout = review text (captured for audit trail)
 *
 * Template variables:
 *   {{diff}}     → git diff output (--cached for commit, origin..HEAD for push)
 *   {{files}}    → staged files list
 *   {{project}}  → project name
 *   {{branch}}   → current git branch
 *   {{hash}}     → current commit hash (or "new")
 *
 * Agentic runners (examples):
 *   claude -p "Review this diff: {{diff}}"
 *   codex -q "Check for issues: {{diff}}"
 *   ollama run llama3 "Review: {{diff}}"
 */

function getGitContext() {
  const ctx = {
    diff: '',
    diffPush: '',
    files: '',
    filesPush: '',
    branch: '',
    hash: 'new',
    topic: '',
    args: ''
  };

  try {
    ctx.diff = execSync('git diff --cached', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch (e) {}

  try {
    ctx.diffPush = execSync('git diff origin/main...HEAD', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch (e) {
    try {
      ctx.diffPush = execSync('git diff origin/master...HEAD', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
    } catch (e2) {}
  }

  try {
    ctx.files = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim().split('\n').filter(f => f).join(' ');
  } catch (e) {}

  try {
    ctx.filesPush = execSync('git diff origin/main...HEAD --name-only', { encoding: 'utf8' }).trim().split('\n').filter(f => f).join(' ');
  } catch (e) {
    try {
      ctx.filesPush = execSync('git diff origin/master...HEAD --name-only', { encoding: 'utf8' }).trim().split('\n').filter(f => f).join(' ');
    } catch (e2) {}
  }

  try {
    ctx.branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {}

  try {
    ctx.hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {}

  return ctx;
}

/**
 * Get context for a specific topic with args
 * @param {string} topic - Topic name (e.g., 'pre-commit', 'pre-push', 'custom')
 * @param {string[]} args - Additional arguments
 * @returns {object} Context with topic and args populated
 */
function getContextForTopic(topic, args = []) {
  const base = getGitContext();
  base.topic = topic;
  base.args = args.join(' ');
  return base;
}

/**
 * Expand template variables in command string
 * Supports: {{diff}}, {{files}}, {{project}}, {{branch}}, {{hash}}, {{topic}}, {{args}}, {{env:VAR}}
 */
function expandCommand(command, context, projectName, phase = 'commit') {
  const diff = phase === 'push' ? context.diffPush : context.diff;
  const files = phase === 'push' ? (context.filesPush || context.files) : context.files;

  return command
    .replace(/\{\{diff\}\}/g, diff)
    .replace(/\{\{files\}\}/g, files)
    .replace(/\{\{project\}\}/g, projectName)
    .replace(/\{\{branch\}\}/g, context.branch)
    .replace(/\{\{hash\}\}/g, context.hash)
    .replace(/\{\{topic\}\}/g, context.topic || '')
    .replace(/\{\{args\}\}/g, context.args || '')
    .replace(/\{\{env:([^}]+)\}\}/g, (_, varName) => process.env[varName] || '');
}

/**
 * Parse LLM runner output that uses steering markers.
 * Expected format between markers:
 *   VERDICT: PASS | FAIL
 *   CRITICAL: <count>
 *   HIGH: <count>
 *   MEDIUM: <count>
 *   LOW: <count>
 *   FINDINGS:
 *   - <finding 1>
 *   - <finding 2>
 *   SUMMARY: <one line>
 *
 * @param {string} output - Raw output from LLM runner
 * @returns {object} { verdict, critical, high, medium, low, findings, summary, raw }
 */
function parseLLMOutput(output) {
  const result = {
    verdict: null,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    findings: [],
    summary: '',
    raw: output
  };

  // Extract content between markers
  const startIdx = output.indexOf(LLM_START);
  const endIdx = output.indexOf(LLM_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // No markers found - treat entire output as unstructured
    result.summary = output.trim().split('\n')[0] || '';
    return result;
  }

  const structured = output.slice(startIdx + LLM_START.length, endIdx).trim();
  let inFindings = false;

  for (const line of structured.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('VERDICT:')) {
      result.verdict = trimmed.replace('VERDICT:', '').trim().toUpperCase();
      inFindings = false;
    } else if (trimmed.startsWith('CRITICAL:')) {
      result.critical = parseInt(trimmed.replace('CRITICAL:', '').trim(), 10) || 0;
      inFindings = false;
    } else if (trimmed.startsWith('HIGH:')) {
      result.high = parseInt(trimmed.replace('HIGH:', '').trim(), 10) || 0;
      inFindings = false;
    } else if (trimmed.startsWith('MEDIUM:')) {
      result.medium = parseInt(trimmed.replace('MEDIUM:', '').trim(), 10) || 0;
      inFindings = false;
    } else if (trimmed.startsWith('LOW:')) {
      result.low = parseInt(trimmed.replace('LOW:', '').trim(), 10) || 0;
      inFindings = false;
    } else if (trimmed.startsWith('FINDINGS:')) {
      inFindings = true;
    } else if (trimmed.startsWith('SUMMARY:')) {
      result.summary = trimmed.replace('SUMMARY:', '').trim();
      inFindings = false;
    } else if (inFindings && trimmed.startsWith('-')) {
      result.findings.push(trimmed.slice(1).trim());
    }
  }

  return result;
}

/**
 * Execute a single runner
 *
 * Returns: { name, command, passed, output, error, duration }
 */
function executeRunner(runner, context, projectName, phase = 'commit') {
  const start = Date.now();
  const expandedCommand = expandCommand(runner.command, context, projectName, phase);

  // Merge env vars
  const env = { ...process.env, ...runner.env };

  // If command contains {{diff}} and diff is huge, use stdin instead
  const usesInlineDiff = runner.command.includes('{{diff}}');
  let finalCommand = expandedCommand;
  let input = undefined;

  // For very large diffs, pass via stdin to avoid arg length limits
  const diffContent = phase === 'push' ? context.diffPush : context.diff;
  if (usesInlineDiff && diffContent.length > 100000) {
    // Replace inline diff with stdin marker
    finalCommand = runner.command.replace(/\{\{diff\}\}/g, '$(cat)');
    input = diffContent;
  }

  try {
    const result = spawnSync('bash', ['-c', finalCommand], {
      encoding: 'utf8',
      env,
      input,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 600000 // 10 min max
    });

    const output = (result.stdout || '') + (result.stderr || '');
    const passed = result.status === 0;

    const trimmedOutput = output.trim();
    const result_obj = {
      name: runner.name,
      command: runner.command,
      expandedCommand: finalCommand,
      passed,
      output: trimmedOutput,
      error: passed ? null : `Exit code ${result.status}`,
      duration: Date.now() - start
    };

    // Add proof capture
    result_obj.proof = {
      summary: (trimmedOutput || '').split('\n').filter(l => l.trim()).slice(0, 1).join(''),
      hash: crypto.createHash('sha256').update(trimmedOutput || '').digest('hex').slice(0, 7),
      output: (trimmedOutput || '').slice(0, 10000)
    };

    // Parse LLM output if runner is an LLM runner
    if (runner.llm) {
      result_obj.llmParsed = parseLLMOutput(trimmedOutput);
      // Override passed based on LLM verdict if present
      if (result_obj.llmParsed.verdict) {
        result_obj.passed = result_obj.llmParsed.verdict === 'PASS';
      }
    }

    return result_obj;
  } catch (e) {
    const emptyOutput = '';
    const result_obj = {
      name: runner.name,
      command: runner.command,
      expandedCommand: finalCommand,
      passed: false,
      output: emptyOutput,
      error: e.message,
      duration: Date.now() - start
    };

    // Add proof capture
    result_obj.proof = {
      summary: '',
      hash: crypto.createHash('sha256').update(emptyOutput).digest('hex').slice(0, 7),
      output: ''
    };

    return result_obj;
  }
}

/**
 * Run all runners for a given phase (commit or push)
 *
 * Returns: { allPassed, results, totalDuration }
 */
function runRunners(runners, projectName, phase = 'commit') {
  const context = getGitContext();
  const results = [];
  const start = Date.now();

  // Filter runners for this phase
  const phaseRunners = runners.filter(r => {
    const on = r.on || 'commit';
    return on === phase || on === 'both';
  });

  if (phaseRunners.length === 0) {
    return { allPassed: true, results: [], totalDuration: 0 };
  }

  let allPassed = true;

  for (const runner of phaseRunners) {
    const result = executeRunner(runner, context, projectName, phase);
    results.push(result);

    if (!result.passed) {
      allPassed = false;
      break; // Stop on first failure
    }
  }

  return {
    allPassed,
    results,
    totalDuration: Date.now() - start
  };
}

/**
 * Format runner results for display
 */
function formatResults(results) {
  const lines = [];
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    const time = `(${(r.duration / 1000).toFixed(1)}s)`;
    lines.push(`  ${icon} ${r.name}: ${r.command} ${time}`);

    // Show LLM parsed output for LLM runners
    if (r.llmParsed) {
      const lp = r.llmParsed;
      if (lp.verdict) lines.push(`     Verdict: ${lp.verdict}`);
      if (lp.critical > 0) lines.push(`     Critical: ${lp.critical}`);
      if (lp.high > 0) lines.push(`     High: ${lp.high}`);
      if (lp.medium > 0) lines.push(`     Medium: ${lp.medium}`);
      if (lp.low > 0) lines.push(`     Low: ${lp.low}`);
      if (lp.findings.length > 0) {
        lines.push('     Findings:');
        lp.findings.forEach(f => lines.push(`       - ${f}`));
      }
      if (lp.summary) lines.push(`     Summary: ${lp.summary}`);
    } else if (r.output && (r.command.includes('claude') || r.command.includes('codex') || !r.passed)) {
      // Show output for agentic runners or on failure
      const outputLines = r.output.split('\n').slice(0, 20); // First 20 lines
      outputLines.forEach(l => lines.push(`     ${l}`));
      if (r.output.split('\n').length > 20) {
        lines.push('     ... (output truncated)');
      }
    }
  }
  return lines.join('\n');
}

module.exports = {
  getGitContext,
  getContextForTopic,
  expandCommand,
  executeRunner,
  runRunners,
  formatResults,
  parseLLMOutput,
  LLM_START,
  LLM_END
};
