@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [i] 用 gemini-cdp 后端启动桥接服务...
node server.mjs --backend gemini-cdp
pause
