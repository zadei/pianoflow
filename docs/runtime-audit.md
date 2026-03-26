# PianoFlow Runtime & File Integrity Audit

**Date:** 2026-03-24
**Auditor:** Claude Code (automated)

---

## 1. Backend Python Files — Syntax & Import Check

### backend/main.py
- **Syntax:** PASS (AST parse clean, 161 lines)
- **Hardcoded paths:** None found
- **Imports:** All standard; uses `fastapi`, `pathlib`, `asyncio`, `logging`, `os`, `shutil`, `tempfile`, `uuid`
- **Local imports:** `models` (JobStatus, NotesResponse, StatusResponse, UploadResponse), `ocr_pipeline` (cleanup_work_dir, process_upload)
- **Note:** `import uvicorn` at line 159 is inside `if __name__ == "__main__":` — intentional guard pattern, not an issue.

### backend/ocr_pipeline.py
- **Syntax:** PASS (AST parse clean, 203 lines)
- **Hardcoded paths:** None found
- **Imports:** `asyncio`, `logging`, `os`, `shutil`, `tempfile`, `pathlib`, `typing`, `music21`, `models` (NoteEvent)
- **Note:** `from pdf2image import convert_from_path` at line 85 is a lazy import inside `_convert_pdf_to_images()` — intentional deferred import pattern, not an issue.

### backend/models.py
- **Syntax:** PASS (AST parse clean, 43 lines)
- **Hardcoded paths:** None found
- **Imports:** `enum`, `typing`, `pydantic` (BaseModel, Field) — clean and minimal.

---

## 2. Frontend File Integrity Check

All 8 required frontend files confirmed present:

| File | Status |
|------|--------|
| `frontend/index.html` | EXISTS |
| `frontend/css/style.css` | EXISTS |
| `frontend/js/app.js` | EXISTS |
| `frontend/js/renderer.js` | EXISTS |
| `frontend/js/pitch-worklet.js` | EXISTS |
| `frontend/js/pitch.js` | EXISTS |
| `frontend/js/particles.js` | EXISTS |
| `frontend/js/audio.js` | EXISTS |

---

## 3. Stray Root File

| File | Finding | Action |
|------|---------|--------|
| `pitchDet.update(freq` | 0 bytes — empty file, appears to be an accidental paste of a code fragment into the shell that created a file | **DELETED** |

---

## 4. Issues Found & Fixes Applied

| # | Severity | File | Issue | Fix Applied |
|---|----------|------|-------|-------------|
| 1 | LOW | `pitchDet.update(freq` (root) | Empty stray file with code-fragment name | Deleted |

No syntax errors, no hardcoded paths, no missing imports detected in any backend file. No missing frontend files.

---

## 5. Summary

- **Backend:** All 3 Python files pass AST syntax check. No hardcoded filesystem paths. All imports are appropriate (2 are intentionally deferred/guarded).
- **Frontend:** All 8 required files are present.
- **Root cleanup:** 1 empty stray file deleted.
- **Overall status: PASS** — no blocking issues found.
