@echo off
chcp 65001 >nul

:: Create desktop shortcut for cli-prompt-cron
set SCRIPT_DIR=%~dp0
set SHORTCUT_NAME=cli-prompt-cron.lnk
set DESKTOP=%USERPROFILE%\Desktop

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut('%DESKTOP%\%SHORTCUT_NAME%');" ^
  "$sc.TargetPath = '%SCRIPT_DIR%launch.bat';" ^
  "$sc.WorkingDirectory = '%SCRIPT_DIR%';" ^
  "$sc.Description = 'cli-prompt-cron - AI Scheduler';" ^
  "$sc.Save();" ^
  "Write-Host '[cli-prompt-cron] Shortcut created on Desktop.'"

pause
