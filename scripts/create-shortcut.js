/**
 * Create a desktop shortcut for cli-prompt-cron.
 * Runs automatically on `npm install` (postinstall).
 * Supports Windows (.lnk), macOS (.command), Linux (.desktop).
 */

import { execSync } from 'node:child_process';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DESKTOP = join(homedir(), 'Desktop');

if (!existsSync(DESKTOP)) {
  console.log('[cli-prompt-cron] Desktop folder not found, skipping shortcut creation.');
  process.exit(0);
}

const os = platform();

try {
  if (os === 'win32') {
    const launchBat = join(PROJECT_ROOT, 'launch.bat');
    const iconJpg = join(PROJECT_ROOT, 'assets', 'icon.jpg');
    const iconIco = join(PROJECT_ROOT, 'assets', 'icon.ico');
    const shortcut = join(DESKTOP, 'cli-prompt-cron.lnk');

    // Convert jpg to ico if needed
    if (existsSync(iconJpg) && !existsSync(iconIco)) {
      try {
        execSync(`powershell -NoProfile -Command "` +
          `Add-Type -AssemblyName System.Drawing;` +
          `$img = [System.Drawing.Image]::FromFile('${iconJpg.replace(/'/g, "''")}');` +
          `$bmp = New-Object System.Drawing.Bitmap($img, 256, 256);` +
          `$stream = [System.IO.File]::Create('${iconIco.replace(/'/g, "''")}');` +
          `$bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Icon);` +
          `$stream.Close(); $bmp.Dispose(); $img.Dispose()"`, { stdio: 'ignore' });
      } catch (_) { /* icon conversion failed, continue without icon */ }
    }

    // Create .lnk
    const iconArg = existsSync(iconIco) ? `$sc.IconLocation = '${iconIco.replace(/'/g, "''")},0';` : '';
    execSync(`powershell -NoProfile -Command "` +
      `$ws = New-Object -ComObject WScript.Shell;` +
      `$sc = $ws.CreateShortcut('${shortcut.replace(/'/g, "''")}');` +
      `$sc.TargetPath = '${launchBat.replace(/'/g, "''")}';` +
      `$sc.WorkingDirectory = '${PROJECT_ROOT.replace(/'/g, "''")}';` +
      `$sc.Description = 'cli-prompt-cron - AI Scheduler';` +
      `${iconArg}` +
      `$sc.Save()"`, { stdio: 'ignore' });

    console.log('[cli-prompt-cron] Desktop shortcut created (Windows).');

  } else if (os === 'darwin') {
    const command = join(DESKTOP, 'cli-prompt-cron.command');
    writeFileSync(command, `#!/bin/bash\ncd "${PROJECT_ROOT}"\nnpm start\n`);
    chmodSync(command, '755');
    console.log('[cli-prompt-cron] Desktop shortcut created (macOS).');

  } else {
    const desktop = join(DESKTOP, 'cli-prompt-cron.desktop');
    writeFileSync(desktop, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=cli-prompt-cron',
      'Comment=AI Scheduler',
      `Exec=bash -c "cd '${PROJECT_ROOT}' && npm start"`,
      `Path=${PROJECT_ROOT}`,
      `Icon=${join(PROJECT_ROOT, 'assets', 'icon.jpg')}`,
      'Terminal=true',
      '',
    ].join('\n'));
    chmodSync(desktop, '755');
    console.log('[cli-prompt-cron] Desktop shortcut created (Linux).');
  }
} catch (e) {
  console.log('[cli-prompt-cron] Could not create shortcut:', e.message);
}
