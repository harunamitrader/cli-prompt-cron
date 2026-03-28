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
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname   = dirname(fileURLToPath(import.meta.url));
const BASE_DIR    = join(__dirname, 'data');
const JOBS_DIR    = join(BASE_DIR, 'jobs');
const LOGS_DIR    = join(BASE_DIR, 'logs');
const RESULTS_DIR = join(BASE_DIR, 'results');
const PIDS_DIR    = join(BASE_DIR, 'pids');

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

function shellArgs(command) {
  return IS_WINDOWS
    ? ['powershell', ['-Command', command]] // cmd /c mangles double-quoted args
    : ['sh',  ['-c', command]];
}

// ── Job runner ────────────────────────────────────────────────────────────────

/**
 * Spawn a shell command, stream stdout/stderr to the log, and write a result
 * file to RESULTS_DIR on exit.
 * @param {string} jobName
 * @param {string} command
 */
function runCommand(jobName, command) {
  log(jobName, `FIRE → ${command}`);

  const [bin, args] = shellArgs(command);
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  runningChildren.add(child);

  // Write PID to pid file (array of running processes)
  const pidFile = join(PIDS_DIR, `${jobName}.json`);
  const pidEntry = { pid: child.pid, command, startedAt: new Date().toISOString() };
  try {
    let pids = [];
    try { pids = JSON.parse(readFileSync(pidFile, 'utf8')); } catch { /* new file */ }
    if (!Array.isArray(pids)) pids = [];
    pids.push(pidEntry);
    writeFileSync(pidFile, JSON.stringify(pids) + '\n', 'utf8');
  } catch { /* best-effort */ }

  /** @type {string[]} */
  const stdoutLines = [];

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) {
        log(`${jobName}/stdout`, line);
        stdoutLines.push(line);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log(`${jobName}/stderr`, line);
    }
  });

  child.on('error', (err) => {
    log(`${jobName}/error`, `spawn error: ${err.message}`);
  });

  child.on('close', (code) => {
    runningChildren.delete(child);
    log(jobName, `EXIT code=${code ?? '?'}`);

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
      writeFileSync(filePath, stdoutLines.join('\n'), 'utf8');
      log(jobName, `Result saved → ${filename}`);
    } catch (err) {
      log(jobName, `Failed to save result: ${err.message}`);
    }
  });
}

// ── Job registration ──────────────────────────────────────────────────────────

/**
 * Parse a job file, validate it, and return a job object.
 * Returns null on any error.
 * @param {string} filePath
 * @returns {{ name: string, cron: string, command: string, timezone?: string, active: boolean } | null}
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

  if (typeof job.command !== 'string' || !job.command.trim()) {
    log('daemon', `Missing or invalid "command" field in ${filePath}`);
    return null;
  }

  if (!cron.validate(job.cron)) {
    log('daemon', `Invalid cron expression "${job.cron}" in ${filePath}`);
    return null;
  }

  const name = basename(filePath, '.json');
  return {
    name,
    cron:     job.cron.trim(),
    command:  job.command.trim(),
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
    task = cron.schedule(job.cron, () => runCommand(job.name, job.command), options);
  } catch (err) {
    log('daemon', `Failed to schedule job "${job.name}": ${err.message}`);
    return;
  }

  tasks.set(job.name, task);
  log('daemon', `Job "${job.name}" scheduled — cron="${job.cron}"${job.timezone ? ` tz=${job.timezone}` : ''}`);
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
log('daemon', '─────────────────────────────────────────');

ensureDirs();
loadExistingJobs();
startWatcher();

log('daemon', 'Ready. Waiting for jobs…');
