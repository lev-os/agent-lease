#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Lock/Lease Manager for agentguard v2
 *
 * Supports:
 *   - XDG_RUNTIME_DIR for lock storage
 *   - Project-local locks (.agentguard/locks/)
 *   - Env var overrides
 *   - Audit trail with runner output
 */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getLockPath(projectName, lockDir, topic = 'pre-commit') {
  ensureDir(lockDir);
  let shortHash = 'new';
  try {
    shortHash = execSync('git rev-parse --short HEAD 2>/dev/null', {
      encoding: 'utf8'
    }).trim();
  } catch (e) {}
  // Lock: agentguard-{project}-{topic}-{hash}.lock
  // For backwards compat: pre-commit uses no prefix
  const suffix = topic !== 'pre-commit' ? `${topic}-` : '';
  return path.join(lockDir, `agentguard-${projectName}-${suffix}${shortHash}.lock`);
}

function getAllLocks(projectName, lockDir, topic = null) {
  const prefix = `agentguard-${projectName}-`;
  try {
    ensureDir(lockDir);
    let files = fs.readdirSync(lockDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.lock'));

    // Filter by topic if specified
    if (topic === 'pre-push' || topic === 'push') {
      files = files.filter(f => f.includes('-pre-push-') || f.includes('-push-'));
    } else if (topic === 'pre-commit' || topic === 'commit') {
      files = files.filter(f => !f.includes('-pre-push-') && !f.includes('-push-'));
    } else if (topic) {
      files = files.filter(f => f.includes(`-${topic}-`));
    }

    return files.map(f => path.join(lockDir, f));
  } catch (e) {
    return [];
  }
}

function createLock(projectName, lockDir, topic = 'pre-commit') {
  ensureDir(lockDir);
  const lockPath = getLockPath(projectName, lockDir, topic);
  const guid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const content = [
    `LOCK_GUID=${guid}`,
    `CREATED=${new Date().toISOString()}`,
    `PROJECT=${projectName}`,
    `TOPIC=${topic}`,
    `STATUS=PENDING`
  ].join('\n') + '\n';

  fs.writeFileSync(lockPath, content);
  return { lockPath, guid };
}

function checkLock(projectName, lockDir, topic = 'pre-commit') {
  const lockPath = getLockPath(projectName, lockDir, topic);

  if (!fs.existsSync(lockPath)) {
    return { exists: false, lockPath, topic };
  }

  const content = fs.readFileSync(lockPath, 'utf8');
  const auditPassed = content.includes('AUDIT_PROOF_PASSED');

  // Parse lock file
  const lines = content.split('\n');
  const data = {};
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) data[key] = rest.join('=');
  }

  return {
    exists: true,
    auditPassed,
    lockPath,
    content,
    data,
    topic
  };
}

function checkPushLock(projectName, lockDir) {
  return checkLock(projectName, lockDir, 'pre-push');
}

function releaseLock(projectName, lockDir, runnerResults = [], topic = 'pre-commit', options = {}) {
  const lockPath = getLockPath(projectName, lockDir, topic);

  if (!fs.existsSync(lockPath)) {
    return { released: false, reason: 'No lock found', topic };
  }

  let content = fs.readFileSync(lockPath, 'utf8');
  content += `AUDIT_PROOF_PASSED=${new Date().toISOString()}\n`;
  content += `STATUS=VALIDATED\n`;

  // Append runner results summary
  if (runnerResults.length > 0) {
    content += `RUNNERS_COUNT=${runnerResults.length}\n`;
    runnerResults.forEach((r, i) => {
      content += `RUNNER_${i}_NAME=${r.name}\n`;
      content += `RUNNER_${i}_PASSED=${r.passed}\n`;
      content += `RUNNER_${i}_DURATION=${r.duration}ms\n`;
    });

    // Generate git trailer strings for prepare-commit-msg hook
    const proofParts = runnerResults.map(r => {
      const durationSec = (r.duration / 1000).toFixed(1);
      const hash = r.proof ? r.proof.hash : '';
      return hash ? `${r.name}(${durationSec}s):${hash}` : `${r.name}(${durationSec}s)`;
    });
    const totalDurationSec = runnerResults.reduce((sum, r) => sum + r.duration, 0) / 1000;
    content += `GIT_TRAILER_PROOF=${proofParts.join(' ')}\n`;
    content += `GIT_TRAILER_DURATION=${totalDurationSec.toFixed(1)}s\n`;
  }

  // Archive proof files if runner results have proof data
  const projectRoot = options.projectRoot || process.cwd();
  if (runnerResults.some(r => r.proof)) {
    const proofDir = path.join(projectRoot, '.agentguard', 'proofs');
    ensureDir(proofDir);

    // Write individual runner proofs
    runnerResults.forEach(r => {
      if (r.proof && r.proof.output) {
        fs.writeFileSync(path.join(proofDir, `${r.proof.hash}.txt`), r.proof.output);
      }
    });

    // Write consolidated report
    let shortHash = 'new';
    try {
      shortHash = execSync('git rev-parse --short HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
    } catch (e) {}
    const reportName = `${topic}-${shortHash}.json`;
    fs.writeFileSync(path.join(proofDir, reportName), JSON.stringify({
      timestamp: new Date().toISOString(),
      topic,
      runners: runnerResults.map(r => ({
        name: r.name,
        passed: r.passed,
        duration: r.duration,
        summary: r.proof ? r.proof.summary : null,
        hash: r.proof ? r.proof.hash : null
      }))
    }, null, 2));
    content += `GIT_TRAILER_REPORT=${reportName}\n`;
  }

  fs.writeFileSync(lockPath, content);

  return { released: true, lockPath, topic };
}

function releasePushLock(projectName, lockDir, runnerResults = []) {
  return releaseLock(projectName, lockDir, runnerResults, 'pre-push');
}

function clearLock(projectName, lockDir, topic = 'pre-commit') {
  const lockPath = getLockPath(projectName, lockDir, topic);
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
    return { cleared: true, lockPath, topic };
  }
  return { cleared: false, reason: 'No lock found', topic };
}

function clearAllLocks(projectName, lockDir, topic = null) {
  const locks = getAllLocks(projectName, lockDir, topic);
  locks.forEach(l => {
    try { fs.unlinkSync(l); } catch (e) {}
  });
  return { cleared: locks.length, paths: locks, topic };
}

/**
 * Release lock using agent-submitted proof text (v3.2 mode)
 * Instead of running validators internally, the agent has run them
 * and submitted proof of completion.
 *
 * @param {string} projectName
 * @param {string} lockDir
 * @param {string} agentProofText - Raw proof text from agent
 * @param {object} parsedProof - { runners: [{name, status, output}], summary }
 * @param {string} topic - Topic name (e.g., 'pre-commit', 'pre-push', 'custom')
 * @param {object} options - { projectRoot }
 */
function releaseLockWithAgentProof(projectName, lockDir, agentProofText, parsedProof, topic = 'pre-commit', options = {}) {
  const lockPath = getLockPath(projectName, lockDir, topic);

  if (!fs.existsSync(lockPath)) {
    return { released: false, reason: 'No lock found', topic };
  }

  let content = fs.readFileSync(lockPath, 'utf8');
  content += `AUDIT_PROOF_PASSED=${new Date().toISOString()}\n`;
  content += `STATUS=VALIDATED\n`;
  content += `PROOF_MODE=agent\n`;

  // Append runner results from agent proof
  if (parsedProof.runners.length > 0) {
    content += `RUNNERS_COUNT=${parsedProof.runners.length}\n`;
    parsedProof.runners.forEach((r, i) => {
      content += `RUNNER_${i}_NAME=${r.name}\n`;
      content += `RUNNER_${i}_PASSED=${r.status === 'PASS'}\n`;
    });

    // Generate git trailer for proof line: test:PASS haiku-review:PASS
    const proofParts = parsedProof.runners.map(r => `${r.name}:${r.status}`);
    content += `GIT_TRAILER_PROOF=${proofParts.join(' ')}\n`;
  }

  // Agent summary trailer
  if (parsedProof.summary) {
    // Sanitize for single-line trailer: replace newlines, limit length
    const sanitized = parsedProof.summary.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    content += `GIT_TRAILER_AGENT_SUMMARY=${sanitized}\n`;
  }

  // LLM findings trailer (extract from any runner with llm-like names or findings in output)
  const llmRunners = parsedProof.runners.filter(r =>
    r.name.includes('haiku') || r.name.includes('review') || r.name.includes('llm') ||
    r.name.includes('claude') || r.name.includes('opus')
  );
  if (llmRunners.length > 0) {
    const findings = llmRunners
      .map(r => r.output)
      .filter(Boolean)
      .join('; ')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 300);
    if (findings) {
      content += `GIT_TRAILER_LLM_FINDINGS=${findings}\n`;
    }
  }

  // Archive agent proof text
  const projectRoot = options.projectRoot || process.cwd();
  const proofDir = path.join(projectRoot, '.agentguard', 'proofs');
  ensureDir(proofDir);

  // Write raw agent proof
  const proofHash = require('crypto').createHash('sha256').update(agentProofText).digest('hex').slice(0, 7);
  fs.writeFileSync(path.join(proofDir, `${proofHash}-agent.txt`), agentProofText);

  // Write consolidated report
  let shortHash = 'new';
  try {
    shortHash = execSync('git rev-parse --short HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch (e) {}
  const reportName = `${topic}-${shortHash}.json`;
  fs.writeFileSync(path.join(proofDir, reportName), JSON.stringify({
    timestamp: new Date().toISOString(),
    topic,
    proofMode: 'agent',
    agentProofHash: proofHash,
    runners: parsedProof.runners.map(r => ({
      name: r.name,
      status: r.status,
      output: r.output || null
    })),
    summary: parsedProof.summary
  }, null, 2));
  content += `GIT_TRAILER_REPORT=${reportName}\n`;

  fs.writeFileSync(lockPath, content);

  return { released: true, lockPath, topic, proofHash };
}

/**
 * Archive lock to audit trail after successful commit/push
 */
function archiveLock(projectName, lockDir, projectRoot, topic = 'pre-commit') {
  const lockPath = getLockPath(projectName, lockDir, topic);
  if (!fs.existsSync(lockPath)) return { archived: false, topic };

  const auditDir = path.join(projectRoot, '.agentguard', 'audit');
  ensureDir(auditDir);

  const timestamp = Date.now();
  const topicPrefix = topic !== 'pre-commit' ? `${topic}-` : '';
  const archivePath = path.join(auditDir, `${topicPrefix}${timestamp}.lock`);

  fs.copyFileSync(lockPath, archivePath);
  fs.unlinkSync(lockPath);

  return { archived: true, archivePath, topic };
}

module.exports = {
  ensureDir,
  getLockPath,
  getAllLocks,
  createLock,
  checkLock,
  checkPushLock,
  releaseLock,
  releaseLockWithAgentProof,
  releasePushLock,
  clearLock,
  clearAllLocks,
  archiveLock
};
