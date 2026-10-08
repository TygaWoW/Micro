@echo off
REM ======================================================
REM  Feishu-Claude Bridge Launcher
REM  Double-click to start the bridge (guarded by watchdog).
REM  Closing this window will NOT stop the bridge.
REM  To stop: double-click 关闭桥接器.bat or drop state\bridge.stop
REM ======================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-bridge.ps1"
