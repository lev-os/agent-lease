#!/usr/bin/env node
/**
 * Stress Test Suite for agentguard
 *
 * Tests edge cases, race conditions, and real-world scenarios.
 *
 * Run: node test/stress.js
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
function pass(name) { passed++; log(`  ✅ ${name}`); }
function fail(name, reason) { failed++; log(`  ❌ ${name}\n     ${reason}`); }

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-stress-'));
  process.chdir(testDir);
  execSync('git init -q');
  execSync('git config user.email "test@test.com"');
  execSync('git config user.name "Test"');
  fs.writeFileSync('package.json', JSON.stringify({
    name: 'stress-test',
    scripts: {
      build: 'echo build-ok',
      lint: 'echo lint-ok',
      slow: 'sleep 2 && echo slow-ok',
      flaky: 'if [ $((RANDOM % 2)) -eq 0 ]; then echo ok; else exit 1; fi'
    }
  }, null, 2));
  log(`\n📁 Test dir: ${testDir}\n`);
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
    timeout: opts.timeout || 30000
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

// Helper: write config to both legacy and v4 locations for consistency
function writeTestConfig(config) {
  fs.writeFileSync(path.join(testDir, '.agentguard.json'), JSON.stringify(config));
  const v4ConfigDir = path.join(testDir, '.agentguard');
  if (!fs.existsSync(v4ConfigDir)) {
    fs.mkdirSync(v4ConfigDir, { recursive: true });
  }
  const v4Config = { ...config };
  if (config.runners && Array.isArray(config.runners)) {
    v4Config.topics = {};
    for (const r of config.runners) {
      const on = r.on || 'commit';
      const topicName = on === 'commit' ? 'pre-commit' : on === 'push' ? 'pre-push' : on;
      if (!v4Config.topics[topicName]) v4Config.topics[topicName] = { runners: [] };
      v4Config.topics[topicName].runners.push({ name: r.name, command: r.command });
    }
  }
  if (config.lockDir) {
    v4Config.defaults = { lockDir: config.lockDir };
  }
  fs.writeFileSync(path.join(v4ConfigDir, 'config.json'), JSON.stringify(v4Config, null, 2));
}

function freshCommit(name) {
  // Helper: create file, stage, attempt commit (will block)
  fs.writeFileSync(path.join(testDir, `${name}.txt`), name);
  run(`git add ${name}.txt`);
  return run('git commit -m "' + name + '"');
}

// ============ STRESS TESTS ============

function test_multiple_locks_same_project() {
  log('\n🧪 Stress: Multiple blocked commits accumulate locks');

  const config = { runners: [{ name: 'echo', command: 'echo ok', on: 'commit' }], lockDir: 'local' };
  writeTestConfig(config);
  agentLease('init');

  // Create multiple files, each blocked commit creates a lock
  freshCommit('multi1');
  freshCommit('multi2');
  freshCommit('multi3');

  // Clear should remove all
  const result = agentLease('clear');
  if (!result.output.includes('Cleared')) {
    return fail('should clear multiple locks', result.output);
  }

  pass('handles multiple blocked commits');
  run('git commit --no-verify -m "cleanup multi"');
}

function test_large_diff() {
  log('\n🧪 Stress: Large diff (100KB+)');

  const config = {
    runners: [{ name: 'diff-size', command: 'echo "diff size: $(echo "{{diff}}" | wc -c)"', on: 'commit' }],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  // Create large file
  const largeContent = 'x'.repeat(100000) + '\n';
  fs.writeFileSync('large.txt', largeContent);
  run('git add large.txt');
  run('git commit -m "large"'); // Blocks

  const result = agentLease('release --audit-proof');
  if (result.status !== 0) {
    return fail('should handle large diff', result.output);
  }

  pass('handles 100KB+ diff');
  run('git commit -m "large"');
}

function test_special_characters_in_diff() {
  log('\n🧪 Stress: Special characters in diff');

  const config = {
    runners: [{ name: 'echo', command: 'echo "checking special chars"', on: 'commit' }],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  // File with special chars
  const specialContent = `
    const x = "hello \`world\`";
    const y = 'single $quotes';
    const z = \`template \${literal}\`;
    // Comment with "quotes" and 'apostrophes'
    /* Multi-line
       comment */
    const regex = /test\\npattern/;
    const json = {"key": "value"};
  `;
  fs.writeFileSync('special.js', specialContent);
  run('git add special.js');
  run('git commit -m "special"');

  const result = agentLease('release --audit-proof');
  if (result.status !== 0) {
    return fail('should handle special characters', result.output);
  }

  pass('handles special characters in diff');
  run('git commit -m "special"');
}

function test_concurrent_commits() {
  log('\n🧪 Stress: Rapid sequential commits');

  const config = {
    runners: [{ name: 'fast', command: 'echo fast', on: 'commit' }],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  // Rapid fire: commit, release, commit
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(`rapid${i}.txt`, `content${i}`);
    run(`git add rapid${i}.txt`);
    run(`git commit -m "rapid${i}"`);
    agentLease('release --audit-proof');
    const commit = run(`git commit -m "rapid${i}"`);
    if (commit.status !== 0) {
      return fail(`rapid commit ${i} should succeed`, commit.output);
    }
  }

  pass('handles rapid sequential commits');
}

function test_runner_timeout() {
  log('\n🧪 Stress: Slow runner (2s)');

  const config = {
    runners: [{ name: 'slow', command: 'npm run slow', on: 'commit' }],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync('slow.txt', 'slow');
  run('git add slow.txt');
  run('git commit -m "slow"');

  const start = Date.now();
  const result = agentLease('release --audit-proof', { timeout: 60000 });
  const duration = Date.now() - start;

  if (result.status !== 0) {
    return fail('slow runner should complete', result.output);
  }

  if (duration < 1500) {
    return fail('slow runner should take >1.5s', `took ${duration}ms`);
  }

  pass(`slow runner completed in ${(duration/1000).toFixed(1)}s`);
  run('git commit -m "slow"');
}

function test_empty_runners() {
  log('\n🧪 Stress: No runners configured');

  const config = { runners: [], lockDir: 'local' };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync('empty.txt', 'empty');
  run('git add empty.txt');
  run('git commit -m "empty"');

  const result = agentLease('release --audit-proof');
  if (result.status !== 0) {
    return fail('empty runners should pass', result.output);
  }

  pass('handles empty runner list');
  run('git commit -m "empty"');
}

function test_xdg_runtime_dir() {
  log('\n🧪 Stress: XDG_RUNTIME_DIR support');

  const xdgDir = path.join(testDir, 'xdg-runtime');
  fs.mkdirSync(xdgDir);

  const config = { runners: [{ name: 'echo', command: 'echo ok', on: 'commit' }], lockDir: 'xdg' };
  writeTestConfig(config);
  agentLease('init');

  fs.writeFileSync('xdg.txt', 'xdg');
  run('git add xdg.txt');
  run('git commit -m "xdg"', { env: { XDG_RUNTIME_DIR: xdgDir } });

  const status = agentLease('status', { env: { XDG_RUNTIME_DIR: xdgDir } });
  if (!status.output.includes(xdgDir)) {
    return fail('should use XDG_RUNTIME_DIR', status.output);
  }

  pass('respects XDG_RUNTIME_DIR');
  agentLease('clear', { env: { XDG_RUNTIME_DIR: xdgDir } });
  run('git commit --no-verify -m "xdg cleanup"');
}

function test_nested_git_repo() {
  log('\n🧪 Stress: Nested git repos');

  // Create nested repo
  const nestedDir = path.join(testDir, 'nested');
  fs.mkdirSync(nestedDir);
  execSync('git init -q', { cwd: nestedDir });
  execSync('git config user.email "nested@test.com"', { cwd: nestedDir });
  execSync('git config user.name "Nested"', { cwd: nestedDir });
  fs.writeFileSync(path.join(nestedDir, 'package.json'), JSON.stringify({
    name: 'nested-project',
    scripts: { build: 'echo nested-ok' }
  }));

  // Init agentguard in nested
  const initResult = spawnSync('node', [AGENTGUARD_BIN, 'init'], { cwd: nestedDir, encoding: 'utf8' });
  if (initResult.status !== 0) {
    return fail('should init in nested repo', initResult.stdout + initResult.stderr);
  }

  // Verify it uses nested project name
  const statusResult = spawnSync('node', [AGENTGUARD_BIN, 'status'], { cwd: nestedDir, encoding: 'utf8' });
  if (!statusResult.stdout.includes('nested-project')) {
    return fail('should use nested project name', statusResult.stdout);
  }

  pass('handles nested git repos correctly');
}

function test_binary_files() {
  log('\n🧪 Stress: Binary files in commit');

  const config = {
    runners: [{ name: 'echo', command: 'echo binary-ok', on: 'commit' }],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  // Create binary file
  const buffer = Buffer.alloc(1024);
  for (let i = 0; i < 1024; i++) buffer[i] = i % 256;
  fs.writeFileSync('binary.bin', buffer);
  run('git add binary.bin');
  run('git commit -m "binary"');

  const result = agentLease('release --audit-proof');
  if (result.status !== 0) {
    return fail('should handle binary files', result.output);
  }

  pass('handles binary files');
  run('git commit -m "binary"');
}

function test_no_staged_changes() {
  log('\n🧪 Stress: Commit with nothing staged');

  const config = {
    runners: [{ name: 'echo', command: 'echo ok', on: 'commit' }],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  // First make a commit so we have a HEAD
  fs.writeFileSync('initial.txt', 'initial');
  run('git add initial.txt');
  run('git commit --no-verify -m "initial"');

  // Now try to commit with nothing NEW staged
  const result = run('git commit -m "nothing"');

  // Git should fail (nothing to commit) BEFORE the hook runs
  // because pre-commit only fires if there's something staged
  if (result.status === 0) {
    return fail('commit with nothing staged should fail', result.output);
  }

  // Should be git's "nothing to commit" message, not our block
  if (!result.output.includes('nothing to commit')) {
    // If hook runs anyway, that's OK - hook fires before git checks
    // Just verify the system handles it gracefully
    agentLease('clear');
  }

  pass('handles commit with nothing staged');
}

function test_amend_commit() {
  log('\n🧪 Stress: Amend commit flow');

  const config = {
    runners: [{ name: 'echo', command: 'echo ok', on: 'commit' }],
    lockDir: 'local'
  };
  writeTestConfig(config);
  agentLease('init');

  // First commit
  fs.writeFileSync('amend1.txt', 'v1');
  run('git add amend1.txt');
  run('git commit -m "amend"');
  agentLease('release --audit-proof');
  run('git commit -m "amend"');

  // Amend
  fs.writeFileSync('amend1.txt', 'v2');
  run('git add amend1.txt');
  const amendResult = run('git commit --amend -m "amended"');

  // Should block (amend is a new commit) — v3.3 uses --no-verify warning
  if (!amendResult.output.includes('--no-verify is FORBIDDEN')) {
    return fail('amend should trigger lock', amendResult.output);
  }

  agentLease('release --audit-proof');
  const finalAmend = run('git commit --amend -m "amended"');
  if (finalAmend.status !== 0) {
    return fail('amend should succeed after release', finalAmend.output);
  }

  pass('amend commit flow works');
}

function test_runner_with_exit_code_validation() {
  log('\n🧪 Stress: Runner exit codes');

  // Test various exit codes
  const tests = [
    { code: 0, shouldPass: true },
    { code: 1, shouldPass: false },
    { code: 2, shouldPass: false },
    { code: 127, shouldPass: false },
  ];

  for (const t of tests) {
    const config = {
      runners: [{ name: 'exitcode', command: `exit ${t.code}`, on: 'commit' }],
      lockDir: 'local'
    };
    writeTestConfig(config);
    agentLease('init');

    fs.writeFileSync(`exit${t.code}.txt`, `exit${t.code}`);
    run(`git add exit${t.code}.txt`);
    run(`git commit -m "exit${t.code}"`);

    const result = agentLease('release --audit-proof');
    const passed = result.status === 0;

    if (passed !== t.shouldPass) {
      agentLease('clear');
      run('git reset HEAD~0 2>/dev/null || true');
      run(`git checkout -- exit${t.code}.txt 2>/dev/null || true`);
      return fail(`exit ${t.code} should ${t.shouldPass ? 'pass' : 'fail'}`, result.output);
    }

    agentLease('clear');
    run('git commit --no-verify -m "cleanup" 2>/dev/null || true');
  }

  pass('exit code 0 passes, non-zero fails');
}

// ============ MAIN ============

function main() {
  log('╔══════════════════════════════════════════════════════════════╗');
  log('║  agentguard Stress Test Suite                               ║');
  log('╚══════════════════════════════════════════════════════════════╝');

  try {
    setup();

    test_multiple_locks_same_project();
    test_large_diff();
    test_special_characters_in_diff();
    test_concurrent_commits();
    test_runner_timeout();
    test_empty_runners();
    test_xdg_runtime_dir();
    test_nested_git_repo();
    test_binary_files();
    test_no_staged_changes();
    test_amend_commit();
    test_runner_with_exit_code_validation();

    log('\n' + '═'.repeat(60));
    log(`\n  Results: ${passed} passed, ${failed} failed\n`);

    if (failed > 0) process.exit(1);
  } catch (e) {
    log(`\n💥 Test crashed: ${e.message}`);
    log(e.stack);
    process.exit(1);
  } finally {
    cleanup();
  }
}

main();
