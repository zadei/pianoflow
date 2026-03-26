@echo off
setlocal

set "ROOT=%~dp0"
set "PORT=8000"

echo PianoFlow Launcher
echo ------------------

:: Prepend bundled deps to PATH (Audiveris + Poppler) — Python falls back to these automatically
set "PATH=%ROOT%dep\audiveris\bin;%ROOT%dep\poppler\Library\bin;%PATH%"

:: Check Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.11+ from https://python.org
    pause
    exit /b 1
)

:: Check Java is available (required for Audiveris OMR on image/PDF files)
java -version >nul 2>&1
if errorlevel 1 (
    echo.
    echo WARNING: Java not found. Image/PDF sheet music scanning requires Java 17+.
    echo   Download: https://adoptium.net
    echo   You can still upload MusicXML files ^(.xml/.mxl^) without Java.
    echo.
)

:: Install/update dependencies
echo Installing dependencies...
pip install -q -r "%ROOT%backend\requirements.txt"
if errorlevel 1 (
    echo ERROR: pip install failed. Check your internet connection.
    pause
    exit /b 1
)

:: Open browser after a short delay (background)
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:%PORT%"

echo.
echo Starting PianoFlow at http://localhost:%PORT%
echo Press Ctrl+C to stop.
echo.

:: Start server
cd /d "%ROOT%backend"
uvicorn main:app --host 127.0.0.1 --port %PORT%

endlocal
