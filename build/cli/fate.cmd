@echo off
setlocal
set "FATE_PROJECT=%CD%"
if not "%~1"=="" set "FATE_PROJECT=%~f1"
start "" "%~dp0fate-ui.exe" --project "%FATE_PROJECT%"
