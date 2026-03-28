/**
 * Create a desktop shortcut for cli-prompt-cron.
 * Runs automatically on `npm install` (postinstall).
 * Supports Windows (.lnk), macOS (.command), Linux (.desktop).
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
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

/**
 * Convert JPG to ICO on Windows using PowerShell + System.Drawing.
 * Creates a proper ICO by converting to PNG first, then wrapping in ICO container.
 */
function convertToIco(jpgPath, icoPath) {
  // Remove broken ico if exists
  if (existsSync(icoPath)) {
    try { unlinkSync(icoPath); } catch (_) {}
  }

  const pngPath = icoPath.replace(/\.ico$/, '.png');

  try {
    // Step 1: Convert JPG to 256x256 PNG
    execSync(`powershell -NoProfile -Command "` +
      `Add-Type -AssemblyName System.Drawing;` +
      `$img = [System.Drawing.Image]::FromFile('${jpgPath.replace(/\\/g, '\\\\')}');` +
      `$bmp = New-Object System.Drawing.Bitmap($img, 256, 256);` +
      `$bmp.Save('${pngPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);` +
      `$bmp.Dispose(); $img.Dispose()"`, { stdio: 'ignore' });

    if (!existsSync(pngPath)) return false;

    // Step 2: Wrap PNG in ICO container (PNG-in-ICO format)
    const pngData = readFileSync(pngPath);
    const ico = Buffer.alloc(6 + 16 + pngData.length);

    // ICO header (6 bytes)
    ico.writeUInt16LE(0, 0);      // reserved
    ico.writeUInt16LE(1, 2);      // type: 1 = ICO
    ico.writeUInt16LE(1, 4);      // count: 1 image

    // ICO directory entry (16 bytes)
    ico.writeUInt8(0, 6);         // width: 0 = 256
    ico.writeUInt8(0, 7);         // height: 0 = 256
    ico.writeUInt8(0, 8);         // color palette
    ico.writeUInt8(0, 9);         // reserved
    ico.writeUInt16LE(1, 10);     // color planes
    ico.writeUInt16LE(32, 12);    // bits per pixel
    ico.writeUInt32LE(pngData.length, 14); // image size
    ico.writeUInt32LE(22, 18);    // offset to image data

    // PNG data
    pngData.copy(ico, 22);

    writeFileSync(icoPath, ico);

    // Clean up temp PNG
    try { unlinkSync(pngPath); } catch (_) {}

    return existsSync(icoPath) && readFileSync(icoPath).length > 0;
  } catch (e) {
    try { unlinkSync(pngPath); } catch (_) {}
    return false;
  }
}

try {
  if (os === 'win32') {
    const launchBat = join(PROJECT_ROOT, 'launch.bat');
    const iconJpg = join(PROJECT_ROOT, 'assets', 'icon.jpg');
    const iconIco = join(PROJECT_ROOT, 'assets', 'icon.ico');
    const shortcut = join(DESKTOP, 'cli-prompt-cron.lnk');

    // Convert jpg to ico
    let hasIcon = false;
    if (existsSync(iconJpg)) {
      hasIcon = convertToIco(iconJpg, iconIco);
      if (hasIcon) console.log('[cli-prompt-cron] Icon converted.');
    }

    // Create .lnk
    const iconArg = hasIcon ? `$sc.IconLocation = '${iconIco.replace(/\\/g, '\\\\')},0';` : '';
    execSync(`powershell -NoProfile -Command "` +
      `$ws = New-Object -ComObject WScript.Shell;` +
      `$sc = $ws.CreateShortcut('${shortcut.replace(/\\/g, '\\\\')}');` +
      `$sc.TargetPath = '${launchBat.replace(/\\/g, '\\\\')}';` +
      `$sc.WorkingDirectory = '${PROJECT_ROOT.replace(/\\/g, '\\\\')}';` +
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
