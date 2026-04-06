/**
 * cli-prompt-cron — lightweight dashboard HTTP server
 *
 * No npm dependencies — uses Node.js built-ins only.
 * Port: process.env.PORT or 3300
 *
 * Endpoints:
 *   GET /                      → serve public/index.html
 *   GET /api/jobs              → JSON list of all job definitions
 *   GET /api/results           → JSON list of recent result files (50 max)
 *   GET /api/results/:filename → raw text content of a result file
 *   GET /api/logs/stream       → SSE stream of today's log file
 */

import http from 'node:http';
import fs, { watchFile, unwatchFile } from 'node:fs';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import cron from 'node-cron';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname   = dirname(fileURLToPath(import.meta.url));
const BASE_DIR    = join(__dirname, 'data');
const JOBS_DIR    = join(BASE_DIR, 'jobs');
const LOGS_DIR    = join(BASE_DIR, 'logs');
const RESULTS_DIR = join(BASE_DIR, 'results');
const PIDS_DIR    = join(BASE_DIR, 'pids');
const SESSIONS_DIR = join(BASE_DIR, 'sessions');
const PUBLIC_DIR  = join(__dirname, 'public');
const SETTINGS_PATH = join(BASE_DIR, 'settings.json');
const JOB_SESSION_USAGE_PATH = join(SESSIONS_DIR, 'job-usage.json');
const FALLBACK_WORKDIR = process.env.CLI_PROMPT_CRON_WORKDIR || resolve(__dirname, '..', '..', '..', '..');
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const PORT = Number(process.env.PORT) || 3300;
const IS_WINDOWS = process.platform === 'win32';

// ── SSE client registry ───────────────────────────────────────────────────────

/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayLogPath() {
  const d    = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return join(LOGS_DIR, `${yyyy}-${mm}-${dd}.log`);
}

/**
 * Read the last N lines of a file. Returns an empty array if the file does not
 * exist or cannot be read.
 * @param {string} filePath
 * @param {number} n
 * @returns {string[]}
 */
function tailLines(filePath, n) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines   = content.split('\n').filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Send CORS + cache headers suitable for API responses.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} contentType
 */
function sendHeaders(res, status, contentType) {
  res.writeHead(status, {
    'Content-Type':                contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-cache',
  });
}

/**
 * Send a JSON response.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  sendHeaders(res, status, 'application/json; charset=utf-8');
  res.end(body);
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

function saveSettings(settings) {
  const normalized = {
    defaultWorkdir: typeof settings.defaultWorkdir === 'string' && settings.defaultWorkdir.trim()
      ? settings.defaultWorkdir.trim()
      : FALLBACK_WORKDIR,
  };
  writeFileSync(SETTINGS_PATH, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return normalized;
}

function isValidLogId(value) {
  return /^\d{4}$/.test(String(value || '').trim());
}

function isValidJobName(value) {
  const name = String(value || '').trim();
  return Boolean(name)
    && !name.includes('..')
    && !name.includes('/')
    && !name.includes('\\')
    && !/[<>:"|?*]/.test(name);
}

function collectOtherLogIds(currentJobName) {
  const ids = new Set();
  let files = [];
  try {
    files = readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return ids;
  }

  for (const filename of files) {
    const name = basename(filename, '.json');
    if (name === currentJobName) continue;
    try {
      const raw = JSON.parse(readFileSync(join(JOBS_DIR, filename), 'utf8'));
      const logId = typeof raw.logId === 'string' ? raw.logId.trim() : '';
      if (isValidLogId(logId)) ids.add(logId);
    } catch {
      /* ignore broken job files */
    }
  }

  return ids;
}

/**
 * Append a line to today's log file (shared with daemon).
 * @param {string} tag
 * @param {string} message
 */
function appendLog(tag, message) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${tag}] ${message}\n`;
  try { appendFileSync(todayLogPath(), line, 'utf8'); } catch { /* ignore */ }
}

function shellArgs(command) {
  return IS_WINDOWS
    ? ['powershell', ['-Command', command]]
    : ['sh', ['-c', command]];
}

/**
 * Check whether a PID is still alive.
 * Treat EPERM as alive (e.g., on Windows when permission is denied).
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Best-effort kill of a PID (and its children on Windows).
 * @param {number} pid
 * @returns {boolean} whether a kill command was issued
 */
function killProcessTree(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  let sent = false;
  try { process.kill(pid, 'SIGTERM'); sent = true; } catch (err) { if (err.code !== 'ESRCH') return false; }
  setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }, 1000);
  return sent;
}

/**
 * Extract a compact command summary for UI cards.
 * @param {string | null | undefined} cmd
 * @returns {{ tool: string|null, prompt: string, flags: string }}
 */
function summarizeCommand(cmd) {
  if (!cmd) return { tool: null, prompt: '', flags: '' };

  const trimmed = String(cmd).trim();
  const toolMatch = trimmed.match(/^([^\s"']+)/);
  const tool = toolMatch ? toolMatch[1] : null;

  let prompt = '';
  const pArgMatch = trimmed.match(/\s-p\s+(['"])([\s\S]*?)\1\s*$/);
  if (pArgMatch) {
    prompt = pArgMatch[2];
  } else {
    const tailQuoteMatch = trimmed.match(/(['"])([\s\S]*?)\1\s*$/);
    prompt = tailQuoteMatch ? tailQuoteMatch[2] : trimmed;
  }

  const flagParts = trimmed.match(/--[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\s]+))?/g) || [];
  const flags = flagParts.join(' ');

  return { tool, prompt, flags };
}

function escapeSingleQuotedPrompt(prompt) {
  return String(prompt || '').replace(/'/g, "''");
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

function sessionRecordPath(sessionId) {
  return join(SESSIONS_DIR, `${sessionId}.json`);
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

function formatSessionLabelTimestamp(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function buildSessionLabel(record, fallbackName) {
  const jobName = record.jobName || fallbackName || 'session';
  const timestamp = formatSessionLabelTimestamp(record.createdAt || record.lastUsedAt);
  const shortId = record.sessionId ? record.sessionId.slice(-8) : null;
  const parts = [`${record.logId || '----'} ${jobName}`];
  if (timestamp) parts.push(timestamp);
  if (shortId) parts.push(`#${shortId}`);
  return parts.join(' / ');
}

function readJobSessionUsage() {
  try {
    const raw = JSON.parse(readFileSync(JOB_SESSION_USAGE_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function listManagedSessions() {
  let files = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json') && f !== basename(JOB_SESSION_USAGE_PATH));
  } catch {
    return [];
  }

  const sessions = new Map();
  for (const file of files) {
    const fileKey = basename(file, '.json');
    const direct = readSessionRecord(fileKey);
    const legacy = direct?.sessionId ? null : readLegacyJobSessionRecord(fileKey);
    const record = direct?.sessionId ? direct : legacy;
    if (!record?.sessionId) continue;
    sessions.set(record.sessionId, {
      jobName: record.jobName || fileKey,
      sessionId: record.sessionId,
      logId: record.logId || '',
      targetCli: record.targetCli || 'codex',
      permissionProfile: record.permissionProfile || 'safe',
      sessionKey: record.sessionKey || '',
      createdAt: record.createdAt || null,
      lastUsedAt: record.lastUsedAt || null,
      lastUsedByJob: record.lastUsedByJob || null,
      label: buildSessionLabel(record, fileKey),
    });
  }
  return Array.from(sessions.values()).sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
}

function findManagedSessionById(sessionId) {
  return listManagedSessions().find((session) => session.sessionId === sessionId) || null;
}

function buildCommand(targetCli, permissionProfile, prompt, sessionStrategy, sessionRecord) {
  const target = normalizeTargetCli(targetCli) || 'gemini';
  const profile = ['safe', 'edit', 'plan', 'full'].includes(String(permissionProfile || '').trim().toLowerCase())
    ? String(permissionProfile).trim().toLowerCase()
    : 'safe';
  const strategy = parseSessionStrategy(sessionStrategy);
  const quotedPrompt = `'${escapeSingleQuotedPrompt(prompt)}'`;

  if (target === 'gemini') {
    const flagsByProfile = {
      safe: '',
      edit: '--approval-mode=auto_edit',
      plan: '--approval-mode=plan',
      full: '--approval-mode=yolo',
    };
    const flags = flagsByProfile[profile];
    return {
      command: `gemini${flags ? ' ' + flags : ''} -p ${quotedPrompt}`,
      sessionEffectiveStrategy: 'fresh',
      sessionWarning: strategy.mode === 'selected' ? 'selected session is not supported for Gemini yet; falling back to fresh' : null,
    };
  }

  if (target === 'claude') {
    const modeByProfile = {
      safe: 'default',
      edit: 'acceptEdits',
      plan: 'plan',
      full: 'bypassPermissions',
    };
    return {
      command: `claude --permission-mode ${modeByProfile[profile]} -p ${quotedPrompt}`,
      sessionEffectiveStrategy: 'fresh',
      sessionWarning: strategy.mode === 'selected' ? 'selected session is not supported for Claude Code yet; falling back to fresh' : null,
    };
  }

  const codexFlagsByProfile = {
    safe: '--sandbox read-only',
    edit: '--sandbox workspace-write',
    plan: '--sandbox read-only',
    full: '--full-auto',
  };
  if (strategy.mode === 'selected' && strategy.sessionId) {
    const resumeFlags = profile === 'full' ? ' --full-auto' : '';
    return {
      command: `codex exec resume ${strategy.sessionId}${resumeFlags} ${quotedPrompt}`,
      sessionEffectiveStrategy: `session:${strategy.sessionId}`,
      sessionWarning: null,
    };
  }
  return {
    command: `codex exec ${codexFlagsByProfile[profile]} ${quotedPrompt}`,
    sessionEffectiveStrategy: 'fresh',
    sessionWarning: null,
  };
}

/**
 * Normalize supported target CLI labels.
 * @param {string | null | undefined} value
 * @returns {'gemini' | 'claude' | 'codex' | null}
 */
function normalizeTargetCli(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'gemini' || v === 'geminicli') return 'gemini';
  if (v === 'claude' || v === 'claudecode' || v === 'claudecode') return 'claude';
  if (v === 'codex' || v === 'codexcli') return 'codex';
  return null;
}

/**
 * Infer target CLI from a full command string.
 * @param {string | null | undefined} cmd
 * @returns {'gemini' | 'claude' | 'codex' | null}
 */
function inferTargetCli(cmd) {
  const summary = summarizeCommand(cmd);
  return normalizeTargetCli(summary.tool);
}

/**
 * Infer the normalized permission profile.
 * @param {'gemini' | 'claude' | 'codex' | null} targetCli
 * @param {string | null | undefined} cmd
 * @param {string | null | undefined} explicitValue
 * @returns {'safe' | 'edit' | 'plan' | 'full'}
 */
function inferPermissionProfile(targetCli, cmd, explicitValue) {
  const explicit = String(explicitValue || '').trim().toLowerCase();
  if (['safe', 'edit', 'plan', 'full'].includes(explicit)) return /** @type {'safe' | 'edit' | 'plan' | 'full'} */ (explicit);

  const raw = String(cmd || '');
  if (targetCli === 'gemini') {
    if (/--approval-mode=yolo\b|--yolo\b/i.test(raw)) return 'full';
    if (/--approval-mode=plan\b/i.test(raw)) return 'plan';
    if (/--approval-mode=auto_edit\b/i.test(raw)) return 'edit';
    return 'safe';
  }
  if (targetCli === 'claude') {
    if (/--permission-mode\s+bypassPermissions\b|--dangerously-skip-permissions\b/i.test(raw)) return 'full';
    if (/--permission-mode\s+plan\b/i.test(raw)) return 'plan';
    if (/--permission-mode\s+acceptEdits\b/i.test(raw)) return 'edit';
    return 'safe';
  }
  if (targetCli === 'codex') {
    if (/--full-auto\b|--dangerously-bypass-approvals-and-sandbox\b/i.test(raw)) return 'full';
    if (/--sandbox\s+workspace-write\b/i.test(raw)) return 'edit';
    return 'safe';
  }
  return 'safe';
}

// ── Route handlers ────────────────────────────────────────────────────────────

/** GET / — serve public/index.html */
function handleIndex(res) {
  const indexPath = join(PUBLIC_DIR, 'index.html');
  try {
    const html = readFileSync(indexPath, 'utf8').replace(/__APP_VERSION__/g, APP_VERSION);
    sendHeaders(res, 200, 'text/html; charset=utf-8');
    res.end(html);
  } catch {
    sendJSON(res, 404, { error: 'index.html not found' });
  }
}

/** GET /api/jobs — list all job definitions */
function handleJobs(res) {
  const settings = loadSettings();
  const sessions = listManagedSessions();
  const usage = readJobSessionUsage();
  let files = [];
  try {
    files = readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    // jobs dir may not exist yet — return empty array
  }

  const jobs = files.map((file) => {
    const name     = basename(file, '.json');
    const filePath = join(JOBS_DIR, file);
    try {
      const raw = readFileSync(filePath, 'utf8');
      const job = JSON.parse(raw);
      const targetCli = normalizeTargetCli(job.targetCli || job.command) || 'gemini';
      const permissionProfile = inferPermissionProfile(targetCli, job.command, job.permissionProfile);
      const recentSessionId = usage[name]?.sessionId || null;
      const recentSessionRecord = recentSessionId
        ? readSessionRecord(recentSessionId)
        : readLegacyJobSessionRecord(name);
      const legacyStrategy = String(job.sessionMode || '').trim().toLowerCase() === 'persistent' && recentSessionRecord?.sessionId
        ? `session:${recentSessionRecord.sessionId}`
        : 'fresh';
      const sessionStrategy = normalizeSessionStrategy(job.sessionStrategy || legacyStrategy);
      const parsedStrategy = parseSessionStrategy(sessionStrategy);
      const prompt = typeof job.prompt === 'string' && job.prompt.trim()
        ? job.prompt.trim()
        : summarizeCommand(job.command).prompt;
      const selectedSession = parsedStrategy.sessionId ? sessions.find((s) => s.sessionId === parsedStrategy.sessionId) : null;
      const commandInfo = buildCommand(targetCli, permissionProfile, prompt, sessionStrategy, selectedSession);
      const commandSummary = summarizeCommand(commandInfo.command);
      // Check if any processes are currently running
      let running = 0;
      const runningProcesses = [];
      try {
        const pidPath = join(PIDS_DIR, `${name}.json`);
        if (existsSync(pidPath)) {
          const pids = JSON.parse(readFileSync(pidPath, 'utf8'));
          const arr = Array.isArray(pids) ? pids : [pids];
          for (const p of arr) {
            if (isProcessAlive(p.pid)) {
              running++;
              runningProcesses.push({ pid: p.pid, startedAt: p.startedAt, command: p.command });
            }
          }
        }
      } catch { /* not running */ }
      return {
        name,
        logId:    typeof job.logId === 'string' && job.logId.trim() ? job.logId.trim() : '',
        targetCli,
        permissionProfile,
        sessionStrategy,
        cron:     job.cron     ?? null,
        command:  commandInfo.command,
        tool:     commandSummary.tool,
        prompt,
        flags:    commandSummary.flags,
        sessionKey: selectedSession?.sessionKey || recentSessionRecord?.sessionKey || null,
        selectedSessionId: parsedStrategy.sessionId,
        selectedSessionLabel: selectedSession?.label || (parsedStrategy.sessionId ? `session ${parsedStrategy.sessionId.slice(0, 8)}` : 'fresh'),
        recentSessionId,
        sessionEffectiveStrategy: commandInfo.sessionEffectiveStrategy,
        sessionWarning: commandInfo.sessionWarning,
        timezone: job.timezone ?? null,
        active:   job.active   !== false,
        running,
        runningProcesses,
        defaultWorkdir: settings.defaultWorkdir,
      };
    } catch {
      return { name, error: 'parse error' };
    }
  });

  sendJSON(res, 200, jobs);
}

function handleSessions(res) {
  sendJSON(res, 200, listManagedSessions());
}

function runImmediateSessionPrompt(session, prompt) {
  return new Promise((resolve, reject) => {
    const targetCli = normalizeTargetCli(session?.targetCli) || 'codex';
    if (targetCli !== 'codex') {
      reject(new Error('selected session prompt is only supported for Codex right now'));
      return;
    }

    const settings = loadSettings();
    const workdir = settings.defaultWorkdir;
    const permissionProfile = inferPermissionProfile(targetCli, '', session.permissionProfile);
    const quotedPrompt = `'${escapeSingleQuotedPrompt(prompt)}'`;
    const resumeFlags = permissionProfile === 'full' ? ' --full-auto' : '';
    const command = `codex exec resume ${session.sessionId}${resumeFlags} ${quotedPrompt}`;
    const logTag = `${session.logId || '----'}/adhoc`;
    const startedAt = new Date().toISOString();
    const [bin, args] = shellArgs(command);
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: workdir,
    });

    const stdoutLines = [];
    appendLog(logTag, `SESSION PROMPT → session:${session.sessionId}`);
    appendLog(logTag, `FIRE → ${command}`);
    appendLog(logTag, `CWD  → ${workdir}`);

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        appendLog(`${logTag}/stdout`, line);
        stdoutLines.push(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        appendLog(`${logTag}/stderr`, line);
      }
    });

    child.on('error', (err) => {
      appendLog(`${logTag}/error`, `spawn error: ${err.message}`);
      reject(err);
    });

    child.on('close', (code) => {
      appendLog(logTag, `EXIT code=${code ?? '?'}`);
      try {
        const ts = new Date().toISOString().replace(/:/g, '-');
        const filename = `${session.jobName || 'session'}-adhoc-${ts}.txt`;
        const filePath = join(RESULTS_DIR, filename);
        const headerLines = [
          `job: ${session.jobName || ''}`,
          `logId: ${session.logId || ''}`,
          `targetCli: ${targetCli}`,
          `permissionProfile: ${permissionProfile}`,
          `sessionStrategy: session:${session.sessionId}`,
          `sessionEffectiveStrategy: session:${session.sessionId}`,
          `sessionId: ${session.sessionId}`,
          `sessionSourceJob: ${session.jobName || ''}`,
          `runAt: ${startedAt}`,
          `adhocPrompt: ${prompt}`,
          '',
        ];
        writeFileSync(filePath, headerLines.join('\n') + stdoutLines.join('\n'), 'utf8');
        appendLog(logTag, `Result saved → ${filename}`);
        resolve({ filename, code: code ?? 0 });
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** POST /api/sessions/:sessionId/prompt — send an immediate prompt to an existing session */
function handleSessionPrompt(req, res, sessionId) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const payload = body ? JSON.parse(body) : {};
      const prompt = String(payload.prompt || '').trim();
      if (!prompt) {
        sendJSON(res, 400, { error: 'prompt is required' });
        return;
      }
      const session = findManagedSessionById(sessionId);
      if (!session) {
        sendJSON(res, 404, { error: 'session not found' });
        return;
      }
      const result = await runImmediateSessionPrompt(session, prompt);
      sendJSON(res, 200, {
        ok: true,
        sessionId,
        filename: result.filename,
        code: result.code,
      });
    } catch (err) {
      sendJSON(res, 500, { error: err?.message || 'failed to send prompt to session' });
    }
  });
}

/** POST /api/jobs — create a new job definition */
function handleCreateJob(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = body ? JSON.parse(body) : {};
      const name = String(payload.name || '').trim();
      if (!isValidJobName(name)) {
        sendJSON(res, 400, { error: 'job name is required and must not contain invalid path characters' });
        return;
      }

      const filePath = join(JOBS_DIR, `${name}.json`);
      if (existsSync(filePath)) {
        sendJSON(res, 409, { error: 'job name already exists' });
        return;
      }

      const logId = String(payload.logId || '').trim();
      if (!isValidLogId(logId)) {
        sendJSON(res, 400, { error: 'logId must be a unique 4-digit number' });
        return;
      }
      if (collectOtherLogIds('__new__').has(logId)) {
        sendJSON(res, 409, { error: 'logId already exists' });
        return;
      }

      const targetCli = normalizeTargetCli(payload.targetCli) || 'gemini';
      const permissionProfile = inferPermissionProfile(targetCli, '', payload.permissionProfile);
      const prompt = String(payload.prompt || '').trim();
      if (!prompt) {
        sendJSON(res, 400, { error: 'prompt is required' });
        return;
      }

      const cronExpr = String(payload.cron || '').trim();
      if (!cronExpr || !cron.validate(cronExpr)) {
        sendJSON(res, 400, { error: 'invalid cron expression' });
        return;
      }

      const timezone = typeof payload.timezone === 'string' && payload.timezone.trim()
        ? payload.timezone.trim()
        : 'Asia/Tokyo';

      const sessionStrategy = normalizeSessionStrategy(payload.sessionStrategy);
      const parsedStrategy = parseSessionStrategy(sessionStrategy);
      if (parsedStrategy.mode === 'selected') {
        const selectedSession = listManagedSessions().find((s) => s.sessionId === parsedStrategy.sessionId);
        if (!selectedSession) {
          sendJSON(res, 400, { error: 'selected session not found' });
          return;
        }
      }

      const job = {
        logId,
        targetCli,
        permissionProfile,
        sessionStrategy,
        prompt,
        cron: cronExpr,
        timezone,
        active: payload.active !== false,
      };

      writeFileSync(filePath, JSON.stringify(job, null, 2) + '\n', 'utf8');
      appendLog('ui', `CREATE job=${name} targetCli=${targetCli} permissionProfile=${permissionProfile} sessionStrategy=${sessionStrategy}`);
      sendJSON(res, 201, { name, ...job });
    } catch {
      sendJSON(res, 500, { error: 'failed to create job' });
    }
  });
}

function handleGetSettings(res) {
  sendJSON(res, 200, loadSettings());
}

function handleUpdateSettings(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const updates = body ? JSON.parse(body) : {};
      const next = saveSettings({
        defaultWorkdir: updates.defaultWorkdir,
      });
      sendJSON(res, 200, next);
    } catch {
      sendJSON(res, 500, { error: 'failed to update settings' });
    }
  });
}

/** GET /api/results — list recent result files (newest first, max 50) */
function handleResults(res) {
  let files = [];
  try {
    files = readdirSync(RESULTS_DIR);
  } catch {
    // results dir may not exist yet
  }

  const entries = files
    .map((filename) => {
      const filePath = join(RESULTS_DIR, filename);
      let size = 0;
      try { size = statSync(filePath).size; } catch { /* ignore */ }

      // filename pattern: <jobName>-<ISO timestamp with dashes>.txt
      // Reconstruct timestamp from the last 27 chars before .txt
      // e.g. "my-job-2025-01-15T09-30-00-000Z.txt"
      // jobName may contain dashes, so we extract from the right side
      const withoutExt = filename.replace(/\.txt$/, '');
      // ISO timestamps look like: YYYY-MM-DDTHH-MM-SS-mmmZ (length 24 with dashes)
      // Match trailing ISO-like timestamp: digits/dashes/T/Z
      const tsMatch = withoutExt.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?(?:-\d+)?Z?)$/);
      let timestamp = null;
      let jobName   = withoutExt;
      if (tsMatch) {
        // Convert dashes-in-time back to colons for display
        timestamp = tsMatch[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
        jobName   = withoutExt.slice(0, withoutExt.length - tsMatch[0].length);
      }

      return { filename, jobName, timestamp, size };
    })
    .map((entry) => {
      try {
        const content = readFileSync(join(RESULTS_DIR, entry.filename), 'utf8').slice(0, 2048);
        const sessionIdMatch = content.match(/^sessionId:\s*(.+)$/m);
        const sessionSourceJobMatch = content.match(/^sessionSourceJob:\s*(.*)$/m);
        const sessionEffectiveMatch = content.match(/^sessionEffectiveStrategy:\s*(.+)$/m);
        return {
          ...entry,
          sessionId: sessionIdMatch?.[1]?.trim() || null,
          sessionSourceJob: sessionSourceJobMatch?.[1]?.trim() || null,
          sessionEffectiveStrategy: sessionEffectiveMatch?.[1]?.trim() || 'fresh',
        };
      } catch {
        return entry;
      }
    })
    .sort((a, b) => {
      // Sort by timestamp descending; nulls go to the end
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    })
    .slice(0, 50);

  sendJSON(res, 200, entries);
}

/**
 * GET /api/results/:filename — return the raw text content of a result file.
 * @param {http.ServerResponse} res
 * @param {string} filename
 */
function handleResultFile(res, filename) {
  // Basic path traversal guard — reject anything that looks suspicious
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    sendJSON(res, 400, { error: 'invalid filename' });
    return;
  }

  const filePath = join(RESULTS_DIR, filename);
  try {
    const content = readFileSync(filePath, 'utf8');
    sendHeaders(res, 200, 'text/plain; charset=utf-8');
    res.end(content);
  } catch {
    sendJSON(res, 404, { error: 'result file not found' });
  }
}

/** PATCH /api/jobs/:name — update job fields or toggle active */
function handleUpdateJob(req, res, jobName) {
  if (jobName.includes('..') || jobName.includes('/') || jobName.includes('\\')) {
    sendJSON(res, 400, { error: 'invalid job name' });
    return;
  }

  const filePath = join(JOBS_DIR, `${jobName}.json`);

  // Collect request body
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const job = JSON.parse(raw);

      if (body) {
        // Body present → update specified fields
        const updates = JSON.parse(body);
        const allowed = ['logId', 'targetCli', 'permissionProfile', 'sessionStrategy', 'prompt', 'cron', 'timezone', 'active'];
        for (const key of allowed) {
          if (key in updates) job[key] = updates[key];
        }
        delete job.workdir;
        delete job.command;

        const logId = typeof job.logId === 'string' ? job.logId.trim() : '';
        if (!isValidLogId(logId)) {
          sendJSON(res, 400, { error: 'logId must be a unique 4-digit number' });
          return;
        }
        if (collectOtherLogIds(jobName).has(logId)) {
          sendJSON(res, 409, { error: 'logId already exists' });
          return;
        }
        job.logId = logId;

        const targetCli = normalizeTargetCli(job.targetCli || '') || inferTargetCli(job.command) || 'gemini';
        const permissionProfile = inferPermissionProfile(targetCli, '', job.permissionProfile);
        const usage = readJobSessionUsage();
        const recentSessionId = usage[jobName]?.sessionId || null;
        const recentSessionRecord = recentSessionId
          ? readSessionRecord(recentSessionId)
          : readLegacyJobSessionRecord(jobName);
        const legacyStrategy = String(job.sessionMode || '').trim().toLowerCase() === 'persistent' && recentSessionRecord?.sessionId
          ? `session:${recentSessionRecord.sessionId}`
          : 'fresh';
        const sessionStrategy = normalizeSessionStrategy(job.sessionStrategy || legacyStrategy);
        if (job.targetCli !== undefined) job.targetCli = targetCli;
        if (job.permissionProfile !== undefined || !job.permissionProfile) job.permissionProfile = permissionProfile;
        job.sessionStrategy = sessionStrategy;
        delete job.sessionMode;

        // Handle rename
        if (updates.name && updates.name !== jobName) {
          const newName = updates.name;
          if (newName.includes('..') || newName.includes('/') || newName.includes('\\') || !newName.trim()) {
            sendJSON(res, 400, { error: 'invalid new name' });
            return;
          }
          // Block rename if running
          const pidPath = join(PIDS_DIR, `${jobName}.json`);
          if (existsSync(pidPath)) {
            try {
              const pids = JSON.parse(readFileSync(pidPath, 'utf8'));
              const arr = Array.isArray(pids) ? pids : [pids];
              for (const p of arr) {
                if (isProcessAlive(p.pid)) {
                  sendJSON(res, 409, { error: 'cannot rename while job is running' });
                  return;
                }
              }
            } catch { /* no running process */ }
          }
          const newFilePath = join(JOBS_DIR, `${newName}.json`);
          if (existsSync(newFilePath)) {
            sendJSON(res, 409, { error: 'job name already exists' });
            return;
          }
          writeFileSync(newFilePath, JSON.stringify(job, null, 2) + '\n', 'utf8');
          try { unlinkSync(filePath); } catch { /* ignore */ }
          // Rename PID file if exists
          if (existsSync(pidPath)) {
            try { fs.renameSync(pidPath, join(PIDS_DIR, `${newName}.json`)); } catch { /* ignore */ }
          }
          const oldLegacySessionPath = join(SESSIONS_DIR, `${jobName}.json`);
          if (existsSync(oldLegacySessionPath)) {
            try { fs.renameSync(oldLegacySessionPath, join(SESSIONS_DIR, `${newName}.json`)); } catch { /* ignore */ }
          }
          sendJSON(res, 200, { name: newName, ...job });
          return;
        }
      } else {
        // No body → toggle active (backwards compat)
        job.active = job.active === false ? true : false;
      }

      writeFileSync(filePath, JSON.stringify(job, null, 2) + '\n', 'utf8');
      sendJSON(res, 200, { name: jobName, ...job });
    } catch (err) {
      if (err.code === 'ENOENT') {
        sendJSON(res, 404, { error: 'job not found' });
      } else {
        sendJSON(res, 500, { error: 'failed to update job' });
      }
    }
  });
}

/** POST /api/jobs/:name/run — immediately trigger a job (fire-and-forget) */
function handleRunJobNow(res, jobName) {
  if (jobName.includes('..') || jobName.includes('/') || jobName.includes('\\')) {
    sendJSON(res, 400, { error: 'invalid job name' });
    return;
  }

  const filePath = join(JOBS_DIR, `${jobName}.json`);
  if (!existsSync(filePath)) {
    sendJSON(res, 404, { error: 'job not found' });
    return;
  }

  let job;
  try {
    job = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    sendJSON(res, 500, { error: 'failed to read job' });
    return;
  }

  const targetCli = normalizeTargetCli(job.targetCli) || 'gemini';
  const permissionProfile = inferPermissionProfile(targetCli, '', job.permissionProfile);
  const prompt = String(job.prompt || '').trim();
  const sessionStrategy = normalizeSessionStrategy(job.sessionStrategy);
  const logId = String(job.logId || '----');
  const logTag = `${logId}/manual`;

  if (!prompt) {
    sendJSON(res, 400, { error: 'job has no prompt' });
    return;
  }

  const settings = loadSettings();
  const workdir = settings.defaultWorkdir;
  const commandInfo = buildCommand(targetCli, permissionProfile, prompt, sessionStrategy, null);
  const { command } = commandInfo;
  const startedAt = new Date().toISOString();

  appendLog(logTag, `MANUAL RUN → ${command}`);
  appendLog(logTag, `CWD  → ${workdir}`);

  const [bin, args] = shellArgs(command);
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: workdir,
    detached: false,
  });

  // Write PID file
  const pidPath = join(PIDS_DIR, `${jobName}.json`);
  const pidEntry = { pid: child.pid, command, startedAt, logTag };
  try {
    let pids = [];
    try { pids = JSON.parse(readFileSync(pidPath, 'utf8')); } catch { /* new */ }
    if (!Array.isArray(pids)) pids = [];
    pids.push(pidEntry);
    writeFileSync(pidPath, JSON.stringify(pids) + '\n', 'utf8');
  } catch { /* best-effort */ }

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) appendLog(`${logTag}/stdout`, line);
    }
  });
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) appendLog(`${logTag}/stderr`, line);
    }
  });
  child.on('error', (err) => {
    appendLog(`${logTag}/error`, `spawn error: ${err.message}`);
  });
  child.on('close', (code) => {
    appendLog(logTag, `EXIT code=${code ?? '?'}`);
    // Remove from PID file
    try {
      const raw = JSON.parse(readFileSync(pidPath, 'utf8'));
      const remaining = (Array.isArray(raw) ? raw : [raw]).filter((p) => p.pid !== child.pid);
      if (remaining.length > 0) {
        writeFileSync(pidPath, JSON.stringify(remaining) + '\n', 'utf8');
      } else {
        unlinkSync(pidPath);
      }
    } catch { /* best-effort */ }
  });

  sendJSON(res, 202, { name: jobName, pid: child.pid, startedAt });
}

/** DELETE /api/running/:name — kill all running processes for a job */
function handleKillProcess(res, jobName) {
  if (jobName.includes('..') || jobName.includes('/') || jobName.includes('\\')) {
    sendJSON(res, 400, { error: 'invalid job name' });
    return;
  }

  const pidPath = join(PIDS_DIR, `${jobName}.json`);
  try {
    const raw = JSON.parse(readFileSync(pidPath, 'utf8'));
    const pids = Array.isArray(raw) ? raw : [raw];
    const killed = [];
    for (const p of pids) {
      if (killProcessTree(p.pid)) {
        killed.push(p.pid);
      }
    }

    if (killed.length > 0) {
      try {
        const remaining = pids.filter((p) => !killed.includes(p.pid));
        if (remaining.length > 0) {
          writeFileSync(pidPath, JSON.stringify(remaining) + '\n', 'utf8');
        } else {
          unlinkSync(pidPath);
        }
      } catch { /* best-effort cleanup */ }
      appendLog('ui', `KILL job=${jobName} pids=${killed.join(',')}`);
    }

    sendJSON(res, 200, { name: jobName, killed: killed.length > 0, pids: killed, count: killed.length });
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendJSON(res, 404, { error: 'no running process for this job' });
    } else {
      sendJSON(res, 500, { error: 'failed to kill process' });
    }
  }
}

/** DELETE /api/jobs/:name — delete a job file when not running */
function handleDeleteJob(res, jobName) {
  if (jobName.includes('..') || jobName.includes('/') || jobName.includes('\\')) {
    sendJSON(res, 400, { error: 'invalid job name' });
    return;
  }

  const filePath = join(JOBS_DIR, `${jobName}.json`);
  const pidPath = join(PIDS_DIR, `${jobName}.json`);

  try {
    if (existsSync(pidPath)) {
      try {
        const raw = JSON.parse(readFileSync(pidPath, 'utf8'));
        const arr = Array.isArray(raw) ? raw : [raw];
        for (const p of arr) {
          if (isProcessAlive(p.pid)) {
            sendJSON(res, 409, { error: 'cannot delete while job is running' });
            return;
          }
        }
      } catch { /* ignore broken pid file */ }
    }

    unlinkSync(filePath);
    try { if (existsSync(pidPath)) unlinkSync(pidPath); } catch { /* ignore */ }
    appendLog('ui', `DELETE job=${jobName}`);
    sendJSON(res, 200, { name: jobName, deleted: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendJSON(res, 404, { error: 'job not found' });
    } else {
      sendJSON(res, 500, { error: 'failed to delete job' });
    }
  }
}

// ── SSE log streaming ─────────────────────────────────────────────────────────

/**
 * Send an SSE event to a single client.
 * @param {http.ServerResponse} client
 * @param {string} data
 */
function sendSSE(client, data) {
  try {
    // Multi-line data must be sent as multiple `data:` fields
    const lines = data.split('\n').map((l) => `data: ${l}`).join('\n');
    client.write(`${lines}\n\n`);
  } catch {
    // Client disconnected
    sseClients.delete(client);
  }
}

/**
 * Broadcast a message to all connected SSE clients.
 * @param {string} data
 */
function broadcastSSE(data) {
  for (const client of sseClients) {
    sendSSE(client, data);
  }
}

// Track which log file we are currently watching so we can handle date rollover
let watchedLogPath  = '';
let watchedLogSize  = 0;

function startLogWatcher() {
  const logPath = todayLogPath();

  if (watchedLogPath && watchedLogPath !== logPath) {
    // Date rolled over — stop watching the old file
    try { unwatchFile(watchedLogPath); } catch { /* ignore */ }
    watchedLogSize = 0;
  }

  watchedLogPath = logPath;

  // Seed initial file size so we only send *new* content
  try {
    watchedLogSize = statSync(logPath).size;
  } catch {
    watchedLogSize = 0;
  }

  watchFile(logPath, { interval: 500 }, (curr) => {
    // Check for date rollover on every tick
    const currentLogPath = todayLogPath();
    if (currentLogPath !== watchedLogPath) {
      startLogWatcher(); // restart watcher for new day's file
      return;
    }

    if (curr.size <= watchedLogSize) return; // no new content (or truncated)

    let newContent = '';
    try {
      const fd  = fs.openSync(logPath, 'r');
      const len = curr.size - watchedLogSize;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, watchedLogSize);
      fs.closeSync(fd);
      newContent = buf.toString('utf8');
    } catch {
      return;
    }

    watchedLogSize = curr.size;

    // Send each non-empty line as a separate SSE event
    for (const line of newContent.split('\n')) {
      if (line.trim()) broadcastSSE(line);
    }
  });
}

/** GET /api/logs/stream — SSE endpoint */
function handleLogStream(req, res) {
  res.writeHead(200, {
    'Content-Type':                'text/event-stream',
    'Cache-Control':               'no-cache',
    'Connection':                  'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send a comment to keep the connection alive and confirm it opened
  res.write(': connected\n\n');

  // Immediately flush the last 100 lines of today's log
  const recent = tailLines(todayLogPath(), 100);
  for (const line of recent) {
    sendSSE(res, line);
  }

  sseClients.add(res);

  // Remove client on disconnect
  req.on('close', () => {
    sseClients.delete(res);
  });
}

// ── Request router ────────────────────────────────────────────────────────────

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function router(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'POST') {
    if (pathname === '/api/jobs') {
      handleCreateJob(req, res);
      return;
    }
    const jobRunMatch = pathname.match(/^\/api\/jobs\/(.+)\/run$/);
    if (jobRunMatch) {
      handleRunJobNow(res, decodeURIComponent(jobRunMatch[1]));
      return;
    }
    const sessionPromptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
    if (sessionPromptMatch) {
      handleSessionPrompt(req, res, decodeURIComponent(sessionPromptMatch[1]));
      return;
    }
    sendJSON(res, 404, { error: 'not found' });
    return;
  }

  // PATCH /api/jobs/:name — toggle active
  if (req.method === 'PATCH') {
    if (pathname === '/api/settings') {
      handleUpdateSettings(req, res);
      return;
    }
    const jobMatch = pathname.match(/^\/api\/jobs\/(.+)$/);
    if (jobMatch) {
      handleUpdateJob(req, res, decodeURIComponent(jobMatch[1]));
      return;
    }
    sendJSON(res, 404, { error: 'not found' });
    return;
  }

  // DELETE /api/running/:name — kill running process
  if (req.method === 'DELETE') {
    const runMatch = pathname.match(/^\/api\/running\/(.+)$/);
    if (runMatch) {
      handleKillProcess(res, decodeURIComponent(runMatch[1]));
      return;
    }
    const jobMatch = pathname.match(/^\/api\/jobs\/(.+)$/);
    if (jobMatch) {
      handleDeleteJob(res, decodeURIComponent(jobMatch[1]));
      return;
    }
    sendJSON(res, 404, { error: 'not found' });
    return;
  }

  if (req.method !== 'GET') {
    sendJSON(res, 405, { error: 'method not allowed' });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    handleIndex(res);
    return;
  }

  if (pathname === '/api/jobs') {
    handleJobs(res);
    return;
  }

  if (pathname === '/api/sessions') {
    handleSessions(res);
    return;
  }

  if (pathname === '/api/settings') {
    handleGetSettings(res);
    return;
  }

  if (pathname === '/api/results') {
    handleResults(res);
    return;
  }

  // /api/results/:filename
  const resultMatch = pathname.match(/^\/api\/results\/(.+)$/);
  if (resultMatch) {
    handleResultFile(res, decodeURIComponent(resultMatch[1]));
    return;
  }

  if (pathname === '/api/logs/stream') {
    handleLogStream(req, res);
    return;
  }

  sendJSON(res, 404, { error: 'not found', path: pathname });
}

// ── Start server ──────────────────────────────────────────────────────────────

const server = http.createServer(router);

server.listen(PORT, () => {
  console.log(`[ui-server] cli-prompt-cron dashboard running → http://localhost:${PORT}`);
  console.log(`[ui-server] Jobs dir    : ${JOBS_DIR}`);
  console.log(`[ui-server] Logs dir    : ${LOGS_DIR}`);
  console.log(`[ui-server] Results dir : ${RESULTS_DIR}`);
});

// Start watching today's log file for SSE streaming
startLogWatcher();

// Graceful shutdown
function shutdown(signal) {
  console.log(`[ui-server] Received ${signal} — shutting down…`);
  for (const client of sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
  server.close(() => {
    console.log('[ui-server] Server closed. Goodbye.');
    process.exit(0);
  });
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (process.platform === 'win32') {
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}
