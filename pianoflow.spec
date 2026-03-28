# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for PianoFlow
# Run from the project root: pyinstaller pianoflow.spec

from PyInstaller.utils.hooks import collect_all
from pathlib import Path

block_cipher = None

# Collect all submodules + data for packages with dynamic imports
datas_m21, binaries_m21, hiddenimports_m21 = collect_all('music21')
datas_pil, binaries_pil, hiddenimports_pil = collect_all('PIL')

a = Analysis(
    ['backend/main.py'],
    pathex=['backend'],       # lets PyInstaller find models.py and ocr_pipeline.py
    binaries=binaries_m21 + binaries_pil,
    datas=[
        ('frontend', 'frontend'),   # served as static files
    ] + datas_m21 + datas_pil,
    hiddenimports=hiddenimports_m21 + hiddenimports_pil + [
        # FastAPI / Starlette
        'fastapi',
        'fastapi.routing',
        'fastapi.responses',
        'fastapi.staticfiles',
        'fastapi.middleware',
        'fastapi.middleware.cors',
        'starlette',
        'starlette.routing',
        'starlette.staticfiles',
        'starlette.responses',
        'starlette.middleware',
        'starlette.middleware.cors',
        # uvicorn — dynamic protocol/loop selection is commonly missed
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        # Other deps
        'multipart',
        'python_multipart',
        'pydantic',
        'pydantic.deprecated.class_validators',
        'h11',
        'anyio',
        'anyio._backends._asyncio',
        # Local modules
        'models',
        'ocr_pipeline',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',      # not needed, saves ~10 MB
        'matplotlib',   # not needed
        'scipy',        # not needed
        'numpy.testing',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='PianoFlow',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX can break some DLLs — keep off for safety
    console=True,       # keep console window so users see errors/progress
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='app.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='PianoFlow',
)
