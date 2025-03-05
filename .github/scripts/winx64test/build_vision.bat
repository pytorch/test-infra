echo "Starting build_vision.bat"
@echo on
set SRC_PATH=%GITHUB_WORKSPACE%\%SRC_DIR%
set CMAKE_BUILD_TYPE=%BUILD_TYPE%
@REM set VCVARSALL_PATH=%DEPENDENCIES_DIR%\VSBuildTools\VC\Auxiliary\Build\vcvarsall.bat
set CONDA_PREFIX=%DEPENDENCIES_DIR%
set PATH=%PATH%;%CONDA_PREFIX%\Library\bin
set DISTUTILS_USE_SDK=1
@REM :: find toch file name by searching
@REM for /f "delims=" %%f in ('dir /b "%DOWNLOADS_DIR%" ^| findstr "torch-"') do set "PYTORCH_PATH=%DOWNLOADS_DIR%\%%f"

:: Dependencies
if not exist "%DOWNLOADS_DIR%" mkdir %DOWNLOADS_DIR%
if not exist "%DEPENDENCIES_DIR%" mkdir %DEPENDENCIES_DIR%
echo * > %DOWNLOADS_DIR%\.gitignore
echo * > %DEPENDENCIES_DIR%\.gitignore

:: install vcpkg
cd %DOWNLOADS_DIR%
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg
call bootstrap-vcpkg.bat
echo "VCPKG Installed"

:: install dependencies
vcpkg install libjpeg-turbo:x64-windows --x-install-root=%DEPENDENCIES_DIR%
vcpkg install libwebp:x64-windows --x-install-root=%DEPENDENCIES_DIR%
vcpkg install libpng[tools]:x64-windows --x-install-root=%DEPENDENCIES_DIR%
:: https://pytorch.org/vision/stable/index.html
:: Building with FFMPEG is disabled by default in the latest main
:: vcpkg install ffmpeg[ffmpeg]:x64-windows --x-install-root=%DEPENDENCIES_DIR%
copy %DEPENDENCIES_DIR%\x64-windows\lib\libpng16.lib %DEPENDENCIES_DIR%\x64-windows\lib\libpng.lib
copy %DEPENDENCIES_DIR%\x64-windows\bin\libpng16.dll %DEPENDENCIES_DIR%\x64-windows\bin\libpng.dll
copy %DEPENDENCIES_DIR%\x64-windows\bin\libpng16.pdb %DEPENDENCIES_DIR%\x64-windows\bin\libpng.pdb
robocopy /E %DEPENDENCIES_DIR%\x64-windows %DEPENDENCIES_DIR%\Library
robocopy /E %DEPENDENCIES_DIR%\Library\tools\libpng %DEPENDENCIES_DIR%\Library\bin
robocopy /E %DEPENDENCIES_DIR%\Library\bin %SRC_PATH%\torchvision *.dll

:: Source directory
cd %SRC_PATH%

where python
:: Virtual environment
python -m pip install --upgrade pip
python -m venv .venv  --upgrade-deps
echo * > .venv\.gitignore
call .\.venv\Scripts\activate
where python

:: Install dependencies
pip install numpy
pip3 install torch

:: Activate visual studio
set VC_VERSION_LOWER=17
set VC_VERSION_UPPER=18

for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -legacy -products * -version [%VC_VERSION_LOWER%^,%VC_VERSION_UPPER%^) -property installationPath`) do (
    if exist "%%i" if exist "%%i\VC\Auxiliary\Build\vcvarsall.bat" (
        set "VS15INSTALLDIR=%%i"
        set "VS15VCVARSALL=%%i\VC\Auxiliary\Build\vcvarsall.bat"
        goto vswhere
    )
)

:vswhere
call "%VS15VCVARSALL%" x64 || exit /b 1

:: Source directory
cd %SRC_PATH%

:: Creates wheel under dist folder
python setup.py bdist_wheel

:: Check if installation was successful
if %errorlevel% neq 0 (
    echo "Failed on build_vision. (exitcode = %errorlevel%)"
    exit /b 1
)
echo Finished running build_vision.bat"