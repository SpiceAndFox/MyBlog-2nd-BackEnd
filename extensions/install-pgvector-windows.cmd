@echo off
setlocal

set SCRIPT_DIR=%~dp0
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install-pgvector-windows.ps1" -EnableDatabase %*

endlocal

