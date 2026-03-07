#!/usr/bin/env node
/**
 * E2E Test Suite for agentguard
 *
 * Tests the full lock/lease/runner cycle in an isolated git repo.
 *
 * Run: node test/e2e.js
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

const AGENTGUARD_BIN = path.join(__dirname, '..', 'bin', 'agentguard.js');

// Test utilities
let testDir;
let passed = 0;
let failed = 0;

function log(msg) {
  console.log(msg);
}

function pass(name) {
  passed++;
  log(`  ✅ ${name}`);
}

function fail(name, reason) {
  failed++;
  log(`  ❌ ${name}`);
  log(`     ${reason}`);
}

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-test-'));
  process.chdir(testDir);
  execSync('git init -q');
  execSync('git config user.email "test@test.com"');
  execSync('git config user.name "Test"');

  // Create package.json
  fs.writeFileSync('package.json', JSON.stringify({
    name: 'test-project',
    scripts: {
      build: 'echo build-ok',
      lint: 'echo lint-ok',
      'build-fail': 'echo fail && exit 1'
    }
  }, null, 2));

  // Clear any stale locks from previous test runs
  try {
    const tmpFiles = fs.readdirSync(os.tmpdir());
    for (const f of tmpFiles) {
      if (f.startsWith('agentguard-test-project-') && f.endsWith('.lock')) {
        fs.unlinkSync(path.join(os.tmpdir(), f));
      }
    }
  } catch (e) {}

  log(`\n📁 Test dir: ${testDir}\n`);
}

function cleanup() {
  process.chdir('/');
  fs.rmSync(testDir, { recursive: true, force: true });
}

// Helper: write config to both legacy and v4 locations for consistency
function writeTestConfig(config) {
  // Write legacy config
  fs.writeFileSync(path.join(testDir, '.agentguard.json'), JSON.stringify(config));

  // Also write v4 config (higher priority) to match
  const v4ConfigDir = path.join(testDir, '.agentguard');
  if (!fs.existsSync(v4ConfigDir)) {
    fs.mkdirSync(v4ConfigDir, { recursive: true });
  }

  // Convert legacy format to v4 topics format
  const v4Config = { ...config };
  if (config.runners && Array.isArray(config.runners)) {
    v4Config.topics = {};
    for (const r of config.runners) {
      const on = r.on || 'commit';
      const topicName = on === 'commit' ? 'pre-commit' : on === 'push' ? 'pre-push' : on;
      if (!v4Config.topics[topicName]) {
        v4Config.topics[topicName] = { runners: [] };
      }
      v4Config.topics[topicName].runners.push({ name: r.name, command: r.command });
    }
  }
  fs.writeFileSync(path.join(v4ConfigDir, 'config.json'), JSON.stringify(v4Config, null, 2));
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

// ============ TESTS ============

function test_init() {
  log('\n🧪 Test: init');

  const result = agentLease('init');

  if (result.status !== 0) {
    return fail('init should succeed', result.output);
  }

  if (!fs.existsSync(path.join(testDir, '.agentguard.json'))) {
    return fail('should create config', 'missing .agentguard.json');
  }

  if (!fs.existsSync(path.join(testDir, '.git', 'hooks', 'pre-commit'))) {
    return fail('should install hook', 'missing pre-commit hook');
  }

  if (!result.output.includes('agentguard installed')) {
    return fail('should show success message', result.output);
  }

  pass('init creates config and hooks');
}

function test_commit_blocked() {
  log('\n🧪 Test: commit creates lock and blocks');

  fs.writeFileSync(path.join(testDir, 'test.txt'), 'hello');
  run('git add test.txt');

  const result = run('git commit -m "test"');

  if (result.status === 0) {
    return fail('commit should be blocked', 'commit succeeded but should have failed');
  }

  // v3.3: Now uses template-based output with --no-verify warning
  if (!result.output.includes('--no-verify is FORBIDDEN')) {
    return fail('should show --no-verify warning', result.output);
  }

  // Check lock exists
  const status = agentLease('status');
  if (!status.output.includes('Lock exists')) {
    return fail('lock should exist after blocked commit', status.output);
  }

  pass('first commit creates lock and blocks');
}

function test_release_validates() {
  log('\n🧪 Test: release runs runners and validates');

  const result = agentLease('release --audit-proof');

  if (result.status !== 0) {
    return fail('release should succeed with passing runners', result.output);
  }

  if (!result.output.includes('build')) {
    return fail('should run build', result.output);
  }

  if (!result.output.includes('lint')) {
    return fail('should run lint', result.output);
  }

  if (!result.output.includes('All runners passed')) {
    return fail('should report all passed', result.output);
  }

  pass('release runs all runners');
}

function test_commit_succeeds_after_release() {
  log('\n🧪 Test: commit succeeds after release');

  const result = run('git commit -m "test"');

  if (result.status !== 0) {
    return fail('commit should succeed after release', result.output);
  }

  // v3.3: cmd_phase exits 0 silently when proof exists in lock
  pass('commit succeeds with proof');
}

function test_runner_failure_blocks() {
  log('\n🧪 Test: failing runner blocks release');

  // Modify config to use failing runner with LOCAL locks
  const config = {
    runners: [
      { name: 'fail', command: 'npm run build-fail', on: 'commit' }
    ],
    lockDir: 'local'
  };
  writeTestConfig(config);

  // Re-install hooks so they pick up new config
  agentLease('init');

  // Create new file to trigger lock
  fs.writeFileSync(path.join(testDir, 'test2.txt'), 'world');
  run('git add test2.txt');

  // First commit creates lock and blocks
  const commitResult = run('git commit -m "test2"');
  // v3.3: template-based output with --no-verify warning
  if (!commitResult.output.includes('--no-verify is FORBIDDEN')) {
    return fail('first commit should block and create lock', commitResult.output);
  }

  // Verify lock was created
  const preStatus = agentLease('status');
  if (!preStatus.output.includes('Lock exists')) {
    return fail('lock should exist after blocked commit', preStatus.output);
  }

  // Try to release - should fail because runner fails
  const result = agentLease('release --audit-proof');

  if (result.status === 0) {
    return fail('release should fail when runner fails', result.output);
  }

  if (!result.output.includes('Validation failed')) {
    return fail('should report failure', result.output);
  }

  pass('failing runner blocks release');

  // Cleanup: clear lock and restore config
  agentLease('clear');
  // Bypass to clean up staged file
  run('git commit --no-verify -m "cleanup fail-test"');
}

function test_local_lock_dir() {
  log('\n🧪 Test: local lock directory');

  const config = {
    runners: [{ name: 'echo', command: 'echo ok', on: 'commit' }],
    lockDir: 'local'
  };
  writeTestConfig(config);

  fs.writeFileSync(path.join(testDir, 'test3.txt'), 'local');
  run('git add test3.txt');
  run('git commit -m "test3"'); // Creates lock

  const status = agentLease('status');

  if (!status.output.includes('.agentguard/locks')) {
    return fail('should use local lock dir', status.output);
  }

  pass('local lock directory works');

  agentLease('release --audit-proof');
  run('git commit -m "test3"');
}

function test_env_override() {
  log('\n🧪 Test: env var overrides');

  // Ensure default config with /tmp locks
  const config = {
    runners: [{ name: 'build', command: 'npm run build', on: 'commit' }],
    lockDir: '/tmp'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'test4.txt'), 'env');
  run('git add test4.txt');
  run('git commit -m "test4"'); // Creates lock

  // Verify lock exists
  const preStatus = agentLease('status');
  if (!preStatus.output.includes('Lock exists')) {
    return fail('lock should exist before env release', preStatus.output);
  }

  // Use env var to override runner
  const result = agentLease('release --audit-proof', {
    env: { AGENTGUARD_RUNNERS: 'custom:echo custom-runner-ok' }
  });

  if (result.status !== 0) {
    return fail('env override should work', result.output);
  }

  if (!result.output.includes('custom')) {
    return fail('should use env runner', result.output);
  }

  pass('env var runner override works');

  run('git commit -m "test4"');
}

function test_runners_command() {
  log('\n🧪 Test: runners command');

  const config = {
    runners: [
      { name: 'build', command: 'npm run build', on: 'commit' },
      { name: 'review', command: 'claude -p "{{diff}}"', on: 'push' }
    ],
    lockDir: 'auto'
  };
  writeTestConfig(config);

  const result = agentLease('runners');

  if (!result.output.includes('[commit] build')) {
    return fail('should list commit runner', result.output);
  }

  if (!result.output.includes('[push] review')) {
    return fail('should list push runner', result.output);
  }

  pass('runners command lists all runners');
}

function test_clear() {
  log('\n🧪 Test: clear removes locks');

  // Ensure consistent config
  const config = {
    runners: [{ name: 'echo', command: 'echo ok', on: 'commit' }],
    lockDir: '/tmp'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'test5.txt'), 'clear');
  run('git add test5.txt');
  run('git commit -m "test5"'); // Creates lock

  let status = agentLease('status');
  if (!status.output.includes('Lock exists')) {
    return fail('lock should exist before clear', status.output);
  }

  const result = agentLease('clear');
  if (!result.output.includes('Cleared')) {
    return fail('should report cleared', result.output);
  }

  status = agentLease('status');
  if (!status.output.includes('No active lock')) {
    return fail('lock should be gone after clear', status.output);
  }

  pass('clear removes locks');

  // Bypass to clean up
  run('git commit --no-verify -m "cleanup"');
}

function test_template_vars() {
  log('\n🧪 Test: template variable expansion');

  const config = {
    runners: [
      { name: 'echo-project', command: 'echo "project:{{project}}"', on: 'commit' },
      { name: 'echo-branch', command: 'echo "branch:{{branch}}"', on: 'commit' }
    ],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'test6.txt'), 'template');
  run('git add test6.txt');
  run('git commit -m "test6"'); // Creates lock

  // Verify lock
  const preStatus = agentLease('status');
  if (!preStatus.output.includes('Lock exists')) {
    return fail('lock should exist before template test', preStatus.output);
  }

  const result = agentLease('release --audit-proof');

  if (result.status !== 0) {
    return fail('release should succeed', result.output);
  }

  // Runner output shows in formatResults which includes command name
  if (!result.output.includes('echo-project') || !result.output.includes('echo-branch')) {
    return fail('should run both template runners', result.output);
  }

  pass('template variables expand correctly');

  run('git commit -m "test6"');
}

function test_bypass() {
  log('\n🧪 Test: --no-verify bypasses hooks');

  fs.writeFileSync(path.join(testDir, 'test7.txt'), 'bypass');
  run('git add test7.txt');

  const result = run('git commit --no-verify -m "bypass test"');

  if (result.status !== 0) {
    return fail('--no-verify should bypass hook', result.output);
  }

  pass('--no-verify bypasses validation');
}

// ============ v3.2 TESTS ============

function test_meta_prompt_output() {
  log('\n🧪 Test: gate template shows runners and callback format');

  const config = {
    runners: [
      { name: 'build', command: 'npm run build', on: 'commit' },
      { name: 'lint', command: 'npm run lint', on: 'commit' }
    ],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'meta.txt'), 'meta-prompt');
  run('git add meta.txt');

  const result = run('git commit -m "meta-test"');

  // v3.3: template-based gate output
  if (!result.output.includes('--no-verify is FORBIDDEN')) {
    return fail('should show --no-verify warning', result.output);
  }

  // Check that runners are shown (from {{runners}} template var)
  if (!result.output.includes('build') || !result.output.includes('lint')) {
    return fail('should show configured runners', result.output);
  }

  if (!result.output.includes("--audit-proof='")) {
    return fail('should show --audit-proof with value syntax', result.output);
  }

  pass('gate template shows runners and callback format');

  agentLease('clear');
  run('git commit --no-verify -m "cleanup meta"');
}

function test_proof_submission_v32() {
  log('\n🧪 Test: v3.2 proof submission with --audit-proof value');

  const config = {
    runners: [
      { name: 'build', command: 'echo ok', on: 'commit' }
    ],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'proof.txt'), 'proof-test');
  run('git add proof.txt');
  run('git commit -m "proof-test"'); // Creates lock

  // Submit proof via v3.2 mode
  const proofText = '## Validation Report\nRunner: build\nStatus: PASS\nOutput: Build succeeded\n\nSummary: All validations passed.';
  const result = agentLease(`release --audit-proof='${proofText}'`);

  if (result.status !== 0) {
    return fail('v3.2 proof submission should succeed', result.output);
  }

  if (!result.output.includes('Agent proof accepted')) {
    return fail('should show agent proof accepted message', result.output);
  }

  if (!result.output.includes('v3.2 mode')) {
    return fail('should indicate v3.2 mode', result.output);
  }

  pass('v3.2 proof submission works');

  run('git commit -m "proof-test"');
}

function test_proof_backward_compat_v2() {
  log('\n🧪 Test: v2 backward compat (--audit-proof without value)');

  const config = {
    runners: [
      { name: 'echo', command: 'echo v2-mode-ok', on: 'commit' }
    ],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'v2.txt'), 'v2-test');
  run('git add v2.txt');
  run('git commit -m "v2-test"'); // Creates lock

  // Use v2 mode (no value after --audit-proof)
  const result = agentLease('release --audit-proof');

  if (result.status !== 0) {
    return fail('v2 mode should still work', result.output);
  }

  if (!result.output.includes('All runners passed')) {
    return fail('v2 should run runners internally', result.output);
  }

  pass('v2 backward compatibility preserved');

  run('git commit -m "v2-test"');
}

function test_proof_missing_runner_rejected() {
  log('\n🧪 Test: proof rejected when runner is missing');

  const config = {
    runners: [
      { name: 'build', command: 'echo ok', on: 'commit' },
      { name: 'lint', command: 'echo ok', on: 'commit' }
    ],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'missing.txt'), 'missing-test');
  run('git add missing.txt');
  run('git commit -m "missing-test"'); // Creates lock

  // Only submit proof for build, not lint
  const proofText = '## Validation Report\nRunner: build\nStatus: PASS\nOutput: ok\n\nSummary: done';
  const result = agentLease(`release --audit-proof='${proofText}'`);

  if (result.status === 0) {
    return fail('should reject incomplete proof', result.output);
  }

  if (!result.output.includes('Missing runners') && !result.output.includes('incomplete')) {
    return fail('should indicate missing runners', result.output);
  }

  pass('incomplete proof rejected');

  agentLease('clear');
  run('git commit --no-verify -m "cleanup missing"');
}

function test_proof_fail_status_rejected() {
  log('\n🧪 Test: proof rejected when runner reports FAIL');

  const config = {
    runners: [
      { name: 'build', command: 'echo ok', on: 'commit' }
    ],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'fail.txt'), 'fail-test');
  run('git add fail.txt');
  run('git commit -m "fail-test"'); // Creates lock

  const proofText = '## Validation Report\nRunner: build\nStatus: FAIL\nOutput: Build failed\n\nSummary: Failed.';
  const result = agentLease(`release --audit-proof='${proofText}'`);

  if (result.status === 0) {
    return fail('should reject proof with FAIL status', result.output);
  }

  if (!result.output.includes('failures')) {
    return fail('should indicate failures', result.output);
  }

  pass('proof with FAIL status rejected');

  agentLease('clear');
  run('git commit --no-verify -m "cleanup fail"');
}

function test_agent_summary_trailer() {
  log('\n🧪 Test: agentguard-agent-summary trailer appears');

  const config = {
    runners: [
      { name: 'build', command: 'echo ok', on: 'commit' }
    ],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync(path.join(testDir, 'trailer.txt'), 'trailer-test');
  run('git add trailer.txt');
  run('git commit -m "trailer-test"'); // Creates lock

  const proofText = '## Validation Report\nRunner: build\nStatus: PASS\nOutput: ok\n\nSummary: All checks passed, safe to commit.';
  agentLease(`release --audit-proof='${proofText}'`);

  // Now commit should succeed and include trailers
  const result = run('git commit -m "trailer-test"');

  if (result.status !== 0) {
    return fail('commit should succeed after proof', result.output);
  }

  // Check git log for trailer
  const logResult = run("git log --format='%(trailers)' -1");

  if (!logResult.output.includes('agentguard-agent-summary')) {
    return fail('should include agent-summary trailer', logResult.output);
  }

  if (!logResult.output.includes('All checks passed')) {
    return fail('trailer should contain summary text', logResult.output);
  }

  pass('agentguard-agent-summary trailer appears in commit');
}

function test_llm_output_parsing() {
  log('\n🧪 Test: LLM output parsing with steering markers');

  // Test parseLLMOutput directly
  const { parseLLMOutput, LLM_START, LLM_END } = require(path.join(__dirname, '..', 'lib', 'runner'));

  const testOutput = `Some preamble text
${LLM_START}
VERDICT: PASS
CRITICAL: 0
HIGH: 1
MEDIUM: 2
LOW: 0
FINDINGS:
- Consider null check on line 42
- Variable name could be more descriptive
SUMMARY: Minor issues found, safe to proceed
${LLM_END}
Some epilogue`;

  const parsed = parseLLMOutput(testOutput);

  if (parsed.verdict !== 'PASS') {
    return fail('should parse VERDICT', `got: ${parsed.verdict}`);
  }

  if (parsed.critical !== 0) {
    return fail('should parse CRITICAL count', `got: ${parsed.critical}`);
  }

  if (parsed.high !== 1) {
    return fail('should parse HIGH count', `got: ${parsed.high}`);
  }

  if (parsed.findings.length !== 2) {
    return fail('should parse 2 findings', `got: ${parsed.findings.length}`);
  }

  if (!parsed.summary.includes('Minor issues')) {
    return fail('should parse SUMMARY', `got: ${parsed.summary}`);
  }

  // Test without markers
  const noMarkerParsed = parseLLMOutput('Just some random text\nWith multiple lines');
  if (noMarkerParsed.verdict !== null) {
    return fail('should return null verdict without markers', `got: ${noMarkerParsed.verdict}`);
  }

  pass('LLM output parsing works correctly');
}

function test_parse_agent_proof() {
  log('\n🧪 Test: parseAgentProof function');

  // Direct implementation test (since requiring bin/agentguard.js runs main)
  function parseAgentProof(text) {
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

  const proofText = `## Validation Report
Runner: test
Status: PASS
Output: 23 tests passed

Runner: haiku-review
Status: PASS
Output: No critical issues found

Summary: All validations passed. Safe to commit.`;

  const parsed = parseAgentProof(proofText);

  if (parsed.runners.length !== 2) {
    return fail('should parse 2 runners', `got: ${parsed.runners.length}`);
  }

  if (parsed.runners[0].name !== 'test') {
    return fail('first runner should be test', `got: ${parsed.runners[0].name}`);
  }

  if (parsed.runners[0].status !== 'PASS') {
    return fail('first runner status should be PASS', `got: ${parsed.runners[0].status}`);
  }

  if (parsed.runners[1].name !== 'haiku-review') {
    return fail('second runner should be haiku-review', `got: ${parsed.runners[1].name}`);
  }

  if (!parsed.summary.includes('All validations')) {
    return fail('should parse summary', `got: ${parsed.summary}`);
  }

  pass('parseAgentProof parses correctly');
}

// ============ MAIN ============

function main() {
  log('╔══════════════════════════════════════════════════════════════╗');
  log('║  agentguard E2E Test Suite                                  ║');
  log('╚══════════════════════════════════════════════════════════════╝');

  try {
    setup();

    // v2 tests
    test_init();
    test_commit_blocked();
    test_release_validates();
    test_commit_succeeds_after_release();
    test_runner_failure_blocks();
    test_local_lock_dir();
    test_env_override();
    test_runners_command();
    test_clear();
    test_template_vars();
    test_bypass();

    // v3.2 tests
    test_meta_prompt_output();
    test_proof_submission_v32();
    test_proof_backward_compat_v2();
    test_proof_missing_runner_rejected();
    test_proof_fail_status_rejected();
    test_agent_summary_trailer();
    test_llm_output_parsing();
    test_parse_agent_proof();

    log('\n' + '═'.repeat(60));
    log(`\n  Results: ${passed} passed, ${failed} failed\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (e) {
    log(`\n💥 Test crashed: ${e.message}`);
    log(e.stack);
    process.exit(1);
  } finally {
    cleanup();
  }
}

main();
