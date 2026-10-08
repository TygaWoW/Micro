@echo off
REM ======================================================
REM  Feishu-Claude Bridge Stopper
REM  Double-click to gracefully stop the bridge.
REM  Places state\bridge.stop marker and kills the process.
REM ======================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-bridge.ps1"