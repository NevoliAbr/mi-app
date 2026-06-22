@echo off
:START
cls
echo ========================================
echo   MI-APP - Iniciando...
echo ========================================
echo.

if defined BACKEND_PID (
    taskkill /f /pid %BACKEND_PID% >nul 2>&1
)
if defined FRONTEND_PID (
    taskkill /f /pid %FRONTEND_PID% >nul 2>&1
)
set BACKEND_PID=
set FRONTEND_PID=
timeout /t 1 /nobreak >nul

echo [Backend]  Iniciando Express...
cd /d d:\mi-app\server
start /b node index.js
for /f "tokens=2" %%i in ('tasklist /fi "imagename eq node.exe" /fo list ^| findstr /i "PID:"') do (
    if not defined BACKEND_PID set BACKEND_PID=%%i
)

timeout /t 2 /nobreak >nul

echo [Frontend] Iniciando Vite...
cd /d d:\mi-app
start /b npx vite
for /f "tokens=2" %%i in ('tasklist /fi "imagename eq node.exe" /fo list ^| findstr /i "PID:"') do (
    if not defined FRONTEND_PID set FRONTEND_PID=%%i
)

echo.
echo ----------------------------------------
echo  Q = Reiniciar    X = Salir
echo ----------------------------------------
echo.

:WAIT
choice /c QX /n /m ""
if errorlevel 2 goto EXIT
if errorlevel 1 goto RESTART

:RESTART
echo.
echo Reiniciando servicios...
goto START

:EXIT
echo.
echo Cerrando servicios...
if defined BACKEND_PID  taskkill /f /pid %BACKEND_PID%  >nul 2>&1
if defined FRONTEND_PID taskkill /f /pid %FRONTEND_PID% >nul 2>&1
echo Hasta luego!
timeout /t 1 /nobreak >nul
exit