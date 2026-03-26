# PianoFlow Swarm Audit Report

**Date:** 2026-03-24
**Auditor:** ArchitectAgent
**Scope:** Backend Python files, frontend JS inventory, stray file investigation

---

## 1. Dependency Versions

File: `backend/requirements.txt`

| Package | Pin | Assessment |
|---|---|---|
| `fastapi` | `>=0.104.0` | Minimum floor only — no upper bound. FastAPI 0.115.x is current; `>=0.104.0` is safe but could pull breaking changes in a future major release. |
| `uvicorn[standard]` | `>=0.24.0` | No upper bound. Acceptable for a local app. |
| `python-multipart` | `>=0.0.6` | No upper bound. Required for FastAPI file uploads. |
| `music21` | `>=9.1.0` | No upper bound. music21 9.x introduced breaking API changes from 8.x; the floor of 9.1.0 is appropriate given the code uses `score.parts`, `flatten()`, and `model_dump()` (Pydantic v2). |
| `pdf2image` | `>=1.16.3` | No upper bound. Stable API, low risk. |
| `Pillow` | `>=10.0.0` | No upper bound. Pillow 10.0 dropped many legacy APIs; the `>=10.0.0` floor is correct. |

**Issues:**
- `Pillow` is listed but never imported directly in any backend Python file. It is an indirect dependency of `pdf2image` — the pin is harmless but redundant unless the frontend or tests use it directly.
- No `pydantic` pin is present. FastAPI 0.104+ requires Pydantic v2. Because Pydantic is not pinned explicitly, `pip install` will resolve it transitively. This is a latent risk: if a resolver selects Pydantic v1 for any reason (e.g., conflict with another environment package), `model_dump()` in `models.py` will break. **Recommendation:** add `pydantic>=2.0` explicitly.
- `audiveris` and `poppler` are system/Java dependencies not expressible in `requirements.txt`. There is no `README` or install script documenting the required runtime versions. This is an operational gap.

**No version conflicts detected** among the listed packages.

---

## 2. Import Chain

### `main.py`

Standard library imports: `asyncio`, `logging`, `os`, `shutil`, `tempfile`, `uuid`, `contextlib.asynccontextmanager`, `pathlib.Path` — all resolvable.

Third-party imports:
- `fastapi` (FastAPI, File, HTTPException, UploadFile, FileResponse, StaticFiles) — resolves via `requirements.txt`.

Local imports:
- `from models import JobStatus, NotesResponse, StatusResponse, UploadResponse` — all four symbols are defined in `models.py`. PASS.
- `from ocr_pipeline import cleanup_work_dir, process_upload` — `ocr_pipeline.py` exists. `process_upload` is referenced in the pipeline body. `cleanup_work_dir` must also be exported from `ocr_pipeline.py`.

**Risk:** `cleanup_work_dir` was not visible in the indexed top-level section of `ocr_pipeline.py`. If it is not defined there, `main.py` will fail at import time with `ImportError`. This warrants direct verification.

### `ocr_pipeline.py`

Standard library imports: `asyncio`, `logging`, `os`, `shutil`, `tempfile`, `pathlib.Path`, `typing.Optional` — all resolvable.

Third-party: `import music21` — resolves via `requirements.txt`.

Local: `from models import NoteEvent` — defined in `models.py`. PASS.

Lazy import inside function body: `from pdf2image import convert_from_path` — resolves via `requirements.txt`. Lazy import pattern is intentional (avoids import failure when Poppler is absent at startup).

### `models.py`

Standard library: `enum.Enum`, `typing.Optional` — resolvable.

Third-party: `pydantic` (BaseModel, Field) — resolves transitively via FastAPI. Uses `model_dump()` which requires Pydantic v2.

**Overall import chain: PASS with one caveat** — `cleanup_work_dir` export from `ocr_pipeline.py` needs confirmation.

---

## 3. File Integrity

### Backend

| File | Present |
|---|---|
| `backend/main.py` | Yes |
| `backend/ocr_pipeline.py` | Yes |
| `backend/models.py` | Yes |
| `backend/requirements.txt` | Yes |

No missing backend files detected.

### Frontend JS

| File | Present |
|---|---|
| `frontend/js/app.js` | Yes |
| `frontend/js/audio.js` | Yes |
| `frontend/js/particles.js` | Yes |
| `frontend/js/pitch.js` | Yes |
| `frontend/js/pitch-worklet.js` | Yes |
| `frontend/js/renderer.js` | Yes |

All 6 expected JS files are present.

### Tests

| File | Present |
|---|---|
| `tests/test_app.py` | Yes |

---

## 4. Stray File: `pitchDet.update(freq`

- **Location:** Project root (`C:\Users\zade\Desktop\piano\`)
- **Content:** Empty (zero bytes)
- **Assessment:** The filename is a fragment of JavaScript or Python source code — `pitchDet.update(freq` — that was almost certainly created accidentally (e.g., a terminal paste or editor mis-fire wrote the code snippet as a filename instead of into a file buffer).
- **Action:** This file serves no purpose, contains no data, and pollutes the project root. **Delete it.**

```bash
rm "/c/Users/zade/Desktop/piano/pitchDet.update(freq"
```

---

## 5. Summary of Findings

1. **Dependency risk (medium):** `pydantic` is not pinned explicitly. Add `pydantic>=2.0` to `requirements.txt` to prevent silent Pydantic v1 resolution that would break `model_dump()`.
2. **Import risk (low-medium):** `cleanup_work_dir` is imported in `main.py` from `ocr_pipeline`. Confirm it is exported; if missing, startup will fail with `ImportError`.
3. **Operational gap (low):** Audiveris (Java) and Poppler are undocumented runtime prerequisites. No install guide or version requirement exists in the repo.
4. **Stray file (cleanup required):** `/pitchDet.update(freq` is an empty, accidentally-named file in the project root. Delete it.
5. **All 6 frontend JS files confirmed present;** all 4 backend Python files confirmed present; import chains for models and direct third-party packages are clean.

---

## Recommended Actions (Priority Order)

1. Delete stray file `pitchDet.update(freq` from project root.
2. Add `pydantic>=2.0` to `backend/requirements.txt`.
3. Verify `cleanup_work_dir` is defined and exported in `ocr_pipeline.py`.
4. Add a `docs/setup.md` or similar documenting Audiveris and Poppler installation requirements and tested versions.
5. (Optional) Add upper-bound pins (`fastapi<1.0`, `music21<10.0`) if build reproducibility is a concern.
