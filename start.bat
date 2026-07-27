@echo off
title Zoomlike Video Conference Server

REM ============================================================
REM  One-click startup script for Zoomlike Server
REM  - Checks Node.js installation
REM  - Installs npm dependencies
REM  - Generates HTTPS self-signed certificate (first run)
REM  - Adds Windows firewall rule for port 3030
REM  - Starts server listening on IPv4 (LAN) + IPv6 (WAN)
REM  UI is in Chinese, script output is in English for compatibility.
REM ============================================================

cd /d "%~dp0"

echo ============================================================
echo   Zoomlike Server - One Click Start
echo ============================================================
echo.

REM 1. Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js LTS first.
    echo         Download: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js installed: %NODE_VER%

REM 2. Install dependencies if node_modules does not exist
if not exist "node_modules" (
    echo.
    echo [*] First run, installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed. Check your network.
        pause
        exit /b 1
    )
)
echo [OK] Dependencies ready

REM 3. Install selfsigned package for certificate generation
if not exist "node_modules\selfsigned" (
    echo.
    echo [*] Installing selfsigned package...
    call npm install --save-dev selfsigned
)
echo [OK] Certificate tool ready

REM 4. Generate HTTPS certificate if missing
if not exist "cert\key.pem" (
    echo.
    echo [*] First run, generating HTTPS self-signed certificate...
    node generate-cert.js
    if errorlevel 1 (
        echo [ERROR] Certificate generation failed.
        pause
        exit /b 1
    )
) else (
    echo [OK] HTTPS certificate exists
)

REM 5. Add Windows firewall rule for port 3030 (IPv4 LAN + IPv6 WAN access)
echo.
echo [*] Checking Windows firewall rule...
netsh advfirewall firewall show rule name="Zoomlike Server 3030" >nul 2>nul
if errorlevel 1 (
    echo [*] Adding firewall rule - allow inbound port 3030...
    netsh advfirewall firewall add rule name="Zoomlike Server 3030" dir=in action=allow protocol=TCP localport=3030
    if errorlevel 1 (
        echo [WARN] Firewall rule add failed. Administrator privileges may be required.
        echo        If external devices cannot connect, please manually allow port 3030.
    ) else (
        echo [OK] Firewall rule added
    )
) else (
    echo [OK] Firewall rule exists
)

REM 6. Start server
echo.
echo ============================================================
echo   Starting server...
echo   - Local:    https://localhost:3030
echo   - LAN IPv4: https://YOUR_IPV4:3030
echo   - WAN IPv6: https://[YOUR_IPV6]:3030
echo   - Press Ctrl+C to stop the server
echo ============================================================
echo.

node server.js

echo.
echo Server stopped. Press any key to exit...
pause >nul
