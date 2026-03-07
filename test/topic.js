#!/usr/bin/env node
/**
 * Topic System Test Suite for agentguard v4.0
 *
 * Tests the unified lease/topic system: cmd_lease, config chain,
 * template resolution, backward compat aliases, and topic-aware locking.
 *
 * Run: node test/topic.js
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

const AGENTGUARD_BIN = path.join(__dirname, '..', 'bin', 'agentguard.js');

let testDir;
let passed = 0;
let failed = 0;

function log(msg) { console.log(msg); }
function pass(name) { passed++; log(`  PASS ${name}`); }
function fail(name, reason) { failed++; log(`  FAIL ${name}\n     ${reason}`); }

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-topic-'));
  process.chdir(testDir);
  execSync('git init -q');
  execSync('git config user.email "test@test.com"');
  execSync('git config user.name "Test"');
  fs.writeFileSync('package.json', JSON.stringify({
    name: 'topic-test',
    scripts: {
      build: 'echo build-ok',
      lint: 'echo lint-ok'
    }
  }, null, 2));
  log(`\nTest dir: ${testDir}\n`);
}

function cleanup() {
  process.chdir('/');
  fs.rmSync(testDir, { recursive: true, force: true });
}

function run(cmd, opts = {}) {
  const result = spawnSync('bash', ['-c', cmd], {
    encoding: 'utf8',
    cwd: testDir,
    env: { ...process.env, ...opts.env },
    timeout: 30000
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    output: (result.stdout || '') + (result.stderr || '')
  };
}

function agentLease(args, opts = {}) {
  return run(`node ${AGENTGUARD_BIN} ${args}`, opts);
}

function writeConfig(config) {
  // Write to v4 config location (.agentguard/config.json)
  const leaseDir = path.join(testDir, '.agentguard');
  if (!fs.existsSync(leaseDir)) fs.mkdirSync(leaseDir, { recursive: true });
  fs.writeFileSync(path.join(leaseDir, 'config.json'), JSON.stringify(config, null, 2));
}

function initProject(config) {
  // First run init to install hooks
  agentLease('init');
  // Then overwrite with our test config
  writeConfig(config);
}

function stageFile(name, content) {
  fs.writeFileSync(path.join(testDir, `${name}.txt`), content || name);
  run(`git add ${name}.txt`);
}

// ============ TESTS ============

function test_lease_deny_release() {
  log('\nTest: lease deny then release flow');

  // Explicitly set topics to control exactly which runners are expected
  initProject({
    topics: {
      'pre-commit': ['build']
    },
    runners: [{ name: 'build', command: 'echo ok' }],
    lockDir: 'local'
  });

  stageFile('deny-release');

  // DENY: lease pre-commit should block
  const deny = agentLease('lease pre-commit');
  if (deny.status === 0) {
    return fail('lease deny should exit 1', deny.output);
  }
  if (!deny.output.includes('--no-verify is FORBIDDEN')) {
    return fail('deny should show forbidden header', deny.output);
  }

  // Verify lock created
  const status = agentLease('status --topic pre-commit');
  if (!status.output.includes('Lock exists')) {
    return fail('lock should exist after deny', status.output);
  }

  // RELEASE: lease pre-commit --audit-proof should release
  const proofText = 'Runner: build\nStatus: PASS\nOutput: ok\nSummary: All good';
  const release = agentLease(`lease pre-commit --audit-proof='${proofText}'`);
  if (release.status !== 0) {
    return fail('lease release should exit 0', release.output);
  }
  if (!release.output.includes('proof accepted')) {
    return fail('should show proof accepted', release.output);
  }
  if (!release.output.includes('lock released')) {
    return fail('should show lock released', release.output);
  }

  pass('lease deny/release cycle works');
  agentLease('clear');
  run('git commit --no-verify -m "cleanup deny-release"');
}

function test_lease_arbitrary_topic() {
  log('\nTest: lease with arbitrary custom topic');

  initProject({
    topics: {
      'my-custom-gate': ['check']
    },
    runners: [{ name: 'check', command: 'echo custom-ok' }],
    lockDir: 'local'
  });

  // DENY: lease my-custom-gate should block
  const deny = agentLease('lease my-custom-gate');
  if (deny.status === 0) {
    return fail('custom topic deny should exit 1', deny.output);
  }
  if (!deny.output.includes('--no-verify is FORBIDDEN')) {
    return fail('custom topic should show forbidden header', deny.output);
  }

  // Status should show the custom topic lock
  const status = agentLease('status --topic my-custom-gate');
  if (!status.output.includes('Lock exists')) {
    return fail('custom topic lock should exist', status.output);
  }

  // RELEASE with proof
  const proofText = 'Runner: check\nStatus: PASS\nOutput: custom-ok\nSummary: Custom gate passed';
  const release = agentLease(`lease my-custom-gate --audit-proof='${proofText}'`);
  if (release.status !== 0) {
    return fail('custom topic release should exit 0', release.output);
  }

  pass('arbitrary custom topic works');
  agentLease('clear --topic my-custom-gate');
}

function test_backward_compat_commit() {
  log('\nTest: backward compat - commit command aliases lease pre-commit');

  initProject({
    topics: {
      'pre-commit': ['build']
    },
    runners: [{ name: 'build', command: 'echo ok' }],
    lockDir: 'local'
  });

  stageFile('compat-commit');

  // 'commit' command should work the same as 'lease pre-commit'
  const deny = agentLease('commit');
  if (deny.status === 0) {
    return fail('commit alias should block', deny.output);
  }
  if (!deny.output.includes('--no-verify is FORBIDDEN')) {
    return fail('commit alias should show forbidden header', deny.output);
  }

  // Release via commit alias with proof
  const proofText = 'Runner: build\nStatus: PASS\nOutput: ok\nSummary: done';
  const release = agentLease(`commit --audit-proof='${proofText}'`);
  if (release.status !== 0) {
    return fail('commit alias release should work', release.output);
  }

  pass('commit backward compat works');
  agentLease('clear');
  run('git commit --no-verify -m "cleanup compat-commit"');
}

function test_backward_compat_push() {
  log('\nTest: backward compat - push command aliases lease pre-push');

  initProject({
    runners: [{ name: 'review', command: 'echo ok', on: 'push' }],
    lockDir: 'local'
  });

  // 'push' command should work the same as 'lease pre-push'
  const deny = agentLease('push');
  if (deny.status === 0) {
    return fail('push alias should block', deny.output);
  }
  if (!deny.output.includes('--no-verify is FORBIDDEN')) {
    return fail('push alias should show forbidden header', deny.output);
  }

  // Release via push alias with proof
  const proofText = 'Runner: review\nStatus: PASS\nOutput: ok\nSummary: done';
  const release = agentLease(`push --audit-proof='${proofText}'`);
  if (release.status !== 0) {
    return fail('push alias release should work', release.output);
  }

  pass('push backward compat works');
  agentLease('clear');
}

function test_config_resolution_chain() {
  log('\nTest: config resolution chain (CLI > config.json > pkg.json > .agentguard.json)');

  // Priority 4: .agentguard.json (lowest)
  // Note: 'runners' command uses loadConfig() which delegates to loadConfigChain()
  writeConfig({
    runners: [{ name: 'from-legacy', command: 'echo legacy' }],
    lockDir: 'local'
  });

  let result = agentLease('runners');
  if (!result.output.includes('from-legacy')) {
    return fail('should load from .agentguard.json', result.output);
  }

  // Priority 3: package.json["agentguard"] overrides .agentguard.json
  const pkg = JSON.parse(fs.readFileSync(path.join(testDir, 'package.json'), 'utf8'));
  pkg['agentguard'] = {
    runners: [{ name: 'from-pkg', command: 'echo pkg' }],
    lockDir: 'local'
  };
  fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify(pkg, null, 2));
  // Remove higher-priority configs so pkg.json is used
  const legacyPath = path.join(testDir, '.agentguard.json');
  if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
  const dirConfigPath = path.join(testDir, '.agentguard', 'config.json');
  if (fs.existsSync(dirConfigPath)) fs.unlinkSync(dirConfigPath);

  result = agentLease('runners');
  if (!result.output.includes('from-pkg')) {
    return fail('should load from package.json', result.output);
  }

  // Priority 2: .agentguard/config.json overrides package.json
  const leaseDir = path.join(testDir, '.agentguard');
  if (!fs.existsSync(leaseDir)) fs.mkdirSync(leaseDir);
  fs.writeFileSync(path.join(leaseDir, 'config.json'), JSON.stringify({
    runners: [{ name: 'from-dir-config', command: 'echo dir-config' }],
    lockDir: 'local'
  }));

  result = agentLease('runners');
  if (!result.output.includes('from-dir-config')) {
    return fail('should load from .agentguard/config.json', result.output);
  }

  // Priority 1: CLI --config overrides everything
  const cliConfigPath = path.join(testDir, 'custom-config.json');
  fs.writeFileSync(cliConfigPath, JSON.stringify({
    runners: [{ name: 'from-cli', command: 'echo cli' }],
    lockDir: 'local'
  }));

  // Use lease command with --config to test CLI config path
  stageFile('config-chain-test');
  const denyResult = agentLease(`lease pre-commit --config ${cliConfigPath}`);
  // Should block and require 'from-cli' runner in proof
  if (denyResult.status === 0) {
    return fail('lease with CLI config should block', denyResult.output);
  }

  // Verify proof would need 'from-cli' runner (not others)
  const proofForCli = 'Runner: from-cli\nStatus: PASS\nOutput: ok\nSummary: done';
  const releaseResult = agentLease(`lease pre-commit --config ${cliConfigPath} --audit-proof='${proofForCli}'`);
  if (releaseResult.status !== 0) {
    return fail('CLI config runner should be accepted', releaseResult.output);
  }

  // Clean up for next test
  agentLease('clear');
  fs.unlinkSync(path.join(leaseDir, 'config.json'));
  fs.unlinkSync(cliConfigPath);
  // Restore clean package.json
  delete pkg['agentguard'];
  fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify(pkg, null, 2));
  run('git commit --no-verify -m "cleanup config-chain"');

  pass('config resolution chain works');
}

function test_template_resolution() {
  log('\nTest: template resolution (CLI > templates/{topic}.md > legacy > builtin)');

  initProject({
    runners: [{ name: 'build', command: 'echo ok', on: 'commit' }],
    lockDir: 'local'
  });

  stageFile('tmpl-test');

  // Test 1: Built-in default template (no custom templates)
  // Remove any existing templates
  const leaseDir = path.join(testDir, '.agentguard');
  const commitTmpl = path.join(leaseDir, 'commit.md');
  const preTmpl = path.join(leaseDir, 'pre-commit.md');
  if (fs.existsSync(commitTmpl)) fs.unlinkSync(commitTmpl);
  if (fs.existsSync(preTmpl)) fs.unlinkSync(preTmpl);

  let deny = agentLease('lease pre-commit');
  if (!deny.output.includes('Validation Gate')) {
    return fail('should use builtin template', deny.output);
  }
  agentLease('clear');

  // Test 2: Legacy commit.md template (maps pre-commit -> commit.md)
  fs.writeFileSync(commitTmpl, 'LEGACY_COMMIT_TEMPLATE {{topic}} {{project}}');
  deny = agentLease('lease pre-commit');
  if (!deny.output.includes('LEGACY_COMMIT_TEMPLATE')) {
    return fail('should use legacy commit.md for pre-commit', deny.output);
  }
  agentLease('clear');

  // Test 3: Topic-specific template (pre-commit.md overrides commit.md)
  fs.writeFileSync(preTmpl, 'TOPIC_SPECIFIC_TEMPLATE for {{topic}}');
  deny = agentLease('lease pre-commit');
  if (!deny.output.includes('TOPIC_SPECIFIC_TEMPLATE')) {
    return fail('should use topic-specific pre-commit.md', deny.output);
  }
  agentLease('clear');

  // Test 4: CLI --template overrides everything
  const cliTmplPath = path.join(testDir, 'my-template.md');
  fs.writeFileSync(cliTmplPath, 'CLI_TEMPLATE_OVERRIDE for {{topic}}');
  deny = agentLease(`lease pre-commit --template ${cliTmplPath}`);
  if (!deny.output.includes('CLI_TEMPLATE_OVERRIDE')) {
    return fail('should use CLI --template override', deny.output);
  }
  agentLease('clear');

  // Cleanup
  fs.unlinkSync(cliTmplPath);
  if (fs.existsSync(preTmpl)) fs.unlinkSync(preTmpl);

  pass('template resolution chain works');
  run('git commit --no-verify -m "cleanup tmpl"');
}

function test_env_var_expansion() {
  log('\nTest: {{env:VAR}} expansion in templates');

  const leaseDir = path.join(testDir, '.agentguard');
  if (!fs.existsSync(leaseDir)) fs.mkdirSync(leaseDir, { recursive: true });

  initProject({
    runners: [],
    lockDir: 'local'
  });

  // Write template with env var placeholder
  fs.writeFileSync(path.join(leaseDir, 'pre-commit.md'),
    'User: {{env:TEST_USER_NAME}}\nMode: {{env:TEST_MODE}}\nEmpty: {{env:NONEXISTENT_VAR_12345}}');

  stageFile('env-test');

  const deny = agentLease('lease pre-commit', {
    env: { TEST_USER_NAME: 'alice', TEST_MODE: 'testing' }
  });

  if (!deny.output.includes('User: alice')) {
    return fail('should expand {{env:TEST_USER_NAME}}', deny.output);
  }
  if (!deny.output.includes('Mode: testing')) {
    return fail('should expand {{env:TEST_MODE}}', deny.output);
  }
  if (deny.output.includes('{{env:NONEXISTENT_VAR_12345}}')) {
    return fail('nonexistent env var should expand to empty', deny.output);
  }

  pass('env var expansion works');
  agentLease('clear');
  run('git commit --no-verify -m "cleanup env"');
}

function test_legacy_config_migration() {
  log('\nTest: legacy runners[].on migrates to topics');

  // Use the config module directly
  const { migrateConfig } = require(path.join(__dirname, '..', 'lib', 'config'));

  // Old format: runners with 'on' field, no 'topics'
  const oldConfig = {
    runners: [
      { name: 'build', command: 'npm run build', on: 'commit' },
      { name: 'lint', command: 'npm run lint', on: 'commit' },
      { name: 'review', command: 'echo review', on: 'push' },
      { name: 'security', command: 'echo sec', on: 'both' }
    ]
  };

  const migrated = migrateConfig(oldConfig);

  if (!migrated.topics) {
    return fail('should create topics object', JSON.stringify(migrated));
  }

  if (!migrated.topics['pre-commit'] || !migrated.topics['pre-commit'].includes('build')) {
    return fail('should map commit runners to pre-commit', JSON.stringify(migrated.topics));
  }

  if (!migrated.topics['pre-commit'].includes('lint')) {
    return fail('lint should be in pre-commit', JSON.stringify(migrated.topics));
  }

  if (!migrated.topics['pre-push'] || !migrated.topics['pre-push'].includes('review')) {
    return fail('should map push runners to pre-push', JSON.stringify(migrated.topics));
  }

  // 'both' should appear in both pre-commit and pre-push
  if (!migrated.topics['pre-commit'].includes('security')) {
    return fail('both runner should be in pre-commit', JSON.stringify(migrated.topics));
  }
  if (!migrated.topics['pre-push'].includes('security')) {
    return fail('both runner should be in pre-push', JSON.stringify(migrated.topics));
  }

  // Already-migrated config should pass through unchanged
  const alreadyMigrated = { topics: { 'pre-commit': ['x'] }, runners: [{ name: 'x', command: 'echo' }] };
  const result = migrateConfig(alreadyMigrated);
  if (result !== alreadyMigrated) {
    return fail('already migrated config should pass through', JSON.stringify(result));
  }

  pass('legacy config migration works');
}

function test_all_known_git_hooks() {
  log('\nTest: each KNOWN_GIT_HOOKS entry works with lease');

  const { KNOWN_GIT_HOOKS } = require(path.join(__dirname, '..', 'lib', 'config'));

  initProject({
    runners: [],
    lockDir: 'local'
  });

  // Test a subset of known hooks to keep test fast
  const hooksToTest = ['pre-commit', 'pre-push', 'commit-msg', 'post-merge'];

  for (const hook of hooksToTest) {
    if (!KNOWN_GIT_HOOKS.includes(hook)) {
      return fail(`${hook} should be in KNOWN_GIT_HOOKS`, KNOWN_GIT_HOOKS.join(', '));
    }

    // Each hook should create a lock via lease
    const deny = agentLease(`lease ${hook}`);
    if (deny.status === 0) {
      return fail(`lease ${hook} should block (exit 1)`, deny.output);
    }

    // Clear the lock for next iteration
    agentLease(`clear --topic ${hook}`);
  }

  // Verify the full list is reasonable
  if (KNOWN_GIT_HOOKS.length < 5) {
    return fail('should have at least 5 known hooks', `got ${KNOWN_GIT_HOOKS.length}`);
  }

  pass('all known git hooks work with lease');
}

function test_lock_naming_includes_topic() {
  log('\nTest: lock file naming includes topic');

  // Ensure .agentguard dir exists and use local locks
  const leaseDir = path.join(testDir, '.agentguard');
  if (!fs.existsSync(leaseDir)) fs.mkdirSync(leaseDir, { recursive: true });

  initProject({
    runners: [],
    lockDir: 'local'
  });

  // Create a custom topic lock
  agentLease('lease deploy-prod');

  // Check the locks directory for a file with the topic-derived phase
  const locksDir = path.join(testDir, '.agentguard', 'locks');
  if (!fs.existsSync(locksDir)) {
    return fail('locks dir should exist', 'missing .agentguard/locks/');
  }

  const lockFiles = fs.readdirSync(locksDir).filter(f => f.endsWith('.lock'));
  if (lockFiles.length === 0) {
    return fail('should create a lock file', 'no .lock files found');
  }

  // Check that the lock file content has the topic info
  const lockContent = fs.readFileSync(path.join(locksDir, lockFiles[0]), 'utf8');
  // Accept either PHASE= or TOPIC= depending on lock manager version
  if (!lockContent.includes('deploy-prod')) {
    return fail('lock content should include topic name', lockContent);
  }

  pass('lock naming includes topic');
  agentLease('clear --topic deploy-prod');
}

function test_multiple_topics_independent() {
  log('\nTest: multiple topics have independent locks');

  initProject({
    topics: {
      'pre-commit': ['build'],
      'deploy-prod': ['deploy-check']
    },
    runners: [
      { name: 'build', command: 'echo ok' },
      { name: 'deploy-check', command: 'echo ok' }
    ],
    lockDir: 'local'
  });

  // Need an initial commit for git context (diff commands)
  stageFile('initial-multi');
  run('git commit --no-verify -m "initial"');

  // Stage another file for the test
  stageFile('multi-test');

  // Create locks for two different topics
  agentLease('lease pre-commit');
  agentLease('lease deploy-prod');

  // Both should have locks
  const statusCommit = agentLease('status --topic pre-commit');
  const statusDeploy = agentLease('status --topic deploy-prod');

  if (!statusCommit.output.includes('Lock exists')) {
    return fail('pre-commit should have lock', statusCommit.output);
  }
  if (!statusDeploy.output.includes('Lock exists')) {
    return fail('deploy-prod should have lock', statusDeploy.output);
  }

  // Release only pre-commit
  const proofText = 'Runner: build\nStatus: PASS\nOutput: ok\nSummary: done';
  agentLease(`lease pre-commit --audit-proof='${proofText}'`);

  // pre-commit should be released, deploy-prod should still be locked
  const afterCommit = agentLease('lease pre-commit');
  // Should exit 0 because proof exists
  if (afterCommit.status !== 0) {
    return fail('pre-commit should pass after release', afterCommit.output);
  }

  const afterDeploy = agentLease('status --topic deploy-prod');
  if (!afterDeploy.output.includes('Lock exists')) {
    return fail('deploy-prod should still be locked', afterDeploy.output);
  }

  // Clear deploy-prod should not affect pre-commit
  agentLease('clear --topic deploy-prod');
  const finalDeploy = agentLease('status --topic deploy-prod');
  if (finalDeploy.output.includes('Lock exists')) {
    return fail('deploy-prod should be cleared', finalDeploy.output);
  }

  pass('multiple topics are independent');
  agentLease('clear');
}

function test_template_vars_topic_aware() {
  log('\nTest: template variables are topic-aware (files/diff for commit vs push)');

  const leaseDir = path.join(testDir, '.agentguard');
  if (!fs.existsSync(leaseDir)) fs.mkdirSync(leaseDir, { recursive: true });

  // Use the config and runner modules directly to test interpolation
  const { interpolateTemplate, loadConfigChain } = require(path.join(__dirname, '..', 'lib', 'config'));
  const { getGitContext } = require(path.join(__dirname, '..', 'lib', 'runner'));

  // Create a commit so we have HEAD
  stageFile('tvar-base');
  run('git commit --no-verify -m "base for template vars"');

  // Create a remote to enable push diff
  run('git remote add origin . 2>/dev/null || true');
  run('git branch -M main');

  // Stage a new file (this will appear in commit diff)
  stageFile('tvar-staged', 'staged-content');

  // Create another committed file (will appear in push diff)
  stageFile('tvar-pushed');
  run('git commit --no-verify -m "pushed file"');

  // Re-stage a file for the commit context
  stageFile('tvar-staged2', 'staged2-content');

  const context = getGitContext();

  // Verify context has both commit and push data
  if (!context.files) {
    return fail('context.files should have staged files', JSON.stringify(context));
  }
  if (!context.branch) {
    return fail('context.branch should be populated', JSON.stringify(context));
  }
  if (!context.hash || context.hash === 'new') {
    return fail('context.hash should be populated', JSON.stringify(context));
  }

  // Template with all vars
  const tmpl = 'FILES:{{files}} BRANCH:{{branch}} HASH:{{hash}} TOPIC:{{topic}} ARGS:{{args}} ENV:{{env:TVAR_TEST}}';

  // Test commit topic
  const commitResult = interpolateTemplate(tmpl, context,
    { _runners: [], projectName: 'tvar-proj' },
    { topic: 'pre-commit', args: ['--verbose'] }
  );

  if (!commitResult.includes('TOPIC:pre-commit')) {
    return fail('commit: topic should be pre-commit', commitResult);
  }
  if (!commitResult.includes('ARGS:--verbose')) {
    return fail('commit: args should be --verbose', commitResult);
  }
  if (!commitResult.includes('BRANCH:main')) {
    return fail('commit: branch should be main', commitResult);
  }
  if (commitResult.includes('HASH:new')) {
    return fail('commit: hash should not be "new"', commitResult);
  }
  // Commit files should include staged file
  if (!commitResult.includes('tvar-staged2')) {
    return fail('commit: files should include staged file', commitResult);
  }

  // Test push topic - should use filesPush/diffPush
  const pushResult = interpolateTemplate(tmpl, context,
    { _runners: [], projectName: 'tvar-proj' },
    { topic: 'pre-push', args: ['origin', 'main'] }
  );

  if (!pushResult.includes('TOPIC:pre-push')) {
    return fail('push: topic should be pre-push', pushResult);
  }
  if (!pushResult.includes('ARGS:origin main')) {
    return fail('push: args should be "origin main"', pushResult);
  }

  // Test env var expansion
  process.env.TVAR_TEST = 'hello-env';
  const envResult = interpolateTemplate(tmpl, context,
    { _runners: [], projectName: 'tvar-proj' },
    { topic: 'test' }
  );
  if (!envResult.includes('ENV:hello-env')) {
    return fail('env var should expand', envResult);
  }
  delete process.env.TVAR_TEST;

  // Nonexistent env var should expand to empty
  const emptyEnv = interpolateTemplate('{{env:DOES_NOT_EXIST_XYZ}}', context,
    { _runners: [], projectName: 'test' }, {});
  if (emptyEnv !== '') {
    return fail('nonexistent env var should be empty', emptyEnv);
  }

  pass('all template variables are topic-aware');
  run('git commit --no-verify -m "cleanup tvar" 2>/dev/null || true');
}

// ============ MAIN ============

function main() {
  log('==============================================================');
  log('  agentguard Topic System Test Suite (v4.0)');
  log('==============================================================');

  try {
    setup();

    test_lease_deny_release();
    test_lease_arbitrary_topic();
    test_backward_compat_commit();
    test_backward_compat_push();
    test_config_resolution_chain();
    test_template_resolution();
    test_env_var_expansion();
    test_legacy_config_migration();
    test_all_known_git_hooks();
    test_lock_naming_includes_topic();
    test_multiple_topics_independent();
    test_template_vars_topic_aware();

    log('\n' + '='.repeat(60));
    log(`\n  Results: ${passed} passed, ${failed} failed\n`);

    if (failed > 0) process.exit(1);
  } catch (e) {
    log(`\nTest crashed: ${e.message}`);
    log(e.stack);
    process.exit(1);
  } finally {
    cleanup();
  }
}

main();
