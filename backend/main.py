"""PianoFlow FastAPI backend — serves the app and runs the OMR pipeline."""

import asyncio
import json
import logging
import os
import shutil
import sys
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path


def _frozen_base() -> Path:
    """Resource base: _MEIPASS when frozen (PyInstaller), project root in dev."""
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


def _backend_resource(relative: str) -> Path:
    """Path to a resource that lives in backend/ (dev) or _MEIPASS root (frozen)."""
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS) / relative
    return Path(__file__).parent / relative


def _data_dir() -> Path:
    """Writable data directory: next to exe when frozen, backend/ in dev."""
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).parent
    return Path(__file__).parent


# When frozen, prepend bundled dep/ binaries (Audiveris + Poppler) to PATH
if getattr(sys, 'frozen', False):
    _dep = Path(sys.executable).parent / 'dep'
    os.environ['PATH'] = (
        str(_dep / 'audiveris' / 'bin') + os.pathsep +
        str(_dep / 'poppler' / 'Library' / 'bin') + os.pathsep +
        os.environ.get('PATH', '')
    )

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from models import JobStatus, NotesResponse, StatusResponse, UploadResponse
from ocr_pipeline import _parse_musicxml, cleanup_work_dir, process_upload

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

UPLOAD_DIR = Path(tempfile.gettempdir()) / "pianoflow_uploads"
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".pdf", ".xml", ".mxl", ".musicxml"}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20MB
LIBRARY_FILE = _data_dir() / "library.json"

# In-memory job store (single-user local app, no persistence needed)
jobs: dict[str, dict] = {}


def _load_library() -> list[dict]:
    if LIBRARY_FILE.exists():
        try:
            return json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def _save_library(entries: list[dict]) -> None:
    LIBRARY_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")

# Track background tasks for graceful shutdown
_background_tasks: set[asyncio.Task] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    yield
    # Graceful shutdown: cancel running OCR tasks
    for task in _background_tasks:
        task.cancel()
    if _background_tasks:
        await asyncio.gather(*_background_tasks, return_exceptions=True)
    # Clean up temp files
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)


app = FastAPI(title="PianoFlow", version="1.0.0", lifespan=lifespan)

FRONTEND_DIR = _frozen_base() / "frontend"


@app.post("/api/upload", response_model=UploadResponse)
async def upload_sheet_music(file: UploadFile = File(...)):
    """Upload sheet music (image/PDF/MusicXML) for OCR processing."""
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            400,
            f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    # Read and check size
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large. Maximum size is {MAX_FILE_SIZE // (1024*1024)}MB")

    job_id = str(uuid.uuid4())
    work_dir = str(UPLOAD_DIR / job_id)
    os.makedirs(work_dir, exist_ok=True)

    file_path = os.path.join(work_dir, f"input{ext}")
    with open(file_path, "wb") as f:
        f.write(content)

    if ext in {".jpg", ".jpeg", ".png", ".pdf"}:
        _proc_msg = "Processing... (image/PDF scanning may take 30-90 seconds)"
    else:
        _proc_msg = "Processing started"
    jobs[job_id] = {"status": JobStatus.PROCESSING, "message": _proc_msg}

    # Launch OCR in background
    task = asyncio.create_task(_process_job(job_id, file_path, ext, work_dir, file.filename))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return UploadResponse(job_id=job_id)


async def _process_job(job_id: str, file_path: str, ext: str, work_dir: str, filename: str = ""):
    """Background task to run the OCR pipeline for a job."""
    try:
        notes, metadata, warning = await process_upload(file_path, ext, work_dir)
        serialized_notes = [n.model_dump() for n in notes]
        jobs[job_id] = {
            "status": JobStatus.COMPLETED,
            "message": "Processing complete",
            "notes": serialized_notes,
            "warning": warning,
            **metadata,
        }
        # Persist to library
        library = _load_library()
        library.insert(0, {
            "id": job_id,
            "filename": filename or f"piece_{job_id[:8]}",
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "note_count": len(serialized_notes),
            "notes": serialized_notes,
            "warning": warning,
            **metadata,
        })
        _save_library(library)
    except Exception as e:
        logger.error(f"Job {job_id} failed: {e}")
        jobs[job_id] = {
            "status": JobStatus.FAILED,
            "message": "Processing failed",
            "error": str(e),
        }
    finally:
        cleanup_work_dir(work_dir)


@app.get("/api/status/{job_id}", response_model=StatusResponse)
async def get_status(job_id: str):
    """Check OCR processing status."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[job_id]
    return StatusResponse(
        job_id=job_id,
        status=job["status"],
        message=job.get("message", ""),
        error=job.get("error"),
        warning=job.get("warning"),
    )


@app.get("/api/notes/{job_id}", response_model=NotesResponse)
async def get_notes(job_id: str):
    """Retrieve parsed note sequence for a completed job."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[job_id]
    if job["status"] == JobStatus.PROCESSING:
        raise HTTPException(202, "Still processing")
    if job["status"] == JobStatus.FAILED:
        raise HTTPException(400, job.get("error", "Processing failed"))

    return NotesResponse(
        job_id=job_id,
        notes=job["notes"],
        tempo_bpm=job.get("tempo_bpm", 120.0),
        time_signature=job.get("time_signature", "4/4"),
        key_signature=job.get("key_signature", "C major"),
        warning=job.get("warning"),
    )


@app.get("/api/library")
async def list_library():
    """List all previously processed pieces."""
    library = _load_library()
    return [
        {
            "id": e["id"],
            "filename": e["filename"],
            "saved_at": e["saved_at"],
            "note_count": e.get("note_count", len(e.get("notes", []))),
            "tempo_bpm": e.get("tempo_bpm", 120),
        }
        for e in library
    ]


@app.get("/api/library/{entry_id}", response_model=NotesResponse)
async def get_library_entry(entry_id: str):
    """Load a previously processed piece from the library."""
    library = _load_library()
    entry = next((e for e in library if e["id"] == entry_id), None)
    if not entry:
        raise HTTPException(404, "Library entry not found")
    return NotesResponse(
        job_id=entry_id,
        notes=entry["notes"],
        tempo_bpm=entry.get("tempo_bpm", 120),
        time_signature=entry.get("time_signature", "4/4"),
        key_signature=entry.get("key_signature", "C major"),
        warning=entry.get("warning"),
    )


@app.delete("/api/library/{entry_id}")
async def delete_library_entry(entry_id: str):
    """Remove a piece from the library."""
    library = _load_library()
    new_library = [e for e in library if e["id"] != entry_id]
    if len(new_library) == len(library):
        raise HTTPException(404, "Library entry not found")
    _save_library(new_library)
    return {"deleted": entry_id}


@app.get("/api/demo")
async def get_demo():
    """Load the bundled Ode to Joy demo — no upload required."""
    demo_path = _backend_resource("demo") / "ode_to_joy.xml"
    if not demo_path.exists():
        raise HTTPException(404, "Demo file not found")
    try:
        notes, metadata = _parse_musicxml(str(demo_path))
        return {
            "job_id": "demo-ode-to-joy",
            "notes": [n.model_dump() for n in notes],
            "tempo_bpm": metadata.get("tempo_bpm", 120.0),
            "time_signature": metadata.get("time_signature", "4/4"),
            "key_signature": metadata.get("key_signature", "C major"),
            "warning": None,
        }
    except Exception as e:
        raise HTTPException(500, f"Demo loading failed: {e}")


# Serve frontend static files
app.mount("/css", StaticFiles(directory=str(FRONTEND_DIR / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(FRONTEND_DIR / "js")), name="js")

# Serve Basic Pitch model files for the Web Worker
_BP_MODEL_DIR = _frozen_base() / "node_modules" / "@spotify" / "basic-pitch" / "model"
if _BP_MODEL_DIR.exists():
    app.mount("/model", StaticFiles(directory=str(_BP_MODEL_DIR)), name="basic-pitch-model")


@app.get("/")
async def serve_index():
    """Serve the main application page."""
    return FileResponse(str(FRONTEND_DIR / "index.html"))


if __name__ == "__main__":
    import threading
    import uvicorn
    import webbrowser

    def _open_browser():
        import time
        time.sleep(2)
        webbrowser.open("http://localhost:8000")

    threading.Thread(target=_open_browser, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=8000)
