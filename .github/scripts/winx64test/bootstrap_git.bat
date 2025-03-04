@echo off
setlocal enabledelayedexpansion

echo Dependency Git installation started.

:: Pre-check for downloads and dependencies folders
set "DOWNLOADS_DIR=c:\temp\downloads"
set "DEPENDENCIES_DIR=c:\temp\dependencies"

if not exist "%DOWNLOADS_DIR%" mkdir "%DOWNLOADS_DIR%"
if not exist "%DEPENDENCIES_DIR%" mkdir "%DEPENDENCIES_DIR%"

:: Set download URL for the Git
set "DOWNLOAD_URL=https://github.com/git-for-windows/git/releases/download/v2.46.0.windows.1/Git-2.46.0-64-bit.exe"
set "INSTALLER_FILE=%DOWNLOADS_DIR%\Git-2.46.0-64-bit.exe"

:: Download installer
echo Downloading Git...
curl -L -o "%INSTALLER_FILE%" "%DOWNLOAD_URL%"

:: Verify download success
if not exist "%INSTALLER_FILE%" (
    echo Failed to download Git!
    exit /b 1
)

:: Install Git
echo Installing Git...
"%INSTALLER_FILE%" /VERYSILENT /DIR="%DEPENDENCIES_DIR%\git"

:: Verify installation success
if %errorlevel% neq 0 (
    echo Failed to install Git. (exitcode = %errorlevel%)
    exit /b 1
)

:: Enable long paths
call "%DEPENDENCIES_DIR%\git\cmd\git.exe" config --system core.longpaths true

:: Add Git to PATH (temporary for this session)
set "PATH=%DEPENDENCIES_DIR%\git\cmd\;%DEPENDENCIES_DIR%\git\bin\;%PATH%"

echo Dependency Git installation finished.
exit /b 0