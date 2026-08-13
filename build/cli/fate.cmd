@echo off
setlocal

REM Default to the current directory; the first positional argument overrides it.
set "FATE_PROJECT=%CD%"
set "FATE_NEW_INSTANCE="
set "PROJECT_SET="

:parse
if "%~1"=="" goto run
set "CURRENT=%~1"

REM Skip flags. --new-instance requests a fully isolated second process.
if /i "%CURRENT%"=="--project" goto project_option
if /i "%CURRENT:~0,10%"=="--project=" goto project_equals
if /i "%CURRENT%"=="--new-instance" set "FATE_NEW_INSTANCE=1"
if "%CURRENT:~0,2%"=="--" goto nextarg
goto positional

:project_option
shift
if "%~1"=="" goto run
set "CURRENT=%~1"
if "%CURRENT:~0,2%"=="--" goto parse
if not defined PROJECT_SET (
  set "FATE_PROJECT=%~f1"
  set "PROJECT_SET=1"
)
goto nextarg

:project_equals
if not defined PROJECT_SET (
  set "FATE_PROJECT=%CURRENT:~10%"
  set "PROJECT_SET=1"
)
goto nextarg

:positional
if not defined PROJECT_SET (
  set "FATE_PROJECT=%~f1"
  set "PROJECT_SET=1"
)

:nextarg
shift
goto parse

:run
if defined FATE_NEW_INSTANCE (
  start "" "%~dp0fate-ui.exe" --project "%FATE_PROJECT%" --new-instance
) else (
  start "" "%~dp0fate-ui.exe" --project "%FATE_PROJECT%"
)
