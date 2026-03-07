#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { loadConfig, loadConfigChain, loadTemplate, loadTopicTemplate, interpolateTemplate, createDefaultConfig, findProjectRoot, getRunnersForTopic, isGitHook, DEFAULT_COMMIT_TEMPLATE, DEFAULT_PUSH_TEMPLATE } = require('../lib/config');
const {
  checkLock,
  createLock,
  releaseLock,
  releaseLockWithAgentProof,
  clearAllLocks,
  archiveLock
} = require('../lib/lock-manager');
const { getGitContext, runRunners, formatResults } = require('../lib/runner');

const HELP = `
agentguard - Forced validation gates for git hooks and custom topics

COMMANDS:
  init                      Install hooks to current project
  lease <topic> [args]      Gate check for any topic (v4.0 unified command)
  lease <topic> --audit-proof='<proof>'  Release lock with proof
  commit                    Alias for: lease pre-commit
  push                      Alias for: lease pre-push
  release --audit-proof     Run all runners + release lock (v2 mode, legacy)
  release --audit-proof='<proof>'  Accept agent proof text (v3.2 mode, legacy)
  status                    Check current lock state
  clear                     Remove all locks for this project
  runners                   List configured runners
  help                      Show this message

OPTIONS:
  --config <path>           Config file path (overrides auto-detection)
  --template <path>         Template file path for gate message
  --template-dir <path>     Directory containing topic templates
  --lock-dir <path>         Override lock directory
  --topic <name>            Which topic to check (for status/clear commands)
  --report <json>           Attach manual report data to proof archive
  --report-stdin            Read report data from stdin

ENV VARS:
  AGENTGUARD_LOCK_DIR      Override lock directory
  AGENTGUARD_PROJECT       Override project name
  AGENTGUARD_RUNNERS       Override runners (name:cmd,name:cmd)

CONFIG RESOLUTION (priority):
  1. --config CLI flag
  2. .agentguard/config.json
  3. package.json["agentguard"]
  4. .agentguard.json (legacy)

RUNNER CONFIG:
  {
    "topics": {
      "pre-commit": ["build", "lint"],
      "pre-push": ["review"],
      "custom-check": ["security-scan"]
    },
    "runners": [
      { "name": "build", "command": "npm run build" },
      { "name": "lint", "command": "npm run lint" },
      { "name": "review", "command": "claude -p 'Review: {{diff}}'" },
      { "name": "security-scan", "command": "npm audit" }
    ],
    "lockDir": "auto"
  }

LOCK DIRS (priority):
  1. AGENTGUARD_LOCK_DIR env var
  2. --lock-dir CLI flag
  3. "local" → .agentguard/locks/ (project-local)
  4. "xdg"   → $XDG_RUNTIME_DIR/agentguard/
  5. "auto"  → XDG if available, else /tmp

TEMPLATE VARS:
  {{diff}}        git diff (staged for commit, branch for push)
  {{files}}       staged file list
  {{project}}     project name
  {{branch}}      current branch
  {{hash}}        current commit hash
  {{topic}}       current topic name
  {{args}}        additional arguments passed to lease
  {{env:VAR}}     environment variable value

EXAMPLES:
  # Traditional validation
  agentguard commit                     # Block commit, show gate
  agentguard commit --audit-proof='...' # Release with proof

  # Unified lease command (v4.0)
  agentguard lease pre-commit           # Same as 'commit'
  agentguard lease pre-push             # Same as 'push'
  agentguard lease custom-check arg1    # Custom topic with args

  # Check status by topic
  agentguard status --topic pre-commit

FOR AI AGENTS:
  Agents read the blocked output and run the release command automatically.
`;

function createWrapperScript(args) {
  const escapedArgs = args.join(' ');
  const fallback = `${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} ${escapedArgs} "$@"`;
  return `#!/bin/bash
if command -v agentguard >/dev/null 2>&1; then
  exec agentguard ${escapedArgs} "$@"
fi
exec ${fallback}
`;
}

function cmd_init() {
  const root = findProjectRoot();
  const gitDir = path.join(root, '.git');

  if (!fs.existsSync(gitDir)) {
    console.error('Error: Not a git repository. Run `git init` first.');
    process.exit(1);
  }

  // Check if husky is present
  const huskyDir = path.join(root, '.husky');
  const hasHusky = fs.existsSync(huskyDir);

  const sourceHooksDir = path.join(__dirname, '..', 'hooks');

  if (hasHusky) {
    // Husky mode: create wrapper hooks using v4 lease command
    console.log('  Detected husky - installing wrapper hooks');

    const huskyHooks = {
      'pre-commit': createWrapperScript(['lease', 'pre-commit']),
      'pre-push': createWrapperScript(['lease', 'pre-push']),
      // prepare-commit-msg is NOT a gate - it extracts trailers from the lock file
      'prepare-commit-msg': createWrapperScript(['--hook', 'prepare-commit-msg'])
    };

    for (const [hook, content] of Object.entries(huskyHooks)) {
      const dest = path.join(huskyDir, hook);
      fs.writeFileSync(dest, content);
      fs.chmodSync(dest, '755');
      console.log(`  + Installed .husky/${hook}`);
    }
  } else {
    // Direct mode: write wrappers for gate hooks and copy the commit-msg trailer hook.
    const hooksDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    for (const hook of ['pre-commit', 'pre-push', 'prepare-commit-msg']) {
      const dest = path.join(hooksDir, hook);

      if (fs.existsSync(dest)) {
        const backup = `${dest}.agentguard-backup`;
        fs.copyFileSync(dest, backup);
        console.log(`  Backed up existing ${hook} -> ${hook}.agentguard-backup`);
      }

      if (hook === 'prepare-commit-msg') {
        const src = path.join(sourceHooksDir, hook);
        if (!fs.existsSync(src)) {
          console.error(`Warning: ${hook} hook not found at ${src}`);
          continue;
        }
        fs.copyFileSync(src, dest);
      } else {
        const args = hook === 'pre-commit' ? ['lease', 'pre-commit'] : ['lease', 'pre-push'];
        fs.writeFileSync(dest, createWrapperScript(args));
      }
      fs.chmodSync(dest, '755');
      console.log(`  + Installed ${hook}`);
    }
  }

  // Create .agentguard directory structure
  const leaseDir = path.join(root, '.agentguard');
  if (!fs.existsSync(leaseDir)) {
    fs.mkdirSync(leaseDir, { recursive: true });
  }

  // Create .agentguard/config.json (v4 config location)
  // If legacy .agentguard.json exists, migrate its runners; otherwise use defaults
  const newConfigPath = path.join(leaseDir, 'config.json');
  if (!fs.existsSync(newConfigPath)) {
    const legacyPath = path.join(root, '.agentguard.json');
    let preCommitRunners = [
      { name: 'build', command: 'npm run build' },
      { name: 'lint', command: 'npm run lint' }
    ];
    let prePushRunners = [];
    let lockDir = 'local';

    // Migrate from legacy config if it exists
    if (fs.existsSync(legacyPath)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        if (legacy.runners && Array.isArray(legacy.runners)) {
          preCommitRunners = legacy.runners
            .filter(r => !r.on || r.on === 'commit' || r.on === 'both')
            .map(r => ({ name: r.name, command: r.command }));
          prePushRunners = legacy.runners
            .filter(r => r.on === 'push' || r.on === 'both')
            .map(r => ({ name: r.name, command: r.command }));
        }
        if (legacy.lockDir) {
          lockDir = legacy.lockDir;
        }
      } catch (e) {}
    }

    const defaultTopicConfig = {
      topics: {
        'pre-commit': { runners: preCommitRunners },
        'prepare-commit-msg': { runners: [] },
        'commit-msg': { runners: [] },
        'pre-push': { runners: prePushRunners },
        'post-commit': { runners: [] },
        'pre-rebase': { runners: [] }
      },
      defaults: {
        lockDir,
        templateDir: '.agentguard/templates'
      }
    };
    fs.writeFileSync(newConfigPath, JSON.stringify(defaultTopicConfig, null, 2) + '\n');
    console.log('  + Created .agentguard/config.json');
  }

  // Create .agentguard/templates/ directory with default templates
  const templatesDir = path.join(leaseDir, 'templates');
  if (!fs.existsSync(templatesDir)) {
    fs.mkdirSync(templatesDir, { recursive: true });
  }

  const defaultTemplates = {
    'pre-commit.md': DEFAULT_COMMIT_TEMPLATE,
    'pre-push.md': DEFAULT_PUSH_TEMPLATE,
    'default.md': `# {{topic}} Validation Gate

## Checklist
- [ ] Verified all requirements for this gate

## Context
Topic: {{topic}}

## Runners
{{runners}}

When everything checks out:
  npx agentguard lease {{topic}} --audit-proof='<describe what you validated>'
`
  };

  for (const [filename, content] of Object.entries(defaultTemplates)) {
    const templatePath = path.join(templatesDir, filename);
    if (!fs.existsSync(templatePath)) {
      fs.writeFileSync(templatePath, content);
      console.log(`  + Created .agentguard/templates/${filename}`);
    }
  }

  // Legacy: also create .agentguard.json if it doesn't exist (backward compat)
  const legacyConfigPath = path.join(root, '.agentguard.json');
  if (!fs.existsSync(legacyConfigPath)) {
    createDefaultConfig(root);
    console.log('  + Created .agentguard.json (legacy compat)');
  }

  // Add .agentguard/locks, audit, and proofs to .gitignore
  const gitignorePath = path.join(root, '.gitignore');
  const ignoreEntries = ['.agentguard/locks/', '.agentguard/audit/', '.agentguard/proofs/'];
  if (fs.existsSync(gitignorePath)) {
    let content = fs.readFileSync(gitignorePath, 'utf8');
    for (const entry of ignoreEntries) {
      if (!content.includes(entry)) {
        content += `\n${entry}`;
      }
    }
    fs.writeFileSync(gitignorePath, content);
  }

  const { config } = loadConfig(root);
  const mode = hasHusky ? 'husky' : 'direct';
  console.log('');
  console.log('agentguard installed');
  console.log(`  Mode:      ${mode}`);
  console.log(`  Config:    .agentguard/config.json`);
  console.log(`  Templates: .agentguard/templates/`);
  console.log(`  Lock dir:  ${config.lockDir}`);
  console.log(`  Runners:   ${config._runners.length} configured`);
  console.log('');
  console.log('Next commit will create a validation gate.');
  console.log('');
}

/**
 * Parse agent-submitted proof text into structured runner results (v3.2)
 * @param {string} text - The proof text from --audit-proof='...'
 * @returns {{ runners: Array<{name: string, status: string, output: string}>, summary: string }}
 */
function parseAgentProof(text) {
  // Remove wrapping quotes if present
  const clean = text.replace(/^['"]|['"]$/g, '');

  const sections = [];
  let currentRunner = null;
  let summary = '';

  for (const line of clean.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('Runner:')) {
      if (currentRunner) sections.push(currentRunner);
      currentRunner = { name: trimmed.replace('Runner:', '').trim(), status: '', output: '' };
    } else if (trimmed.startsWith('Status:') && currentRunner) {
      currentRunner.status = trimmed.replace('Status:', '').trim().toUpperCase();
    } else if (trimmed.startsWith('Output:') && currentRunner) {
      currentRunner.output = trimmed.replace('Output:', '').trim();
    } else if (trimmed.startsWith('Summary:')) {
      summary = trimmed.replace('Summary:', '').trim();
    }
  }
  if (currentRunner) sections.push(currentRunner);

  return { runners: sections, summary };
}

/**
 * Parse CLI flags from args array
 * @param {string[]} args - CLI arguments
 * @returns {{ flags: object, positional: string[] }}
 */
function parseCliFlags(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      if (arg.includes('=')) {
        const [key, ...rest] = arg.slice(2).split('=');
        flags[key] = rest.join('=').replace(/^['"]|['"]$/g, '');
      } else {
        const key = arg.slice(2);
        // Check if next arg is the value (not another flag)
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          flags[key] = args[i + 1];
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

/**
 * Unified lease handler for any topic (v4.0).
 * Topics can be git hooks (pre-commit, pre-push) or custom validation gates.
 *
 * Two modes:
 *   DENY mode:  `agentguard lease <topic>` (no --audit-proof)
 *               → Load template, print gate with forbidden header, create lock, exit 1
 *   RELEASE mode: `agentguard lease <topic> --audit-proof='<proof>'`
 *               → Validate proof, release lock, exit 0
 *
 * @param {string} topic - Topic name (e.g., 'pre-commit', 'pre-push', 'custom-check')
 * @param {string[]} args - Remaining CLI arguments
 */
function cmd_lease(topic, args) {
  const { flags, positional } = parseCliFlags(args);

  // Load config with chain resolution
  const { config, projectRoot } = loadConfigChain(null, flags.config || null);
  const { projectName } = config;

  // Resolve lock directory (CLI flag overrides config)
  const lockDir = flags['lock-dir'] || config.lockDir;

  // Resolve template directory
  const templateDir = flags['template-dir'] || path.join(projectRoot, '.agentguard');

  // Map topic to phase for lock compatibility
  const phase = topic === 'pre-commit' ? 'commit' :
                topic === 'pre-push' ? 'push' :
                topic;

  // Extract audit proof if present
  let auditProof = null;
  if (flags['audit-proof']) {
    auditProof = flags['audit-proof'] === true ? null : flags['audit-proof'];
  }

  // ----- RELEASE MODE -----
  if (auditProof) {
    const lockState = checkLock(projectName, lockDir, phase);

    if (!lockState.exists) {
      console.log(`No active ${topic} lock found. Proceeding freely.`);
      process.exit(0);
    }

    if (lockState.auditPassed) {
      // Already released - exit silently
      process.exit(0);
    }

    const parsed = parseAgentProof(auditProof);

    // Get runners for this topic
    const topicRunners = getRunnersForTopic(config, topic);
    const proofRunnerNames = parsed.runners.map(r => r.name.toLowerCase());
    const missingRunners = topicRunners.filter(r => !proofRunnerNames.includes(r.name.toLowerCase()));

    if (missingRunners.length > 0) {
      console.error('');
      console.error('INCOMPLETE PROOF - Missing runners:');
      missingRunners.forEach(r => console.error(`   - ${r.name}`));
      console.error('');
      console.error('Include validation results for all configured runners.');
      process.exit(1);
    }

    // Check for failures
    const failedRunners = parsed.runners.filter(r => r.status === 'FAIL');
    if (failedRunners.length > 0) {
      console.error('');
      console.error('PROOF INDICATES FAILURES:');
      failedRunners.forEach(r => console.error(`   - ${r.name}: ${r.output || 'FAIL'}`));
      console.error('');
      console.error('Fix the failures and resubmit proof.');
      process.exit(1);
    }

    // Accept proof
    console.log('');
    console.log('Agent proof accepted');
    console.log('');
    parsed.runners.forEach(r => {
      console.log(`  PASS ${r.name}: ${r.status}`);
      if (r.output) console.log(`    ${r.output}`);
    });
    if (parsed.summary) {
      console.log('');
      console.log(`  Summary: ${parsed.summary}`);
    }
    console.log('');

    releaseLockWithAgentProof(projectName, lockDir, auditProof, parsed, phase, {
      projectRoot
    });

    console.log(`${topic} lock released.`);
    console.log('');
    if (isGitHook(topic)) {
      console.log(`Now run your ${topic.replace('pre-', '')} again.`);
    }
    console.log('');
    process.exit(0);
  }

  // ----- DENY MODE -----
  const lockState = checkLock(projectName, lockDir, phase);

  // If lock exists with AUDIT_PROOF_PASSED, exit 0 silently
  if (lockState.exists && lockState.auditPassed) {
    process.exit(0);
  }

  // Create lock if it doesn't exist yet
  if (!lockState.exists) {
    createLock(projectName, lockDir, phase);
  }

  // Load template and interpolate with git context
  const gitContext = getGitContext();
  const template = loadTopicTemplate(topic, templateDir, flags.template || null);
  const rendered = interpolateTemplate(template, gitContext, config, {
    topic,
    args: positional
  });

  // Print the DENY gate with forbidden header
  console.error('');
  console.error('--no-verify is FORBIDDEN without explicit human approval.');
  console.error('');
  console.error(rendered);

  process.exit(1);
}

/**
 * Unified phase handler for commit/push gates.
 * Called directly by simplified hooks: `npx agentguard commit` or `npx agentguard push`
 *
 * Two modes:
 *   DENY mode:  `agentguard commit` (no --audit-proof, or --audit-proof with no value)
 *               → Load template, print gate message, create lock, exit 1
 *   RELEASE mode: `agentguard commit --audit-proof='<proof>'`
 *               → Validate proof, release lock, exit 0
 *
 * @param {string} phase - 'commit' or 'push'
 * @param {string[]} args - Remaining CLI arguments
 */
function cmd_phase(phase, args) {
  const { config, projectRoot } = loadConfig();
  const { projectName, lockDir } = config;

  // Find --audit-proof argument
  const proofArg = args.find(a => a.startsWith('--audit-proof'));

  // Extract proof value (if any)
  let auditProof = null;
  if (proofArg && proofArg.includes('=')) {
    auditProof = proofArg.split('=').slice(1).join('=');
    auditProof = auditProof.replace(/^['"]|['"]$/g, '');
    // Empty string after stripping quotes = no real value
    if (!auditProof) auditProof = null;
  }

  // ----- RELEASE MODE -----
  if (auditProof) {
    const lockState = checkLock(projectName, lockDir, phase);

    if (!lockState.exists) {
      console.log(`No active ${phase} lock found. You can ${phase} freely.`);
      process.exit(0);
    }

    if (lockState.auditPassed) {
      // Already released - exit silently
      process.exit(0);
    }

    const parsed = parseAgentProof(auditProof);

    // Validate all configured runners are represented
    const phaseRunners = config._runners.filter(r =>
      (r.on || 'commit') === phase || (r.on || 'commit') === 'both'
    );
    const proofRunnerNames = parsed.runners.map(r => r.name.toLowerCase());
    const missingRunners = phaseRunners.filter(r => !proofRunnerNames.includes(r.name.toLowerCase()));

    if (missingRunners.length > 0) {
      console.error('');
      console.error('❌ Agent proof is incomplete. Missing runners:');
      missingRunners.forEach(r => console.error(`   - ${r.name}`));
      console.error('');
      console.error('Please include validation results for all configured runners.');
      process.exit(1);
    }

    // Check for failures
    const failedRunners = parsed.runners.filter(r => r.status === 'FAIL');
    if (failedRunners.length > 0) {
      console.error('');
      console.error('❌ Agent proof indicates failures:');
      failedRunners.forEach(r => console.error(`   - ${r.name}: ${r.output || 'FAIL'}`));
      console.error('');
      console.error('Fix the failures and resubmit proof.');
      process.exit(1);
    }

    // Accept proof
    console.log('');
    console.log('🤖 Agent proof accepted');
    console.log('');
    parsed.runners.forEach(r => {
      console.log(`  ✓ ${r.name}: ${r.status}`);
      if (r.output) console.log(`    ${r.output}`);
    });
    if (parsed.summary) {
      console.log('');
      console.log(`  Summary: ${parsed.summary}`);
    }
    console.log('');

    releaseLockWithAgentProof(projectName, lockDir, auditProof, parsed, phase, {
      projectRoot
    });

    console.log(`✅ ${phase} lock released.`);
    console.log('');
    if (phase === 'commit') {
      console.log('Now run your commit again:');
      console.log('  git commit -m "your message"');
    } else {
      console.log('Now run your push again:');
      console.log('  git push');
    }
    console.log('');
    process.exit(0);
  }

  // ----- DENY MODE -----
  // (no --audit-proof, or --audit-proof with no value)

  const lockState = checkLock(projectName, lockDir, phase);

  // If lock exists with AUDIT_PROOF_PASSED, exit 0 silently
  if (lockState.exists && lockState.auditPassed) {
    process.exit(0);
  }

  // Create lock if it doesn't exist yet
  if (!lockState.exists) {
    createLock(projectName, lockDir, phase);
  }

  // Load template and interpolate with git context
  const gitContext = getGitContext();
  const template = loadTemplate(phase, projectRoot);
  const rendered = interpolateTemplate(template, gitContext, config);

  // Print the DENY gate
  console.error('⛔ --no-verify is FORBIDDEN without explicit human approval.');
  console.error('');
  console.error(rendered);

  process.exit(1);
}

function cmd_release(args) {
  // Find --audit-proof argument (may be boolean or have a value)
  const proofArg = args.find(a => a.startsWith('--audit-proof'));

  if (!proofArg) {
    console.error('Error: Must pass --audit-proof to confirm intentional release');
    console.error('Usage: agentguard release --audit-proof [--phase commit|push] [--report <json>] [--report-stdin]');
    console.error('   or: agentguard release --audit-proof=\'<proof text>\' [--phase commit|push]');
    process.exit(1);
  }

  // Determine if v3.2 mode (proof value provided) or v2 mode (boolean flag)
  let agentProof = null;
  if (proofArg.includes('=')) {
    agentProof = proofArg.split('=').slice(1).join('=');
    // Remove surrounding quotes if shell didn't strip them
    agentProof = agentProof.replace(/^['"]|['"]$/g, '');
  }

  const phaseIdx = args.indexOf('--phase');
  const phase = phaseIdx !== -1 ? args[phaseIdx + 1] : 'commit';

  if (!['commit', 'push'].includes(phase)) {
    console.error(`Error: Invalid phase '${phase}'. Must be 'commit' or 'push'.`);
    process.exit(1);
  }

  const reportIdx = args.indexOf('--report');
  const reportData = reportIdx !== -1 ? args[reportIdx + 1] : null;

  const reportStdin = args.includes('--report-stdin');
  let stdinReport = null;
  if (reportStdin) {
    try {
      stdinReport = fs.readFileSync('/dev/stdin', 'utf8');
    } catch (e) {}
  }

  const manualReport = reportData || stdinReport;

  const { config, projectRoot } = loadConfig();
  const { projectName, lockDir } = config;

  const lockState = checkLock(projectName, lockDir, phase);
  if (!lockState.exists) {
    console.log(`No active ${phase} lock found. You can ${phase} freely.`);
    return;
  }

  if (lockState.auditPassed) {
    console.log(`Lock already has audit proof. ${phase === 'commit' ? 'Commit' : 'Push'} should proceed.`);
    return;
  }

  // v3.2 mode: Agent provided proof text
  if (agentProof) {
    const parsed = parseAgentProof(agentProof);

    // Validate all configured runners are represented in the proof
    const runners = config._runners;
    const phaseRunners = runners.filter(r => (r.on || 'commit') === phase || (r.on || 'commit') === 'both');
    const proofRunnerNames = parsed.runners.map(r => r.name.toLowerCase());
    const missingRunners = phaseRunners.filter(r => !proofRunnerNames.includes(r.name.toLowerCase()));

    if (missingRunners.length > 0) {
      console.error('');
      console.error('❌ Agent proof is incomplete. Missing runners:');
      missingRunners.forEach(r => console.error(`   - ${r.name}`));
      console.error('');
      console.error('Please include validation results for all configured runners.');
      process.exit(1);
    }

    // Check if any runners failed
    const failedRunners = parsed.runners.filter(r => r.status === 'FAIL');
    if (failedRunners.length > 0) {
      console.error('');
      console.error('❌ Agent proof indicates failures:');
      failedRunners.forEach(r => console.error(`   - ${r.name}: ${r.output || 'FAIL'}`));
      console.error('');
      console.error('Fix the failures and resubmit proof.');
      process.exit(1);
    }

    console.log('');
    console.log('🤖 Agent proof accepted (v3.2 mode)');
    console.log('');
    parsed.runners.forEach(r => {
      console.log(`  ✓ ${r.name}: ${r.status}`);
      if (r.output) console.log(`    ${r.output}`);
    });
    if (parsed.summary) {
      console.log('');
      console.log(`  Summary: ${parsed.summary}`);
    }
    console.log('');

    releaseLockWithAgentProof(projectName, lockDir, agentProof, parsed, phase, {
      projectRoot
    });

    console.log(`✅ Agent proof validated. ${phase} lock released.`);
    console.log('');
    if (phase === 'commit') {
      console.log('Now run your commit again:');
      console.log('  git commit -m "your message"');
    } else {
      console.log('Now run your push again:');
      console.log('  git push');
    }
    console.log('');
    return;
  }

  // v2 mode: Run runners internally (existing behavior)
  const runners = config._runners;
  const phaseRunners = runners.filter(r => (r.on || 'commit') === phase || (r.on || 'commit') === 'both');

  console.log('');
  console.log(`🔍 Running ${phaseRunners.length} runner(s) for phase: ${phase}`);
  console.log('');

  const { allPassed, results, totalDuration } = runRunners(runners, projectName, phase);

  console.log(formatResults(results));
  console.log('');
  console.log(`  Total: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log('');

  if (!allPassed) {
    console.log('❌ Validation failed. Fix errors and try again.');
    console.log(`   Lock remains: ${lockState.lockPath}`);
    process.exit(1);
  }

  releaseLock(projectName, lockDir, results, phase, { projectRoot, manualReport });
  console.log(`✅ All runners passed. ${phase} lock released with audit proof.`);
  console.log('');
  if (phase === 'commit') {
    console.log('Now run your commit again:');
    console.log('  git commit -m "your message"');
  } else {
    console.log('Now run your push again:');
    console.log('  git push');
  }
  console.log('');
}

function cmd_status(args) {
  const { flags } = parseCliFlags(args);
  const { config } = loadConfigChain(null, flags.config || null);
  const { projectName } = config;
  const lockDir = flags['lock-dir'] || config.lockDir;

  // Support both --topic (v4) and --phase (legacy)
  const topic = flags.topic || flags.phase || null;

  // Map topic to phase for lock checking
  const mapTopicToPhase = (t) => {
    if (t === 'pre-commit') return 'commit';
    if (t === 'pre-push') return 'push';
    return t;
  };

  console.log(`Project:  ${projectName}`);
  console.log(`Lock dir: ${lockDir}`);
  console.log('');

  // Custom topic handling
  if (topic && !['commit', 'push', 'pre-commit', 'pre-push'].includes(topic)) {
    const phase = mapTopicToPhase(topic);
    const lockState = checkLock(projectName, lockDir, phase);

    console.log(`[${topic.toUpperCase()}]`);

    if (!lockState.exists) {
      console.log(`  No active lock. Gated on next attempt.`);
    } else if (lockState.auditPassed) {
      console.log(`  Lock exists with audit proof. Next run will pass.`);
    } else {
      console.log(`  Lock exists. Validation required.`);
      console.log(`     Lock: ${lockState.lockPath}`);
      if (lockState.data && lockState.data.CREATED) {
        console.log(`     Created: ${lockState.data.CREATED}`);
      }
      console.log('');
      console.log(`     Release: npx agentguard lease ${topic} --audit-proof='...'`);
    }
    console.log('');
    return;
  }

  // Check both phases if no specific topic requested
  const phasesToCheck = topic ? [mapTopicToPhase(topic)] : ['commit', 'push'];

  for (const p of phasesToCheck) {
    const lockState = checkLock(projectName, lockDir, p);
    const topicName = p === 'commit' ? 'pre-commit' : p === 'push' ? 'pre-push' : p;

    console.log(`[${topicName.toUpperCase()}]`);

    if (!lockState.exists) {
      console.log(`  No active lock. ${p === 'commit' ? 'Commits' : 'Pushes'} gated on next attempt.`);
    } else if (lockState.auditPassed) {
      console.log(`  Lock exists with audit proof. Next ${p} will pass.`);
    } else {
      console.log(`  Lock exists. Validation required before ${p}.`);
      console.log(`     Lock: ${lockState.lockPath}`);
      if (lockState.data && lockState.data.CREATED) {
        console.log(`     Created: ${lockState.data.CREATED}`);
      }
      if (lockState.data && lockState.data.REMOTE) {
        console.log(`     Remote: ${lockState.data.REMOTE}`);
      }
      console.log('');
      console.log(`     Release: npx agentguard lease ${topicName} --audit-proof='...'`);
    }
    console.log('');
  }
}

function cmd_runners() {
  const { config } = loadConfig();
  const runners = config._runners;

  console.log(`Configured runners (${runners.length}):\n`);

  for (const r of runners) {
    const phase = r.on || 'commit';
    console.log(`  [${phase}] ${r.name}`);
    console.log(`         ${r.command}`);
    if (r.env && Object.keys(r.env).length > 0) {
      console.log(`         env: ${JSON.stringify(r.env)}`);
    }
    console.log('');
  }

  console.log('Lock dir:', config.lockDir);
}

function cmd_clear(args) {
  const { flags } = parseCliFlags(args);
  const { config } = loadConfigChain(null, flags.config || null);
  const { projectName } = config;
  const lockDir = flags['lock-dir'] || config.lockDir;

  // Support both --topic (v4) and --phase (legacy)
  const topic = flags.topic || flags.phase || null;

  // Map topic to phase for lock clearing
  let phase = null;
  if (topic) {
    phase = topic === 'pre-commit' ? 'commit' :
            topic === 'pre-push' ? 'push' :
            topic;
  }

  const { cleared, paths } = clearAllLocks(projectName, lockDir, phase);

  if (cleared === 0) {
    console.log(`No ${topic ? topic + ' ' : ''}locks found to clear.`);
  } else {
    console.log(`Cleared ${cleared} ${topic ? topic + ' ' : ''}lock(s):`);
    paths.forEach(p => console.log(`  ${p}`));
  }
}

/**
 * Internal hook executor for husky integration.
 * Called via: npx agentguard --hook <hook-name> [args...]
 * This runs the bash hook scripts directly from hooks/ directory.
 */
function cmd_hook(hookName, hookArgs) {
  const { spawnSync } = require('child_process');
  const root = findProjectRoot();
  const hookPath = path.join(__dirname, '..', 'hooks', hookName);

  if (!fs.existsSync(hookPath)) {
    console.error(`Error: Hook '${hookName}' not found at ${hookPath}`);
    process.exit(1);
  }

  const result = spawnSync('bash', [hookPath, ...hookArgs], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });

  process.exit(result.status || 0);
}

// --- Main ---
const [,, command, ...args] = process.argv;

// Handle internal --hook command for husky
if (command === '--hook') {
  const hookName = args[0];
  const hookArgs = args.slice(1);
  cmd_hook(hookName, hookArgs);
} else {
  switch (command) {
    case 'init':
      cmd_init();
      break;
    case 'lease':
      // v4.0 unified command: agentguard lease <topic> [args...]
      const topic = args[0];
      if (!topic) {
        console.error('Error: lease requires a topic. Usage: agentguard lease <topic> [args...]');
        process.exit(1);
      }
      cmd_lease(topic, args.slice(1));
      break;
    case 'commit':
      // Backward compat: alias for lease pre-commit
      cmd_lease('pre-commit', args);
      break;
    case 'push':
      // Backward compat: alias for lease pre-push
      cmd_lease('pre-push', args);
      break;
    case 'release':
      cmd_release(args);
      break;
    case 'status':
      cmd_status(args);
      break;
    case 'runners':
      cmd_runners();
      break;
    case 'clear':
      cmd_clear(args);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

// Export for programmatic use (v3.2)
module.exports = {
  parseAgentProof
};
