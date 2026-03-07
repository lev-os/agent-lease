#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = '.agentguard.json';

/**
 * Known git hooks that agentguard can intercept.
 * Used for routing and validation.
 */
const KNOWN_GIT_HOOKS = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-push',
  'pre-rebase',
  'post-checkout',
  'post-merge'
];

/**
 * Check if a topic corresponds to a git hook
 * @param {string} topic
 * @returns {boolean}
 */
function isGitHook(topic) {
  return KNOWN_GIT_HOOKS.includes(topic);
}

/**
 * Lock directory resolution (priority order):
 * 1. AGENTGUARD_LOCK_DIR env var
 * 2. Config file lockDir
 * 3. "local" mode: <project>/.agentguard/locks/
 * 4. XDG_RUNTIME_DIR/agentguard/
 * 5. /tmp (fallback)
 */
function resolveLockDir(config, projectRoot) {
  // Env var always wins
  if (process.env.AGENTGUARD_LOCK_DIR) {
    return process.env.AGENTGUARD_LOCK_DIR;
  }

  const configLockDir = config.lockDir || 'auto';

  if (configLockDir === 'local') {
    return path.join(projectRoot, '.agentguard', 'locks');
  }

  if (configLockDir === 'auto' || configLockDir === 'xdg') {
    const xdg = process.env.XDG_RUNTIME_DIR;
    if (xdg) return path.join(xdg, 'agentguard');
  }

  if (configLockDir !== 'auto' && configLockDir !== 'xdg') {
    return configLockDir; // Custom absolute path
  }

  return '/tmp';
}

/**
 * Runner = any CLI command with contract:
 *   exit 0 = pass, exit 1 = fail, stdout = review text
 *
 * Runner config format:
 *   { name, command, on?, env? }
 *
 * "on" controls when runner fires: "commit" | "push" | "both" (default: "commit")
 * "env" is extra env vars passed to the runner process
 *
 * Built-in template variables in command strings:
 *   {{diff}}        → git diff --cached (for commit) or git diff origin..HEAD (for push)
 *   {{files}}       → space-separated list of staged files
 *   {{project}}     → project name
 *   {{branch}}      → current branch
 */
const DEFAULT_RUNNERS = [
  { name: 'build', command: 'npm run build', on: 'commit' },
  { name: 'lint', command: 'npm run lint', on: 'commit' }
];

const DEFAULT_CONFIG = {
  runners: null, // Falls back to DEFAULT_RUNNERS
  lockDir: 'auto', // "auto" | "local" | "xdg" | "/custom/path"
  projectName: null,
  bypassWarning: true,
  // Legacy compat: "validation" key maps to runners
  validation: null
};

function findProjectRoot(startDir = process.cwd()) {
  // Use git to find canonical project root (handles macOS /var vs /private/var)
  try {
    const { execSync } = require('child_process');
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      cwd: startDir
    }).trim();
    return root;
  } catch (e) {}

  // Fallback: walk up looking for .git
  let dir = fs.realpathSync(startDir);
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

function getProjectName(projectRoot) {
  if (process.env.AGENTGUARD_PROJECT) return process.env.AGENTGUARD_PROJECT;

  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) return pkg.name.replace(/[^a-zA-Z0-9-_]/g, '-');
    } catch (e) {}
  }
  return path.basename(projectRoot);
}

/**
 * Normalize runners from config.
 * Supports:
 *   - New format: { runners: [{ name, command, on }] }
 *   - Legacy format: { validation: { build: "cmd", lint: "cmd" } }
 *   - Env override: AGENTGUARD_RUNNERS="build:npm run build,lint:npm run lint"
 */
function normalizeRunners(config) {
  // Env var override
  if (process.env.AGENTGUARD_RUNNERS) {
    return process.env.AGENTGUARD_RUNNERS.split(',').map(entry => {
      const [name, ...rest] = entry.split(':');
      return { name: name.trim(), command: rest.join(':').trim(), on: 'commit' };
    });
  }

  // New format: top-level runners array
  if (config.runners && Array.isArray(config.runners)) {
    return config.runners.map(r => ({
      name: r.name || 'unnamed',
      command: r.command,
      on: r.on || 'commit',
      env: r.env || {},
      llm: r.llm || false,
      steeringPrompt: r.steeringPrompt || null
    }));
  }

  // v4 topics format: extract runners from topics and dedupe
  if (config.topics && typeof config.topics === 'object') {
    const allRunners = [];
    const seen = new Set();
    for (const [topicName, topicConfig] of Object.entries(config.topics)) {
      const topicRunners = topicConfig.runners || topicConfig || [];
      if (Array.isArray(topicRunners)) {
        for (const r of topicRunners) {
          if (typeof r === 'object' && r.name && r.command) {
            if (!seen.has(r.name)) {
              seen.add(r.name);
              // Map topic to legacy 'on' field
              const on = topicName === 'pre-commit' ? 'commit' :
                         topicName === 'pre-push' ? 'push' :
                         topicName;
              allRunners.push({
                name: r.name,
                command: r.command,
                on,
                env: r.env || {},
                llm: r.llm || false,
                steeringPrompt: r.steeringPrompt || null
              });
            }
          }
        }
      }
    }
    if (allRunners.length > 0) {
      return allRunners;
    }
  }

  // Legacy format
  if (config.validation && typeof config.validation === 'object') {
    return Object.entries(config.validation)
      .filter(([, cmd]) => cmd)
      .map(([name, command]) => ({ name, command, on: 'commit', env: {} }));
  }

  return [...DEFAULT_RUNNERS];
}

/**
 * Load config with chain resolution:
 * 1. CLI-provided config path (highest priority)
 * 2. .agentguard/config.json
 * 3. package.json["agentguard"]
 * 4. .agentguard.json (legacy, lowest priority)
 *
 * @param {string|null} projectRoot - Project root directory
 * @param {string|null} cliConfigPath - Config path from CLI --config flag
 * @returns {{ config: object, projectRoot: string, configSource: string }}
 */
function loadConfigChain(projectRoot = null, cliConfigPath = null) {
  const root = projectRoot || findProjectRoot();
  let config = { ...DEFAULT_CONFIG };
  let configSource = 'default';

  // Priority 1: CLI-provided config path
  if (cliConfigPath) {
    const absPath = path.isAbsolute(cliConfigPath) ? cliConfigPath : path.join(root, cliConfigPath);
    if (fs.existsSync(absPath)) {
      try {
        const userConfig = JSON.parse(fs.readFileSync(absPath, 'utf8'));
        config = { ...config, ...userConfig };
        configSource = absPath;
      } catch (e) {
        console.error(`Warning: Could not parse config at ${absPath}`);
      }
    }
  }

  // Priority 2: .agentguard/config.json
  if (configSource === 'default') {
    const dirConfigPath = path.join(root, '.agentguard', 'config.json');
    if (fs.existsSync(dirConfigPath)) {
      try {
        const userConfig = JSON.parse(fs.readFileSync(dirConfigPath, 'utf8'));
        config = { ...config, ...userConfig };
        configSource = dirConfigPath;
      } catch (e) {
        console.error(`Warning: Could not parse ${dirConfigPath}`);
      }
    }
  }

  // Priority 3: package.json["agentguard"]
  if (configSource === 'default') {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg['agentguard'] && typeof pkg['agentguard'] === 'object') {
          config = { ...config, ...pkg['agentguard'] };
          configSource = 'package.json';
        }
      } catch (e) {}
    }
  }

  // Priority 4: .agentguard.json (legacy)
  if (configSource === 'default') {
    const legacyPath = path.join(root, CONFIG_FILE);
    if (fs.existsSync(legacyPath)) {
      try {
        const userConfig = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        config = { ...config, ...userConfig };
        configSource = legacyPath;
      } catch (e) {
        console.error(`Warning: Could not parse ${CONFIG_FILE}`);
      }
    }
  }

  // Flatten 'defaults' into top-level config (v4 format uses defaults.lockDir etc.)
  if (config.defaults && typeof config.defaults === 'object') {
    for (const [key, value] of Object.entries(config.defaults)) {
      if (config[key] === undefined || config[key] === DEFAULT_CONFIG[key]) {
        config[key] = value;
      }
    }
  }

  // Auto-migrate old config format if needed
  config = migrateConfig(config);

  if (!config.projectName) {
    config.projectName = getProjectName(root);
  }

  // Merge proof defaults if not present
  const defaultProof = { capture: true, archive: true, maxLength: 10000 };
  config.proof = { ...defaultProof, ...(config.proof || {}) };

  // Merge trailers defaults if not present
  const defaultTrailers = { proof: 'agentguard-proof', duration: 'agentguard-duration', report: 'agentguard-report' };
  config.trailers = { ...defaultTrailers, ...(config.trailers || {}) };

  // Resolve lock dir
  config.lockDir = resolveLockDir(config, root);

  // Normalize runners
  config._runners = normalizeRunners(config);

  return { config, projectRoot: root, configSource };
}

/**
 * Migrate old config format (runners[].on) to new topics format
 * Old: { runners: [{ name, command, on: 'commit' }] }
 * New: { topics: { 'pre-commit': ['build', 'lint'], 'pre-push': ['review'] }, runners: [...] }
 *
 * @param {object} oldConfig
 * @returns {object} Migrated config
 */
function migrateConfig(oldConfig) {
  // If already has topics, no migration needed
  if (oldConfig.topics && typeof oldConfig.topics === 'object') {
    return oldConfig;
  }

  // If no runners, nothing to migrate
  if (!oldConfig.runners || !Array.isArray(oldConfig.runners)) {
    return oldConfig;
  }

  // Check if any runner uses 'on' field
  const hasOldFormat = oldConfig.runners.some(r => r.on);
  if (!hasOldFormat) {
    return oldConfig;
  }

  // Build topics from runners[].on
  const topics = {};
  for (const runner of oldConfig.runners) {
    const on = runner.on || 'commit';
    // Map old 'commit'/'push' to git hook names
    const topicName = on === 'commit' ? 'pre-commit' :
                      on === 'push' ? 'pre-push' :
                      on === 'both' ? null : on;

    if (topicName === null) {
      // 'both' means add to both pre-commit and pre-push
      if (!topics['pre-commit']) topics['pre-commit'] = [];
      if (!topics['pre-push']) topics['pre-push'] = [];
      topics['pre-commit'].push(runner.name);
      topics['pre-push'].push(runner.name);
    } else {
      if (!topics[topicName]) topics[topicName] = [];
      topics[topicName].push(runner.name);
    }
  }

  return { ...oldConfig, topics };
}

/**
 * Get runners configured for a specific topic
 * @param {object} config - Loaded config
 * @param {string} topic - Topic name (e.g., 'pre-commit', 'pre-push', 'custom-check')
 * @returns {Array} Array of runner objects
 */
function getRunnersForTopic(config, topic) {
  const allRunners = config._runners || [];

  // If config has topics mapping, use it
  if (config.topics && config.topics[topic]) {
    let runnerNames = config.topics[topic];
    // Support both flat array format and object format { runners: [...] }
    if (runnerNames && !Array.isArray(runnerNames) && runnerNames.runners) {
      runnerNames = runnerNames.runners.map(r => typeof r === 'string' ? r : r.name);
    }
    if (Array.isArray(runnerNames)) {
      return allRunners.filter(r => runnerNames.includes(r.name));
    }
  }

  // Fallback: use legacy 'on' field matching
  // Map topic to legacy 'on' value
  const legacyOn = topic === 'pre-commit' ? 'commit' :
                   topic === 'pre-push' ? 'push' :
                   topic;

  return allRunners.filter(r => {
    const on = r.on || 'commit';
    return on === legacyOn || on === 'both';
  });
}

/**
 * Load template for a topic from various locations
 * Priority: CLI path > .agentguard/{topic}.md > built-in default
 *
 * @param {string} topic - Topic name
 * @param {string} templateDir - Base template directory (.agentguard/ by default)
 * @param {string|null} cliTemplatePath - Template path from CLI --template flag
 * @returns {string} Template content
 */
function loadTopicTemplate(topic, templateDir, cliTemplatePath = null) {
  // Priority 1: CLI-provided template path
  if (cliTemplatePath) {
    if (fs.existsSync(cliTemplatePath)) {
      return fs.readFileSync(cliTemplatePath, 'utf8');
    }
  }

  // Priority 2: Topic-specific template in templateDir
  const topicTemplatePath = path.join(templateDir, `${topic}.md`);
  if (fs.existsSync(topicTemplatePath)) {
    return fs.readFileSync(topicTemplatePath, 'utf8');
  }

  // Priority 3: Map git hook topics to legacy phase templates
  if (topic === 'pre-commit') {
    const commitPath = path.join(templateDir, 'commit.md');
    if (fs.existsSync(commitPath)) {
      return fs.readFileSync(commitPath, 'utf8');
    }
    return DEFAULT_COMMIT_TEMPLATE;
  }

  if (topic === 'pre-push') {
    const pushPath = path.join(templateDir, 'push.md');
    if (fs.existsSync(pushPath)) {
      return fs.readFileSync(pushPath, 'utf8');
    }
    return DEFAULT_PUSH_TEMPLATE;
  }

  // Priority 4: Default template in templateDir
  const defaultPath = path.join(templateDir, 'default.md');
  if (fs.existsSync(defaultPath)) {
    return fs.readFileSync(defaultPath, 'utf8');
  }

  // Priority 5: Generic fallback template (inline to avoid double-replace bug)
  return `# ${topic} Validation Gate

## Checklist
- [ ] Verified all requirements for this gate

## Changed Files
{{files}}

## Runners
{{runners}}

When everything checks out:
  npx agentguard lease ${topic} --audit-proof='<describe what you validated>'
`;
}

function loadConfig(projectRoot = null) {
  // Delegate to loadConfigChain for backward compatibility
  const { config, projectRoot: root } = loadConfigChain(projectRoot, null);
  return { config, projectRoot: root };
}

function saveConfig(config, projectRoot = null) {
  const root = projectRoot || findProjectRoot();
  const configPath = path.join(root, CONFIG_FILE);
  // Don't persist internal fields
  const { _runners, ...persistable } = config;
  fs.writeFileSync(configPath, JSON.stringify(persistable, null, 2) + '\n');
}

function createDefaultConfig(projectRoot = null) {
  const root = projectRoot || findProjectRoot();
  const config = {
    lockDir: 'auto',
    projectName: getProjectName(root),
    runners: [
      { name: 'build', command: 'npm run build', on: 'commit' },
      { name: 'lint', command: 'npm run lint', on: 'commit' }
    ],
    proof: {
      capture: true,
      archive: true,
      maxLength: 10000
    },
    trailers: {
      proof: 'agentguard-proof',
      duration: 'agentguard-duration',
      report: 'agentguard-report'
    }
  };
  saveConfig(config, root);
  return config;
}

// --- Template System ---

const DEFAULT_COMMIT_TEMPLATE = `# Commit Validation Gate

## Standards Check
- [ ] Did you update docs if you changed public APIs?
- [ ] Did you add tests for new functionality?
- [ ] No console.log in production code?
- [ ] Following conventional commits?

## Changed Files
{{files}}

## Runners
{{runners}}

When everything checks out:
  npx agentguard commit --audit-proof='<describe what you validated>'
`;

const DEFAULT_PUSH_TEMPLATE = `# Push Validation Gate

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
  npx agentguard push --audit-proof='<describe what you validated>'
`;

/**
 * Load a template for a given phase from .agentguard/{phase}.md
 * Falls back to the built-in default if the file doesn't exist.
 */
function loadTemplate(phase, projectRoot) {
  const templatePath = path.join(projectRoot, '.agentguard', `${phase}.md`);
  try {
    if (fs.existsSync(templatePath)) {
      return fs.readFileSync(templatePath, 'utf8');
    }
  } catch (e) {}

  if (phase === 'push') return DEFAULT_PUSH_TEMPLATE;
  return DEFAULT_COMMIT_TEMPLATE;
}

/**
 * Interpolate template variables.
 * Supported: {{diff}}, {{files}}, {{project}}, {{branch}}, {{hash}}, {{runners}},
 *            {{topic}}, {{args}}, {{env:VAR_NAME}}
 *
 * @param {string} template - Template string with {{var}} placeholders
 * @param {object} context - Git context from getGitContext()
 * @param {object} config - Loaded config (needs config._runners)
 * @param {object} [extra] - Extra context: { topic, args }
 */
function interpolateTemplate(template, context, config, extra = {}) {
  const runners = config._runners || [];
  const runnersFormatted = runners.map(r => {
    const phase = r.on || 'commit';
    return `  ${r.name}    ${r.command}    [${phase}]`;
  }).join('\n');

  // Use topic-aware diff and files: push topics get push-specific data
  const isPush = extra.topic === 'pre-push' || extra.topic === 'push';
  const diff = isPush ? (context.diffPush || context.diff || '') : (context.diff || '');
  const files = isPush ? (context.filesPush || context.files || '') : (context.files || '');

  let result = template
    .replace(/\{\{diff\}\}/g, diff)
    .replace(/\{\{files\}\}/g, files)
    .replace(/\{\{project\}\}/g, config.projectName || '')
    .replace(/\{\{branch\}\}/g, context.branch || '')
    .replace(/\{\{hash\}\}/g, context.hash || '')
    .replace(/\{\{runners\}\}/g, runnersFormatted)
    .replace(/\{\{topic\}\}/g, extra.topic || '')
    .replace(/\{\{args\}\}/g, Array.isArray(extra.args) ? extra.args.join(' ') : (extra.args || ''));

  // Replace {{env:VAR_NAME}} with environment variable values
  result = result.replace(/\{\{env:([^}]+)\}\}/g, (match, varName) => {
    return process.env[varName] || '';
  });

  return result;
}

module.exports = {
  loadConfig,
  loadConfigChain,
  migrateConfig,
  getRunnersForTopic,
  isGitHook,
  loadTopicTemplate,
  saveConfig,
  createDefaultConfig,
  findProjectRoot,
  getProjectName,
  resolveLockDir,
  normalizeRunners,
  loadTemplate,
  interpolateTemplate,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  DEFAULT_RUNNERS,
  DEFAULT_COMMIT_TEMPLATE,
  DEFAULT_PUSH_TEMPLATE,
  KNOWN_GIT_HOOKS
};
