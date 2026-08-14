@echo off
chcp 65001 >nul
title AI Usage Monitor
rem ============================================================
rem  Start the AI Usage Monitor stats server (port 9543) with
rem  NO console window (pythonw). This window closes instantly.
rem  For auto-start on boot: run install-autostart.bat once.
rem ============================================================

setlocal
cd /d "%~dp0"

rem Pick pythonw (Hermes venv first, then system pythonw)
set "PYW=pythonw.exe"
if exist "%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\pythonw.exe" (
    set "PYW=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\pythonw.exe"
)

rem Clear PYTHONPATH so a parent Hermes venv cannot pollute imports
set "PYTHONPATH="

start "" "%PYW%" "%~dp0stats_server.py" --port 9543 %*
exit