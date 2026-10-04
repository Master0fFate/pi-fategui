@echo off
setlocal DisableDelayedExpansion
rem Stock Windows clients refuse every script file (policy Restricted). Allow only
rem this fixed, installed launcher script, for this one process. A Group Policy
rem setting still takes precedence. The launcher does not pass it to its children.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\cli\fate-launch.ps1" %*
exit /b %ERRORLEVEL%
