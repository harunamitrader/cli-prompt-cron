@echo off
chcp 65001 >nul

:: Create desktop shortcut for cli-prompt-cron
set SCRIPT_DIR=%~dp0
set SHORTCUT_NAME=cli-prompt-cron.lnk
set DESKTOP=%USERPROFILE%\Desktop
set ICON_JPG=%SCRIPT_DIR%assets\icon.jpg
set ICON_ICO=%SCRIPT_DIR%assets\icon.ico

:: Convert jpg to ico via PowerShell (PNG-in-ICO method)
if not exist "%ICON_ICO%" (
    powershell -NoProfile -Command ^
      "Add-Type -AssemblyName System.Drawing;" ^
      "$img = [System.Drawing.Image]::FromFile('%ICON_JPG%');" ^
      "$bmp = New-Object System.Drawing.Bitmap($img, 256, 256);" ^
      "$png = '%ICON_ICO:.ico=.png%';" ^
      "$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png);" ^
      "$bmp.Dispose(); $img.Dispose();" ^
      "$pngData = [System.IO.File]::ReadAllBytes($png);" ^
      "$ico = New-Object byte[] (22 + $pngData.Length);" ^
      "[System.BitConverter]::GetBytes([uint16]0).CopyTo($ico, 0);" ^
      "[System.BitConverter]::GetBytes([uint16]1).CopyTo($ico, 2);" ^
      "[System.BitConverter]::GetBytes([uint16]1).CopyTo($ico, 4);" ^
      "$ico[6]=0; $ico[7]=0; $ico[8]=0; $ico[9]=0;" ^
      "[System.BitConverter]::GetBytes([uint16]1).CopyTo($ico, 10);" ^
      "[System.BitConverter]::GetBytes([uint16]32).CopyTo($ico, 12);" ^
      "[System.BitConverter]::GetBytes([uint32]$pngData.Length).CopyTo($ico, 14);" ^
      "[System.BitConverter]::GetBytes([uint32]22).CopyTo($ico, 18);" ^
      "[System.Array]::Copy($pngData, 0, $ico, 22, $pngData.Length);" ^
      "[System.IO.File]::WriteAllBytes('%ICON_ICO%', $ico);" ^
      "Remove-Item $png -ErrorAction SilentlyContinue;" ^
      "Write-Host '[cli-prompt-cron] Icon converted.'"
)

:: Create .lnk shortcut
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut('%DESKTOP%\%SHORTCUT_NAME%');" ^
  "$sc.TargetPath = '%SCRIPT_DIR%launch.bat';" ^
  "$sc.WorkingDirectory = '%SCRIPT_DIR%';" ^
  "$sc.Description = 'cli-prompt-cron - AI Scheduler';" ^
  "if (Test-Path '%ICON_ICO%') { $sc.IconLocation = '%ICON_ICO%,0' };" ^
  "$sc.Save();" ^
  "Write-Host '[cli-prompt-cron] Shortcut created on Desktop.'"

pause
