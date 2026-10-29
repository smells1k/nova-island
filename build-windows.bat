@echo off
setlocal
cd /d "%~dp0"
title Build NOVA Island for Windows

echo.
echo  NOVA Island ^| сборка установщика Windows x64
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Не найден Node.js. Установи Node.js 22.12 или новее: https://nodejs.org/
  pause
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22 || (v[0]===22 && v[1]<12)) process.exit(1)"
if errorlevel 1 (
  echo [ОШИБКА] Нужен Node.js 22.12 или новее.
  pause
  exit /b 1
)

if not exist node_modules\electron-builder (
  echo [1/2] Установка зависимостей...
  call npm install
  if errorlevel 1 (
    echo [ОШИБКА] npm install завершился с ошибкой.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Зависимости уже установлены.
)

echo [2/2] Сборка установщика NSIS...
call npm run dist:win
if errorlevel 1 (
  echo.
  echo [ОШИБКА] Сборка не удалась. Проверь интернет и сообщения выше.
  pause
  exit /b 1
)

echo.
echo Готово. Установщик находится в папке release\
explorer "%~dp0release"
endlocal
