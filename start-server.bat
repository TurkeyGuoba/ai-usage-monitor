@echo off
chcp 65001 >nul
title AI Usage Monitor - stats server
rem ============================================================
rem  Start the AI Usage Monitor stats server (port 9543).
rem  The Hermes "Model Monitor" pane depends on this service.
rem  For auto-start on boot, put a shortcut to this file in
rem  shell:startup.
rem ============================================================

setlocal
cd /d "%~dp0"

rem Pick python (Hermes venv first, then system python)
set "PY=python"
if exist "%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\python.exe" (
    set "PY=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\python.exe"
)

rem Clear PYTHONPATH so a parent Hermes venv cannot pollute imports
set "PYTHONPATH="

echo Starting AI Usage Monitor (127.0.0.1:9543)...
echo Close this window or press Ctrl+C to stop.
echo.
"%PY%" "%~dp0stats_server.py" --port 9543 %*
pause