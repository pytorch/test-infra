@echo on
set SRC_PATH=%GITHUB_WORKSPACE%\%SRC_DIR%
set CMAKE_BUILD_TYPE=%BUILD_TYPE%
set VCVARSALL_PATH=%DEPENDENCIES_DIR%\VSBuildTools\VC\Auxiliary\Build\vcvarsall.bat
set CONDA_PREFIX=%DEPENDENCIES_DIR%
set PATH=%PATH%;%CONDA_PREFIX%\Library\bin
set DISTUTILS_USE_SDK=1

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

:: install dependencies
vcpkg install libjpeg-turbo:arm64-windows --x-install-root=%DEPENDENCIES_DIR%
vcpkg install libwebp:arm64-windows --x-install-root=%DEPENDENCIES_DIR%
vcpkg install libpng[tools]:arm64-windows --x-install-root=%DEPENDENCIES_DIR%
:: https://pytorch.org/vision/stable/index.html
:: Building with FFMPEG is disabled by default in the latest main
:: vcpkg install ffmpeg[ffmpeg]:arm64-windows --x-install-root=%DEPENDENCIES_DIR%
copy %DEPENDENCIES_DIR%\arm64-windows\lib\libpng16.lib %DEPENDENCIES_DIR%\arm64-windows\lib\libpng.lib
copy %DEPENDENCIES_DIR%\arm64-windows\bin\libpng16.dll %DEPENDENCIES_DIR%\arm64-windows\bin\libpng.dll
copy %DEPENDENCIES_DIR%\arm64-windows\bin\libpng16.pdb %DEPENDENCIES_DIR%\arm64-windows\bin\libpng.pdb
robocopy /E %DEPENDENCIES_DIR%\arm64-windows %DEPENDENCIES_DIR%\Library
robocopy /E %DEPENDENCIES_DIR%\Library\tools\libpng %DEPENDENCIES_DIR%\Library\bin
robocopy /E %DEPENDENCIES_DIR%\Library\bin %SRC_PATH%\torchvision *.dll

:: Source directory
cd %SRC_PATH%

:: Virtual environment
python -m pip install --upgrade pip
python -m venv .venv  --upgrade-deps
echo * > .venv\.gitignore
call .\.venv\Scripts\activate

:: Install dependencies
pip install numpy
pip install --pre torch --index-url https://download.pytorch.org/whl/nightly/cpu

exit /b 0

:: Activate visual studio
call "%VCVARSALL_PATH%" arm64

:: Creates wheel under dist folder
python setup.py bdist_wheel

:: Check if installation was successful
if %errorlevel% neq 0 (
    echo "Failed on build_vision. (exitcode = %errorlevel%)"
    exit /b 1
)