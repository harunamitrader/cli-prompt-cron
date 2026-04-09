/**
 * cli-prompt-cron daemon
 * Lightweight cron scheduler for AI CLI tools (Claude Code, Gemini CLI, Codex)
 *
 * Watches data/jobs/*.json with Chokidar for hot-reload.
 * Runs commands via shell when cron fires.
 * Logs output to data/logs/YYYY-MM-DD.log
 * Saves execution results to data/results/<jobName>-<timestamp>.txt
 */

import { watch } from 'chokidar';
import cron from 'node-cron';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname   = dirname(fileURLToPath(import.meta.url));
const BASE_DIR    = join(__dirname, 'data');
const JOBS_DIR    = join(BASE_DIR, 'jobs');
const LOGS_DIR    = join(BASE_DIR, 'logs');
const RESULTS_DIR = join(BASE_DIR, 'results');
const PIDS_DIR    = join(BASE_DIR, 'pids');
const SESSIONS_DIR = join(BASE_DIR, 'sessions');
const SETTINGS_PATH = join(BASE_DIR, 'settings.json');
const JOB_SESSION_USAGE_PATH = join(SESSIONS_DIR, 'job-usage.json');
const FALLBACK_WORKDIR = process.env.CLI_PROMPT_CRON_WORKDIR || resolve(__dirname, '..', '..', '..', '..');
const CODEX_SESSION_INDEX_PATH = resolve(process.env.USERPROFILE || process.env.HOME || '', '.codex', 'session_index.jsonl');

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const tasks = new Map();

/** @type {Set<import('node:child_process').ChildProcess>} */
const runningChildren = new Set();

// ── Logging ──────────────────────────────────────────────────────────────────

function todayLogPath() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return join(LOGS_DIR, `${yyyy}-${mm}-${dd}.log`);
}

function log(tag, message) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${tag}] ${message}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(todayLogPath(), line, 'utf8');
  } catch {
    // best-effort — don't crash the daemon over a log write failure
  }
}

// ── Shell detection ───────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === 'win32';
const TIMEOUT_MS = (parseInt(process.env.JOB_TIMEOUT_MINUTES, 10) || 60) * 60 * 1000;

function shellArgs(command) {
  return IS_WINDOWS
    ? ['powershell', ['-Command', command]] // cmd /c mangles double-quoted args
    : ['sh',  ['-c', command]];
}

function loadSettings() {
  try {
    if (!existsSync(SETTINGS_PATH)) {
      return { defaultWorkdir: FALLBACK_WORKDIR };
    }
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    const defaultWorkdir = typeof raw.defaultWorkdir === 'string' && raw.defaultWorkdir.trim()
      ? raw.defaultWorkdir.trim()
      : FALLBACK_WORKDIR;
    return { defaultWorkdir };
  } catch {
    return { defaultWorkdir: FALLBACK_WORKDIR };
  }
}

function isValidLogId(value) {
  return /^\d{4}$/.test(String(value || '').trim());
}

function hasDuplicateLogId(currentFilePath, logId) {
  let files = [];
  try {
    files = readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return false;
  }

  for (const filename of files) {
    const fullPath = join(JOBS_DIR, filename);
    if (fullPath === currentFilePath) continue;
    try {
      const raw = JSON.parse(readFileSync(fullPath, 'utf8'));
      const otherLogId = typeof raw.logId === 'string' ? raw.logId.trim() : '';
      if (otherLogId === logId) return true;
    } catch {
      /* ignore broken files */
    }
  }

  return false;
}

function normalizeTargetCli(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'gemini' || v === 'geminicli') return 'gemini';
  if (v === 'claude' || v === 'claudecode') return 'claude';
  if (v === 'codex' || v === 'codexcli') return 'codex';
  return null;
}

function normalizePermissionProfile(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['safe', 'edit', 'plan', 'full'].includes(v) ? v : null;
}

function normalizeSessionStrategy(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'fresh';
  if (raw.toLowerCase() === 'fresh') return 'fresh';
  const match = raw.match(/^session:(.+)$/i);
  if (match && match[1].trim()) return `session:${match[1].trim()}`;
  return 'fresh';
}

function parseSessionStrategy(value) {
  const normalized = normalizeSessionStrategy(value);
  if (normalized === 'fresh') return { mode: 'fresh', sessionId: null, value: 'fresh' };
  return { mode: 'selected', sessionId: normalized.slice('session:'.length), value: normalized };
}

function parseLegacyCommand(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return { targetCli: null, permissionProfile: null, prompt: '' };

  const toolMatch = raw.match(/^([^\s"']+)/);
  const targetCli = normalizeTargetCli(toolMatch ? toolMatch[1] : '');
  let prompt = '';
  const pArgMatch = raw.match(/\s-p\s+(['"])([\s\S]*?)\1\s*$/);
  if (pArgMatch) {
    prompt = pArgMatch[2];
  } else {
    const tailQuoteMatch = raw.match(/(['"])([\s\S]*?)\1\s*$/);
    prompt = tailQuoteMatch ? tailQuoteMatch[2] : raw;
  }

  let permissionProfile = null;
  if (targetCli === 'gemini') {
    if (/--approval-mode=yolo\b|--yolo\b/i.test(raw)) permissionProfile = 'full';
    else if (/--approval-mode=plan\b/i.test(raw)) permissionProfile = 'plan';
    else if (/--approval-mode=auto_edit\b/i.test(raw)) permissionProfile = 'edit';
    else permissionProfile = 'safe';
  } else if (targetCli === 'claude') {
    if (/--permission-mode\s+bypassPermissions\b|--dangerously-skip-permissions\b/i.test(raw)) permissionProfile = 'full';
    else if (/--permission-mode\s+plan\b/i.test(raw)) permissionProfile = 'plan';
    else if (/--permission-mode\s+acceptEdits\b/i.test(raw)) permissionProfile = 'edit';
    else permissionProfile = 'safe';
  } else if (targetCli === 'codex') {
    if (/--full-auto\b|--dangerously-bypass-approvals-and-sandbox\b/i.test(raw)) permissionProfile = 'full';
    else if (/--sandbox\s+workspace-write\b/i.test(raw)) permissionProfile = 'edit';
    else permissionProfile = 'safe';
  }

  return { targetCli, permissionProfile, prompt };
}

function escapeSingleQuotedPrompt(prompt) {
  return String(prompt || '').replace(/'/g, "''");
}

function sessionRecordPath(sessionId) {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

function makeSessionKey(jobName, logId) {
  const base = (logId || jobName || 'job').toString().trim();
  return `cli-prompt-cron-${base}`;
}

function readSessionRecord(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(sessionRecordPath(sessionId), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function readLegacyJobSessionRecord(jobName) {
  try {
    const raw = JSON.parse(readFileSync(join(SESSIONS_DIR, `${jobName}.json`), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeSessionRecord(record) {
  try {
    if (!record?.sessionId) return;
    writeFileSync(sessionRecordPath(record.sessionId), JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

function updateJobSessionUsage(jobName, sessionId) {
  try {
    let usage = {};
    try {
      usage = JSON.parse(readFileSync(JOB_SESSION_USAGE_PATH, 'utf8'));
    } catch {
      usage = {};
    }
    usage[jobName] = {
      sessionId,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(JOB_SESSION_USAGE_PATH, JSON.stringify(usage, null, 2) + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}

function readJobSessionUsage() {
  try {
    const raw = JSON.parse(readFileSync(JOB_SESSION_USAGE_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function findSessionOwnerById(sessionId) {
  const direct = readSessionRecord(sessionId);
  if (direct?.sessionId === sessionId) {
    return { jobName: direct.jobName || direct.lastUsedByJob || '', record: direct };
  }

  let files = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json') && f !== basename(JOB_SESSION_USAGE_PATH));
  } catch {
    return null;
  }

  for (const file of files) {
    const name = basename(file, '.json');
    const record = readLegacyJobSessionRecord(name);
    if (record?.sessionId === sessionId) return { jobName: record.jobName || name, record };
  }
  return null;
}

function touchSelectedSession(sessionId, usedByJobName) {
  const owner = findSessionOwnerById(sessionId);
  if (!owner) return null;
  const next = {
    ...owner.record,
    lastUsedAt: new Date().toISOString(),
    lastUsedByJob: usedByJobName,
  };
  writeSessionRecord(next);
  return { ownerJobName: owner.jobName, record: next };
}

function deleteSessionRecord(jobName, removeUsage = false) {
  try {
    const legacyPath = join(SESSIONS_DIR, `${jobName}.json`);
    unlinkSync(legacyPath);
  } catch {
    /* ignore */
  }
  if (removeUsage) {
    try {
      const usage = JSON.parse(readFileSync(JOB_SESSION_USAGE_PATH, 'utf8'));
      if (usage && typeof usage === 'object' && jobName in usage) {
        delete usage[jobName];
        writeFileSync(JOB_SESSION_USAGE_PATH, JSON.stringify(usage, null, 2) + '\n', 'utf8');
      }
    } catch {
      /* ignore */
    }
  }
}

function findLatestCodexSessionId(sinceIso) {
  try {
    const content = readFileSync(CODEX_SESSION_INDEX_PATH, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const since = Date.parse(sinceIso);
    const candidates = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (!row.id || !row.updated_at) continue;
        const updatedAt = Date.parse(row.updated_at);
        if (Number.isNaN(updatedAt)) continue;
        if (!Number.isNaN(since) && updatedAt < since) continue;
        candidates.push({ id: row.id, updatedAt });
      } catch {
        /* ignore broken row */
      }
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    return candidates[0]?.id || null;
  } catch {
    return null;
  }
}

/**
 * Run `gemini --list-sessions` synchronously from the given workdir and return
 * the set of session UUIDs found in its output.
 * @param {string} workdir
 * @returns {Set<string>}
 */
function listGeminiSessionIdsSync(workdir) {
  try {
    const [bin, args] = shellArgs('gemini --list-sessions');
    const result = spawnSync(bin, args, { cwd: workdir, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const output = (result.stdout || '') + (result.stderr || '');
    const uuids = new Set();
    for (const m of output.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi)) {
      uuids.add(m[1]);
    }
    return uuids;
  } catch {
    return new Set();
  }
}

function buildCommand(targetCli, permissionProfile, prompt, sessionStrategy = 'fresh', sessionRecord = null, model = null) {
  const target = normalizeTargetCli(targetCli) || 'gemini';
  const profile = normalizePermissionProfile(permissionProfile) || 'safe';
  const strategy = parseSessionStrategy(sessionStrategy);
  const quotedPrompt = `'${escapeSingleQuotedPrompt(prompt)}'`;
  const modelFlag = model ? ` -m ${model}` : '';

  if (target === 'gemini') {
    const flagsByProfile = {
      safe: '',
      edit: '--approval-mode=auto_edit',
      plan: '--approval-mode=plan',
      full: '--approval-mode=yolo',
    };
    const flags = flagsByProfile[profile];
    const baseFlags = `${modelFlag}${flags ? ' ' + flags : ''}`;
    if (strategy.mode === 'selected' && strategy.sessionId) {
      return {
        command: `gemini${baseFlags} --resume ${strategy.sessionId} -p ${quotedPrompt}`,
        sessionEffectiveStrategy: `session:${strategy.sessionId}`,
        sessionWarning: null,
        selectedSessionId: strategy.sessionId,
      };
    }
    return { command: `gemini${baseFlags} -p ${quotedPrompt}`, sessionEffectiveStrategy: 'fresh', sessionWarning: null, selectedSessionId: null };
  }

  if (target === 'claude') {
    if (strategy.mode === 'selected') {
      return {
        command: `claude${modelFlag} --permission-mode ${profile === 'edit' ? 'acceptEdits' : profile === 'plan' ? 'plan' : profile === 'full' ? 'bypassPermissions' : 'default'} -p ${quotedPrompt}`,
        sessionEffectiveStrategy: 'fresh',
        sessionWarning: 'selected session is not supported for Claude Code yet; falling back to fresh',
        selectedSessionId: strategy.sessionId,
      };
    }
    const modeByProfile = {
      safe: 'default',
      edit: 'acceptEdits',
      plan: 'plan',
      full: 'bypassPermissions',
    };
    return { command: `claude${modelFlag} --permission-mode ${modeByProfile[profile]} -p ${quotedPrompt}`, sessionEffectiveStrategy: 'fresh', sessionWarning: null, selectedSessionId: null };
  }

  const codexFlagsByProfile = {
    safe: '--sandbox read-only',
    edit: '--sandbox workspace-write',
    plan: '--sandbox read-only',
    full: '--dangerously-bypass-approvals-and-sandbox',
  };
  if (strategy.mode === 'selected' && strategy.sessionId) {
    const resumeFlags = profile === 'full' ? ' --dangerously-bypass-approvals-and-sandbox' : '';
    return {
      command: `codex exec${modelFlag} resume ${strategy.sessionId}${resumeFlags} ${quotedPrompt}`,
      sessionEffectiveStrategy: `session:${strategy.sessionId}`,
      sessionWarning: null,
      selectedSessionId: strategy.sessionId,
    };
  }
  return {
    command: `codex exec${modelFlag} ${codexFlagsByProfile[profile]} ${quotedPrompt}`,
    sessionEffectiveStrategy: 'fresh',
    sessionWarning: null,
    selectedSessionId: null,
  };
}

// ── Job runner ────────────────────────────────────────────────────────────────

/**
 * Spawn a shell command, stream stdout/stderr to the log, and write a result
 * file to RESULTS_DIR on exit.
 * @param {string} jobName
 * @param {string} logTag
 * @param {string} command
 * @param {{ targetCli: string, permissionProfile: string, prompt: string, sessionStrategy: string, sessionEffectiveStrategy: string, sessionKey?: string | null, sessionWarning?: string | null, selectedSessionId?: string | null }} context
 */
function runCommand(jobName, logTag, command, context) {
  const settings = loadSettings();
  const workdir = settings.defaultWorkdir;
  const startedAt = new Date().toISOString();
  const sessionStrategyLabel = context.sessionEffectiveStrategy || context.sessionStrategy || 'fresh';
  if (context.sessionWarning) log(logTag, `SESSION → ${context.sessionWarning}`);
  log(logTag, `SESSION → strategy=${sessionStrategyLabel}${context.sessionKey ? ` key=${context.sessionKey}` : ''}`);
  log(logTag, `FIRE → ${command}`);
  log(logTag, `CWD  → ${workdir}`);

  // Capture Gemini session IDs before run (for fresh session detection after exit)
  const preGeminiSessionIds = (context.targetCli === 'gemini' && context.sessionEffectiveStrategy === 'fresh')
    ? listGeminiSessionIdsSync(workdir)
    : null;

  const [bin, args] = shellArgs(command);
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: workdir,
  });

  runningChildren.add(child);

  // Auto-kill after timeout
  const timeout = setTimeout(() => {
    log(logTag, `TIMEOUT — process exceeded ${TIMEOUT_MS / 60000} minutes, killing…`);
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 5000);
  }, TIMEOUT_MS);
  child.on('close', () => clearTimeout(timeout));

  // Write PID to pid file (array of running processes)
  const pidFile = join(PIDS_DIR, `${jobName}.json`);
  const pidEntry = { pid: child.pid, command, startedAt, logTag };
  try {
    let pids = [];
    try { pids = JSON.parse(readFileSync(pidFile, 'utf8')); } catch { /* new file */ }
    if (!Array.isArray(pids)) pids = [];
    pids.push(pidEntry);
    writeFileSync(pidFile, JSON.stringify(pids) + '\n', 'utf8');
  } catch { /* best-effort */ }

  /** @type {string[]} */
  const stdoutLines = [];
  let detectedSessionId = null;

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) {
        log(`${logTag}/stdout`, line);
        stdoutLines.push(line);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) {
        const sessionMatch = line.match(/session id:\s*([0-9a-f-]+)/i);
        if (sessionMatch) detectedSessionId = sessionMatch[1];
        log(`${logTag}/stderr`, line);
      }
    }
  });

  child.on('error', (err) => {
    log(`${logTag}/error`, `spawn error: ${err.message}`);
  });

  child.on('close', (code) => {
    runningChildren.delete(child);
    log(logTag, `EXIT code=${code ?? '?'}`);

    let resultSessionId = context.selectedSessionId || null;
    let resultSessionSourceJob = null;

    if (context.targetCli === 'codex' && context.selectedSessionId) {
      const selected = touchSelectedSession(context.selectedSessionId, jobName);
      if (selected) resultSessionSourceJob = selected.ownerJobName;
      updateJobSessionUsage(jobName, context.selectedSessionId);
    }

    if (context.targetCli === 'gemini' && context.sessionEffectiveStrategy === 'fresh' && preGeminiSessionIds !== null) {
      const postGeminiSessionIds = listGeminiSessionIdsSync(workdir);
      const newIds = [...postGeminiSessionIds].filter((id) => !preGeminiSessionIds.has(id));
      if (newIds.length > 0) {
        const sessionId = newIds[0];
        writeSessionRecord({
          jobName,
          logId: logTag,
          targetCli: 'gemini',
          permissionProfile: context.permissionProfile,
          sessionStrategy: 'fresh',
          sessionKey: context.sessionKey || makeSessionKey(jobName, logTag),
          sessionId,
          createdAt: startedAt,
          lastUsedAt: new Date().toISOString(),
          lastUsedByJob: jobName,
        });
        updateJobSessionUsage(jobName, sessionId);
        resultSessionId = sessionId;
        resultSessionSourceJob = jobName;
        log(logTag, `SESSION → Gemini session detected: ${sessionId}`);
      } else {
        log(logTag, 'SESSION → no new Gemini session found after run');
      }
    }

    if (context.targetCli === 'codex' && context.sessionEffectiveStrategy === 'fresh') {
      const sessionId = detectedSessionId || findLatestCodexSessionId(startedAt);
      if (sessionId) {
        writeSessionRecord({
          jobName,
          logId: logTag,
          targetCli: context.targetCli,
          permissionProfile: context.permissionProfile,
          sessionStrategy: 'fresh',
          sessionKey: context.sessionKey || makeSessionKey(jobName, logTag),
          sessionId,
          createdAt: startedAt,
          lastUsedAt: new Date().toISOString(),
          lastUsedByJob: jobName,
        });
        updateJobSessionUsage(jobName, sessionId);
        resultSessionId = sessionId;
        resultSessionSourceJob = jobName;
        log(logTag, `SESSION → updated sessionId=${sessionId}`);
      } else {
        log(logTag, 'SESSION → no session id found in Codex session index after run');
      }
    }

    // Remove this PID from pid file
    try {
      let pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      if (Array.isArray(pids)) {
        pids = pids.filter(p => p.pid !== child.pid);
        if (pids.length > 0) {
          writeFileSync(pidFile, JSON.stringify(pids) + '\n', 'utf8');
        } else {
          unlinkSync(pidFile);
        }
      } else {
        unlinkSync(pidFile);
      }
    } catch { /* ignore */ }

    // Save collected stdout to a result file
    try {
      // Replace colons with dashes so the filename is valid on Windows
      const ts       = new Date().toISOString().replace(/:/g, '-');
      const filename = `${jobName}-${ts}.txt`;
      const filePath = join(RESULTS_DIR, filename);
      const headerLines = [
        `job: ${jobName}`,
        `logId: ${logTag}`,
        `targetCli: ${context.targetCli}`,
        `permissionProfile: ${context.permissionProfile}`,
        `sessionStrategy: ${context.sessionStrategy || 'fresh'}`,
        `sessionEffectiveStrategy: ${context.sessionEffectiveStrategy || 'fresh'}`,
        `sessionId: ${resultSessionId || ''}`,
        `sessionSourceJob: ${resultSessionSourceJob || ''}`,
        `runAt: ${startedAt}`,
        '',
      ];
      writeFileSync(filePath, headerLines.join('\n') + stdoutLines.join('\n'), 'utf8');
      log(logTag, `Result saved → ${filename}`);
    } catch (err) {
      log(logTag, `Failed to save result: ${err.message}`);
    }
  });
}

// ── Job registration ──────────────────────────────────────────────────────────

/**
 * Parse a job file, validate it, and return a job object.
 * Returns null on any error.
 * @param {string} filePath
 * @returns {{ name: string, logId: string, targetCli: string, permissionProfile: string, sessionStrategy: string, sessionKey: string, prompt: string, command: string, sessionEffectiveStrategy: string, selectedSessionId: string | null, sessionWarning: string | null, timezone?: string, active: boolean } | null}
 */
function parseJob(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    log('daemon', `Cannot read ${filePath}: ${err.message}`);
    return null;
  }

  let job;
  try {
    job = JSON.parse(raw);
  } catch (err) {
    log('daemon', `Invalid JSON in ${filePath}: ${err.message}`);
    return null;
  }

  if (typeof job.cron !== 'string' || !job.cron.trim()) {
    log('daemon', `Missing or invalid "cron" field in ${filePath}`);
    return null;
  }

  if (!cron.validate(job.cron)) {
    log('daemon', `Invalid cron expression "${job.cron}" in ${filePath}`);
    return null;
  }

  const legacy = parseLegacyCommand(job.command);
  const targetCli = normalizeTargetCli(job.targetCli) || legacy.targetCli;
  const permissionProfile = normalizePermissionProfile(job.permissionProfile) || legacy.permissionProfile || 'safe';
  const jobName = basename(filePath, '.json');
  const jobUsage = readJobSessionUsage();
  const recentSessionId = jobUsage[jobName]?.sessionId || null;
  const sessionRecord = recentSessionId
    ? readSessionRecord(recentSessionId)
    : readLegacyJobSessionRecord(jobName);
  const legacyStrategy = String(job.sessionMode || '').trim().toLowerCase() === 'persistent' && sessionRecord?.sessionId
    ? `session:${sessionRecord.sessionId}`
    : 'fresh';
  const sessionStrategy = normalizeSessionStrategy(job.sessionStrategy || legacyStrategy);
  const prompt = typeof job.prompt === 'string' && job.prompt.trim()
    ? job.prompt.trim()
    : legacy.prompt;

  if (!targetCli) {
    log('daemon', `Missing or invalid "targetCli" field in ${filePath}`);
    return null;
  }

  if (!normalizePermissionProfile(permissionProfile)) {
    log('daemon', `Missing or invalid "permissionProfile" field in ${filePath}`);
    return null;
  }

  if (!prompt) {
    log('daemon', `Missing or invalid "prompt" field in ${filePath}`);
    return null;
  }

  const settings = loadSettings();
  if (!existsSync(settings.defaultWorkdir)) {
    log('daemon', `Configured default workdir was not found: ${settings.defaultWorkdir}`);
    return null;
  }

  const logId = typeof job.logId === 'string' ? job.logId.trim() : '';
  if (!isValidLogId(logId)) {
    log('daemon', `Missing or invalid "logId" field in ${filePath}; expected a unique 4-digit number`);
    return null;
  }

  if (hasDuplicateLogId(filePath, logId)) {
    log('daemon', `Duplicate "logId" value "${logId}" in ${filePath}`);
    return null;
  }

  const name = jobName;
  const sessionKey = makeSessionKey(name, logId);
  const model = typeof job.model === 'string' && job.model.trim() ? job.model.trim() : null;
  const commandInfo = buildCommand(targetCli, permissionProfile, prompt, sessionStrategy, sessionRecord, model);

  return {
    name,
    logId,
    targetCli,
    permissionProfile,
    sessionStrategy,
    sessionKey,
    prompt,
    model: model || null,
    cron:     job.cron.trim(),
    command:  commandInfo.command,
    sessionEffectiveStrategy: commandInfo.sessionEffectiveStrategy,
    selectedSessionId: commandInfo.selectedSessionId,
    sessionWarning: commandInfo.sessionWarning,
    timezone: typeof job.timezone === 'string' ? job.timezone.trim() : undefined,
    active:   job.active !== false, // default true
  };
}

/**
 * Register (or re-register) a job from a file path.
 * If the job already exists it will be stopped and replaced.
 * @param {string} filePath
 */
function registerJob(filePath) {
  const job = parseJob(filePath);
  if (!job) return;

  // Stop existing task if re-registering
  stopJob(job.name, false);

  if (!job.active) {
    log('daemon', `Job "${job.name}" is inactive (active: false) — registered but not scheduled`);
    return;
  }

  const options = {};
  if (job.timezone) {
    options.timezone = job.timezone;
  }

  let task;
  try {
    task = cron.schedule(job.cron, () => runCommand(job.name, job.logId, job.command, {
      targetCli: job.targetCli,
      permissionProfile: job.permissionProfile,
      prompt: job.prompt,
      sessionStrategy: job.sessionStrategy,
      sessionEffectiveStrategy: job.sessionEffectiveStrategy,
      sessionKey: job.sessionKey,
      sessionWarning: job.sessionWarning,
      selectedSessionId: job.selectedSessionId,
    }), options);
  } catch (err) {
    log('daemon', `Failed to schedule job "${job.name}": ${err.message}`);
    return;
  }

  tasks.set(job.name, task);
  log('daemon', `Job "${job.name}" scheduled — cron="${job.cron}"${job.timezone ? ` tz=${job.timezone}` : ''} session=${job.sessionStrategy} cwd="${loadSettings().defaultWorkdir}"`);
}

/**
 * Stop and remove a named task.
 * @param {string} name
 * @param {boolean} [logIt=true]
 */
function stopJob(name, logIt = true) {
  const existing = tasks.get(name);
  if (existing) {
    try { existing.stop(); } catch { /* ignore */ }
    tasks.delete(name);
    if (logIt) log('daemon', `Job "${name}" stopped and removed`);
  }
}

/**
 * Derive the job name from a file path and stop its task.
 * @param {string} filePath
 */
function unregisterJob(filePath) {
  const name = basename(filePath, '.json');
  stopJob(name);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function ensureDirs() {
  mkdirSync(JOBS_DIR,    { recursive: true });
  mkdirSync(LOGS_DIR,    { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(PIDS_DIR,    { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  if (!existsSync(JOB_SESSION_USAGE_PATH)) {
    writeFileSync(JOB_SESSION_USAGE_PATH, '{}\n', 'utf8');
  }
}

function loadExistingJobs() {
  let files;
  try {
    files = readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  } catch (err) {
    log('daemon', `Could not read jobs dir: ${err.message}`);
    return;
  }

  if (files.length === 0) {
    log('daemon', 'No existing job files found');
    return;
  }

  log('daemon', `Loading ${files.length} existing job(s)…`);
  for (const file of files) {
    registerJob(join(JOBS_DIR, file));
  }
}

function startWatcher() {
  // chokidar v4+ dropped glob support — watch the directory and filter by ext
  const watcher = watch(JOBS_DIR, {
    persistent:    true,
    ignoreInitial: true, // we load existing jobs manually above
    usePolling:    IS_WINDOWS, // Windows native fs.watch misses overwrites
    interval:      500,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval:       100,
    },
  });

  const isJob = (p) => p.endsWith('.json');
  watcher
    .on('add',    (p) => { if (!isJob(p)) return; log('daemon', `File added: ${basename(p)}`);   registerJob(p); })
    .on('change', (p) => { if (!isJob(p)) return; log('daemon', `File changed: ${basename(p)}`); registerJob(p); })
    .on('unlink', (p) => { if (!isJob(p)) return; log('daemon', `File removed: ${basename(p)}`); unregisterJob(p); })
    .on('error',  (err) => log('daemon', `Watcher error: ${err.message}`));

  log('daemon', `Watching ${JOBS_DIR} for changes…`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  log('daemon', `Received ${signal} — stopping all tasks…`);
  for (const [name, task] of tasks) {
    try { task.stop(); } catch { /* ignore */ }
    log('daemon', `Stopped task: ${name}`);
  }
  tasks.clear();

  // Kill all running child processes
  if (runningChildren.size > 0) {
    log('daemon', `Killing ${runningChildren.size} running process(es)…`);
    for (const child of runningChildren) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    // Force kill after 2 seconds
    setTimeout(() => {
      for (const child of runningChildren) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      // Clean up PID files
      try {
        for (const f of readdirSync(PIDS_DIR)) { try { unlinkSync(join(PIDS_DIR, f)); } catch { /* ignore */ } }
      } catch { /* ignore */ }
      log('daemon', 'Goodbye.');
      process.exit(0);
    }, 2000);
  } else {
    log('daemon', 'Goodbye.');
    process.exit(0);
  }
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Windows Ctrl+C
if (IS_WINDOWS) {
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

// Catch unhandled rejections so the daemon keeps running
process.on('unhandledRejection', (reason) => {
  log('daemon', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  log('daemon', `Uncaught exception: ${err.message}\n${err.stack}`);
});

// ── Main ──────────────────────────────────────────────────────────────────────

log('daemon', '─────────────────────────────────────────');
log('daemon', 'cli-prompt-cron daemon starting');
log('daemon', `Jobs dir    : ${JOBS_DIR}`);
log('daemon', `Logs dir    : ${LOGS_DIR}`);
log('daemon', `Results dir : ${RESULTS_DIR}`);
log('daemon', `Platform    : ${process.platform}`);
log('daemon', `Job timeout : ${TIMEOUT_MS / 60000} minutes`);
log('daemon', '─────────────────────────────────────────');

ensureDirs();
loadExistingJobs();
startWatcher();

log('daemon', 'Ready. Waiting for jobs…');
