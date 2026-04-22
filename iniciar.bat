@echo off
:: Reiniciar como administrador si no lo es
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Solicitando permisos de administrador...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo Habilitando TCP/IP en SQL Server Express...
reg add "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp" /v Enabled /t REG_DWORD /d 1 /f >nul
reg add "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp\IPAll" /v TcpPort /t REG_SZ /d "1433" /f >nul
reg add "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp\IPAll" /v TcpDynamicPorts /t REG_SZ /d "" /f >nul
echo TCP/IP habilitado en puerto 1433.
echo.

echo Habilitando SQL Server Browser...
sc config SQLBrowser start= auto >nul
echo.

echo Reiniciando SQL Server Express...
net stop MSSQL$SQLEXPRESS >nul 2>&1
net start MSSQL$SQLEXPRESS
echo.

echo Iniciando SQL Server Browser...
net start SQLBrowser >nul 2>&1
echo.

echo Esperando que SQL Server este listo...
timeout /t 5 /nobreak >nul

echo Iniciando servidor Node...
cd /d "%~dp0server"
node index.js
