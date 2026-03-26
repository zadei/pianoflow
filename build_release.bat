@echo off
setlocal
set "ROOT=%~dp0"

echo === PianoFlow Release Builder ===
echo.

:: Check PyInstaller is available
pyinstaller --version >nul 2>&1
if errorlevel 1 (
    echo Installing PyInstaller...
    pip install pyinstaller
    if errorlevel 1 (
        echo ERROR: Could not install PyInstaller. Make sure pip is available.
        pause
        exit /b 1
    )
)

:: Ensure backend deps are installed
echo Installing backend dependencies...
pip install -q -r "%ROOT%backend\requirements.txt"
if errorlevel 1 (
    echo ERROR: pip install failed.
    pause
    exit /b 1
)

:: Clean previous build artifacts
echo Cleaning previous build...
if exist "%ROOT%dist\PianoFlow" rmdir /s /q "%ROOT%dist\PianoFlow"
if exist "%ROOT%build\PianoFlow" rmdir /s /q "%ROOT%build\PianoFlow"

:: Run PyInstaller from the project root
echo.
echo Building with PyInstaller (this may take several minutes)...
cd /d "%ROOT%"
pyinstaller pianoflow.spec
if errorlevel 1 (
    echo.
    echo ERROR: PyInstaller build failed. Check output above for details.
    pause
    exit /b 1
)

:: Copy dep/ folder (Audiveris + Poppler) next to the exe
echo.
echo Copying bundled dependencies (dep/)...
xcopy /E /I /Y /Q "%ROOT%dep" "%ROOT%dist\PianoFlow\dep"
if errorlevel 1 (
    echo ERROR: Failed to copy dep/ folder.
    pause
    exit /b 1
)

echo.
echo ===================================
echo  Build complete!
echo  Release folder: dist\PianoFlow\
echo ===================================
echo.
echo To run: dist\PianoFlow\PianoFlow.exe
echo.
echo To publish on GitHub:
echo   1. Zip the dist\PianoFlow\ folder
echo   2. Name it PianoFlow-win64.zip
echo   3. Upload as a GitHub Release asset
echo.
pause
endlocal
