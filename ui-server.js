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
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname   = dirname(fileURLToPath(import.meta.url));
const BASE_DIR    = join(__dirname, 'data');
const JOBS_DIR    = join(BASE_DIR, 'jobs');
const LOGS_DIR    = join(BASE_DIR, 'logs');
const RESULTS_DIR = join(BASE_DIR, 'results');
const PIDS_DIR    = join(BASE_DIR, 'pids');
const PUBLIC_DIR  = join(__dirname, 'public');

const PORT = Number(process.env.PORT) || 3300;

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

// ── Route handlers ────────────────────────────────────────────────────────────

/** GET / — serve public/index.html */
function handleIndex(res) {
  const indexPath = join(PUBLIC_DIR, 'index.html');
  try {
    const html = readFileSync(indexPath, 'utf8');
    sendHeaders(res, 200, 'text/html; charset=utf-8');
    res.end(html);
  } catch {
    sendJSON(res, 404, { error: 'index.html not found' });
  }
}

/** GET /api/jobs — list all job definitions */
function handleJobs(res) {
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
      // Check if any processes are currently running
      let running = 0;
      try {
        const pidPath = join(PIDS_DIR, `${name}.json`);
        if (existsSync(pidPath)) {
          const pids = JSON.parse(readFileSync(pidPath, 'utf8'));
          const arr = Array.isArray(pids) ? pids : [pids];
          for (const p of arr) {
            try { process.kill(p.pid, 0); running++; } catch { /* dead */ }
          }
        }
      } catch { /* not running */ }
      return {
        name,
        cron:     job.cron     ?? null,
        command:  job.command  ?? null,
        timezone: job.timezone ?? null,
        active:   job.active   !== false,
        running,
      };
    } catch {
      return { name, error: 'parse error' };
    }
  });

  sendJSON(res, 200, jobs);
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

/** PATCH /api/jobs/:name — toggle active field */
function handleToggleJob(req, res, jobName) {
  if (jobName.includes('..') || jobName.includes('/') || jobName.includes('\\')) {
    sendJSON(res, 400, { error: 'invalid job name' });
    return;
  }

  const filePath = join(JOBS_DIR, `${jobName}.json`);
  try {
    const raw = readFileSync(filePath, 'utf8');
    const job = JSON.parse(raw);
    job.active = job.active === false ? true : false;
    writeFileSync(filePath, JSON.stringify(job, null, 2) + '\n', 'utf8');
    sendJSON(res, 200, { name: jobName, active: job.active });
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendJSON(res, 404, { error: 'job not found' });
    } else {
      sendJSON(res, 500, { error: 'failed to update job' });
    }
  }
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
      try {
        process.kill(p.pid, 'SIGTERM');
        killed.push(p.pid);
      } catch { /* already dead */ }
    }
    // Force kill survivors after 3 seconds
    setTimeout(() => {
      for (const pid of killed) {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch { /* already dead */ }
      }
    }, 3000);
    sendJSON(res, 200, { name: jobName, killed: true, pids: killed, count: killed.length });
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendJSON(res, 404, { error: 'no running process for this job' });
    } else {
      sendJSON(res, 500, { error: 'failed to kill process' });
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
      'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // PATCH /api/jobs/:name — toggle active
  if (req.method === 'PATCH') {
    const jobMatch = pathname.match(/^\/api\/jobs\/(.+)$/);
    if (jobMatch) {
      handleToggleJob(req, res, decodeURIComponent(jobMatch[1]));
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
