@echo off
setlocal
cd /d "%~dp0"
title NOVA Island

where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js 22.12+. Установи Node.js: https://nodejs.org/
  pause
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22 || (v[0]===22 && v[1]<12)) process.exit(1)"
if errorlevel 1 (
  echo Нужен Node.js 22.12 или новее.
  pause
  exit /b 1
)

if not exist node_modules\electron (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
endlocal
