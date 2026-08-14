@echo off
chcp 65001 >nul
title AI Usage Monitor - install autostart
rem ============================================================
rem  Register the stats server to start silently at every login.
rem  Uses a shortcut in the user Startup folder pointing at
rem  pythonw.exe (no console window ever, no admin rights).
rem  To remove later: delete "AIUsageMonitor.lnk" from
rem  shell:startup (Win+R -> shell:startup).
rem ============================================================

setlocal
cd /d "%~dp0"

set "PYW=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\pythonw.exe"
if not exist "%PYW%" set "PYW=pythonw.exe"

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut(\"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\AIUsageMonitor.lnk\");" ^
  "$lnk.TargetPath = '%PYW%';" ^
  "$lnk.Arguments = '\"%~dp0stats_server.py\" --port 9543';" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.WindowStyle = 7;" ^
  "$lnk.Description = 'AI Usage Monitor stats server (silent)';" ^
  "$lnk.Save()"

if errorlevel 1 (
    echo [ERROR] Failed. Run again.
) else (
    echo [OK] Autostart registered: server starts silently at every login.
    echo      Remove later via shell:startup (delete AIUsageMonitor.lnk).
)
pause