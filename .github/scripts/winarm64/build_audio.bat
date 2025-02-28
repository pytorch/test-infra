@echo on
set SRC_PATH=%GITHUB_WORKSPACE%\%SRC_DIR%
set CMAKE_BUILD_TYPE=%BUILD_TYPE%
set VCVARSALL_PATH=%DEPENDENCIES_DIR%\VSBuildTools\VC\Auxiliary\Build\vcvarsall.bat
set CONDA_PREFIX=%DEPENDENCIES_DIR%
set PATH=%PATH%;%CONDA_PREFIX%\Library\bin
set DISTUTILS_USE_SDK=1
set USE_FFMPEG=1
set FFMPEG_ROOT=%DEPENDENCIES_DIR%\Library

:: find torch file name by searching
for /f "delims=" %%f in ('dir /b "%DOWNLOADS_DIR%" ^| findstr "torch-"') do set "PYTORCH_PATH=%DOWNLOADS_DIR%\%%f"

:: Dependencies
if not exist "%DOWNLOADS_DIR%" mkdir %DOWNLOADS_DIR%
if not exist "%DEPENDENCIES_DIR%" mkdir %DEPENDENCIES_DIR%
echo * > %DOWNLOADS_DIR%\.gitignore
echo * > %DEPENDENCIES_DIR%\.gitignore

:: install vcpkg
cd %DOWNLOADS_DIR%
:: for ffmpeg 6.1.1 - pinning the version of vcpkg
:: https://pytorch.org/audio/stable/installation.html
git clone https://github.com/microsoft/vcpkg.git -b 2024.07.12
cd vcpkg
call bootstrap-vcpkg.bat

:: install dependencies
vcpkg install ffmpeg[ffmpeg]:arm64-windows --x-install-root=%DEPENDENCIES_DIR%
robocopy /E %DEPENDENCIES_DIR%\arm64-windows %DEPENDENCIES_DIR%\Library
robocopy /E %DEPENDENCIES_DIR%\Library\tools\ffmpeg %DEPENDENCIES_DIR%\Library\bin
robocopy /E %DEPENDENCIES_DIR%\Library\bin %SRC_PATH%\src\torio\lib

:: test ffmpeg
echo %FFMPEG_ROOT%
ffmpeg -version

:: Source directory
cd %SRC_PATH%

:: Virtual environment
python -m pip install --upgrade pip
python -m venv .venv
echo * > .venv\.gitignore
call .\.venv\Scripts\activate

:: Install dependencies
pip install %PYTORCH_PATH%

:: Activate visual studio
call "%VCVARSALL_PATH%" arm64

:: Creates wheel under dist folder
python setup.py bdist_wheel

:: Check if installation was successful
if %errorlevel% neq 0 (
    echo "Failed on build_audio. (exitcode = %errorlevel%)"
    exit /b 1
)