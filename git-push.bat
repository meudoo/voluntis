@echo off
chcp 65001 >nul
set "GIT=C:\Program Files\Git\cmd\git.exe"
if not exist "%GIT%" (
  echo Git не найден. Установите: https://git-scm.com/download/win
  pause
  exit /b 1
)

cd /d "%~dp0"
echo Git: 
"%GIT%" --version
echo.
echo === Загрузка на GitHub ===
echo Перед запуском создайте репозиторий на github.com (имя voluntis)
echo и замените ВАШ_ЛОГИН в этом файле (строка set REPO=...)
echo.
pause

set REPO=https://github.com/ВАШ_ЛОГИН/voluntis.git

"%GIT%" init
"%GIT%" add .
"%GIT%" commit -m "VOLUNTIS" 2>nul
"%GIT%" branch -M main
"%GIT%" remote remove origin 2>nul
"%GIT%" remote add origin %REPO%
"%GIT%" push -u origin main

echo.
if errorlevel 1 (
  echo Если push не удался — войдите в GitHub в открывшемся окне или используйте GitHub Desktop.
) else (
  echo Готово! Код на GitHub. Дальше: Render - RENDER-ПОШАГОВО.md
)
pause
