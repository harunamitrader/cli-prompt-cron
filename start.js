import { spawn }          from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath }   from 'node:url';
import { dirname, join }   from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3300', 10);

/* ── Launch child processes ── */
const daemon = spawn('node', [join(__dirname, 'daemon.js')], {
  stdio: 'inherit',
  cwd: __dirname,
});

const uiServer = spawn('node', [join(__dirname, 'ui-server.js')], {
  stdio: 'inherit',
  cwd: __dirname,
});

daemon.on('error', err => console.error('[start] daemon error:', err.message));
uiServer.on('error', err => console.error('[start] ui-server error:', err.message));

/* ── Graceful shutdown ── */
function shutdown() {
  console.log('\n[start] Shutting down...');
  daemon.kill();
  uiServer.kill();
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

/* ── Poll until UI server is ready ── */
const MAX_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 200;

function waitForServer(attempt) {
  if (attempt >= MAX_ATTEMPTS) {
    console.error(`[start] UI server did not become ready on port ${PORT} after ${MAX_ATTEMPTS} attempts.`);
    return;
  }

  const conn = createConnection({ host: 'localhost', port: PORT });

  conn.on('connect', () => {
    conn.destroy();
    onReady();
  });

  conn.on('error', () => {
    conn.destroy();
    setTimeout(() => waitForServer(attempt + 1), POLL_INTERVAL_MS);
  });
}

/* ── Open browser once server is up ── */
function openBrowser(url) {
  const platform = process.platform;
  let cmd, args;

  if (platform === 'win32') {
    cmd  = 'explorer';
    args = [url];
  } else if (platform === 'darwin') {
    cmd  = 'open';
    args = [url];
  } else {
    cmd  = 'xdg-open';
    args = [url];
  }

  const browser = spawn(cmd, args, { stdio: 'ignore', detached: true });
  browser.unref();
}

function onReady() {
  const url = `http://localhost:${PORT}`;
  console.log(`[start] Dashboard: ${url}`);
  openBrowser(url);
}

/* ── Start polling ── */
console.log('[start] Starting daemon and UI server...');
setTimeout(() => waitForServer(0), 300);
