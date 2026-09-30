@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoLogo -NoProfile -File "%~dp0resources\cli\fate-launch.ps1" %*
exit /b %ERRORLEVEL%
