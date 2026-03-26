# PianoFlow Dependency Audit

**Date**: 2026-03-24
**Python**: 3.12.2
**pytest**: 9.0.2

---

## Summary

One warning found. No blocking errors. All tests pass. External tools present in PATH.

---

## Findings

### WARNING: urllib3/chardet version conflict

**Severity**: Low (non-blocking warning)

**Source**: `requests` package at import time (triggered during `import fastapi` and pytest run)

**Message**:
```
RequestsDependencyWarning: urllib3 (2.2.1) or chardet (7.2.0)/charset_normalizer (3.3.2)
doesn't match a supported version!
```

**Cause**: The globally-installed `requests` library expects different versions of `urllib3` or `charset_normalizer` than what is installed. This is a transitive conflict from the global Python environment — not from `requirements.txt`.

**Impact**: Warning only. All 16 tests pass. FastAPI, uvicorn, music21, pdf2image, and pydantic all import successfully.

**Recommended fix**: Pin compatible versions in a virtual environment:
```
pip install "urllib3>=2.0,<3" "charset-normalizer>=3.1,<4"
```

---

## Checks Passed

| Check | Result |
|---|---|
| `requirements.txt` readable | Pass |
| `import fastapi` | Pass |
| `import uvicorn` | Pass |
| `import music21` | Pass (9.9.1 >= 9.1.0 required) |
| `import pdf2image` | Pass |
| `import pydantic` | Pass |
| `pytest tests/ -x` | Pass — 16/16 passed |
| `audiveris` in PATH | Pass — `C:\Users\zade\audiveris\bin\Audiveris` |
| `pdftoppm` in PATH | Pass — `C:\Users\zade\poppler\Library\bin\pdftoppm.exe` |

---

## Requirements vs Installed

| Package | Required | Installed |
|---|---|---|
| fastapi | >=0.104.0 | present |
| uvicorn[standard] | >=0.24.0 | present |
| python-multipart | >=0.0.6 | 0.0.20 |
| music21 | >=9.1.0 | 9.9.1 |
| pdf2image | >=1.16.3 | present |
| Pillow | >=10.0.0 | present |

All requirements satisfied.
