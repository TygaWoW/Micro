@echo off
REM ======================================================
REM  Feishu-Claude Bridge One-Click Config
REM  1) Open config wizard (write .env + register MCP)
REM  2) Install deps + register autostart
REM ======================================================
cd /d "%~dp0"

echo.
echo ======================================================
echo  Step 1/2: Fill in your config in the wizard window...
echo ======================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure.ps1"

echo.
echo ======================================================
echo  Step 2/2: Installing dependencies + autostart...
echo ======================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"

echo.
echo Done. 双击 启动桥接器.bat 即可启动桥接器。
pause
