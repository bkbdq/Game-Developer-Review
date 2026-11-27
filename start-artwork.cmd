@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. & pause & exit /b 1)
node -e "Promise.all(['sharp','htmlparser2','ipaddr.js'].map(p=>import(p))).catch(()=>process.exit(1))" >nul 2>nul
if errorlevel 1 (
  call npm ci
  if errorlevel 1 (pause & exit /b 1)
)
set "ADMIN_ARTWORK=1"
node tools\admin-launcher.mjs
pause
