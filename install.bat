@echo off
setlocal EnableExtensions
chcp 65001 >nul
rem Always resolve paths from this .bat file, not the caller's working directory.
set "SCRIPT_DIR=%~dp0"
rem dsh-passwords one-click installer for Windows.
rem Actual install logic lives in scripts\install.mjs.
rem Usage: double-click this file, or run it from a cmd window.
rem   - From a cloned repo:  install.bat
rem   - Standalone:          download install.bat and run it anywhere

if exist "%SCRIPT_DIR%scripts\install.mjs" goto run

where node >nul 2>nul || (
  echo [dsh-passwords] Node.js not found. Install Node.js 22.19+ or 24+ first: https://nodejs.org/
  exit /b 1
)
where git >nul 2>nul || (
  echo [dsh-passwords] git not found. Install Git first: https://git-scm.com/download/win
  exit /b 1
)

set "DEST=%USERPROFILE%\dsh-passwords"
if defined DSH_PASSWORDS_DIR set "DEST=%DSH_PASSWORDS_DIR%"
if exist "%DEST%" (
  echo [dsh-passwords] Directory already exists: %DEST%
  echo [dsh-passwords] Reinstall: delete it first, but back up .env and data\ inside.
  exit /b 1
)
git clone --depth 1 https://github.com/sdwhwzp/dsh-passwords.git "%DEST%"
if errorlevel 1 exit /b 1
cd /d "%DEST%"
set "SCRIPT_DIR=%CD%\"

:run
node "%SCRIPT_DIR%scripts\install.mjs"
exit /b %errorlevel%
