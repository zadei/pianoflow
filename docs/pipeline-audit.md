# PianoFlow OMR Pipeline Audit

Secondary issues found in `backend/ocr_pipeline.py`, excluding the staff detection bug being fixed separately.

---

## Issue 1: Audiveris — No `-script` or `-option` flags for piano/multi-staff forcing

**Severity:** Medium

**Description:**
The Audiveris .bat is a standard Gradle-generated launcher that simply passes all arguments to the `Audiveris` Java main class. The current call is:

```
-batch -export -output <dir> <input>
```

Audiveris (v5.x) does support a `-option` flag to override internal engine constants, and a `-script` flag to run a `.js` script that can set per-score options. The options most relevant to grand-staff / piano detection are:

- `-option org.audiveris.omr.sheet.BookManager.useCompression=false` — forces uncompressed `.xml` output instead of `.mxl`, which avoids a potential parse ambiguity (see Issue 4).
- `-option org.audiveris.omr.sheet.rhythm.MeasureStack.interlineScale=<n>` and staff-grouping hints — there is no single flag to "force grand staff", but Audiveris infers multi-staff grouping from brace/bracket symbols in the scan. No documented CLI flag forces this.
- Bass clef recognition is purely image-based inside Audiveris; no CLI flag overrides it.

**Recommended fix:**
Add `-option org.audiveris.omr.sheet.BookManager.useCompression=false` to the command so Audiveris always outputs `.xml` rather than `.mxl`. This removes the decompression ambiguity described in Issue 4 and makes debugging easier. No flag exists to force multi-staff detection — that relies on scan quality (see Issue 2).

---

## Issue 2: PDF conversion DPI is borderline for small notation

**Severity:** Medium

**Description:**
`_convert_pdf_to_images()` renders at 300 DPI. For standard letter-size piano sheet music, this yields roughly 2550×3300 pixels per page — adequate for engraving software output. However, for:

- Scanned scores (already low-res before rasterisation)
- Dense passages with small noteheads (e.g., FORTNITE.pdf at 1.2 MB — compact file suggesting moderate complexity or a compressed scan)
- Ledger lines, accidentals, and stem flags at small sizes

300 DPI is the minimum recommended by the Audiveris documentation; 400 DPI is their suggested target for problematic scores. At 300 DPI a typical notehead is ~10–12 pixels tall. Audiveris's staff-line detector works best when staves are at least 6–8 pixels between lines; at 300 DPI this is satisfied, but only just.

**Recommended fix:**
Increase default DPI to 400. Consider making it a parameter so callers can override for problem files:

```python
def _convert_pdf_to_images(pdf_path: str, output_dir: str, max_pages: int = 20, dpi: int = 400) -> list[str]:
    images = convert_from_path(pdf_path, first_page=1, last_page=max_pages, dpi=dpi, poppler_path=poppler_path)
```

---

## Issue 3: Page offset mutation works correctly but is fragile

**Severity:** Low

**Description:**
The offset loop:

```python
if all_notes:
    max_beat = max(n.start_beat + n.duration_beats for n in all_notes)
    for n in page_notes:
        n.start_beat += max_beat
all_notes.extend(page_notes)
```

`NoteEvent` is a Pydantic v2 `BaseModel` with no `model_config` and no `frozen=True`. Pydantic v2 models are **mutable by default**, so `n.start_beat += max_beat` is valid and mutates the object in place. The mutation is correct.

However, there are two fragility concerns:

1. **`max_beat` is computed from `all_notes`, not the previous page alone.** On page 3, `max_beat` will be the maximum beat across pages 1 and 2 combined — which is correct. This works but is non-obvious.
2. **If a future developer adds `model_config = ConfigDict(frozen=True)` to `NoteEvent`** (common Pydantic hardening practice), this loop will raise `ValidationError` at runtime with no obvious connection to this code.

**Recommended fix:**
Replace the in-place mutation with an explicit offset creation to make intent clear and frozen-model safe:

```python
if all_notes:
    max_beat = max(n.start_beat + n.duration_beats for n in all_notes)
    page_notes = [n.model_copy(update={"start_beat": n.start_beat + max_beat}) for n in page_notes]
```

---

## Issue 4: `.mxl` is searched first but may contain multiple files

**Severity:** Low

**Description:**
The file search:

```python
for f in Path(output_dir).rglob("*.mxl"):
    return str(f)
for f in Path(output_dir).rglob("*.xml"):
    return str(f)
```

`.mxl` is a ZIP archive containing one or more `.xml` files plus a `META-INF/container.xml` manifest. `music21.converter.parse()` does handle `.mxl` correctly — it inspects the manifest and loads the root MusicXML file. So parsing is safe.

The actual risk is different: `rglob` returns files in **filesystem order** (not alphabetical, not deterministic across OS). If Audiveris emits multiple `.mxl` files (one per page in some output modes), the pipeline returns whichever the OS lists first rather than the first page. The same is true for `.xml`.

**Recommended fix:**
Sort the results and take the first lexicographically, which will match Audiveris's page-numbered output (`Book.mxl`, `Book-1.mxl`, etc.):

```python
mxl_files = sorted(Path(output_dir).rglob("*.mxl"))
if mxl_files:
    return str(mxl_files[0])
xml_files = sorted(Path(output_dir).rglob("*.xml"))
if xml_files:
    return str(xml_files[0])
```

Also note: Audiveris may emit a `Book.xml` (uncompressed) alongside `Book.mxl`. The current preference for `.mxl` is fine; no change needed there.

---

## Issue 5: FORTNITE.pdf sample — file size assessment

**Severity:** Informational

**Description:**
File: `/pianoflow_uploads/FORTNITE.pdf` — **1.2 MB**.

For a multi-page piano score this is moderate. A typical engraved PDF runs 200–400 KB per page; 1.2 MB suggests roughly 3–6 pages of moderate density, or a vector PDF with embedded fonts. This is well within the `max_pages=20` limit.

At 300 DPI, each page will render to a ~3–5 MB PNG. For a 5-page score, that is ~20 MB of intermediate image data plus Audiveris heap — manageable but worth monitoring. No code change required.

---

## Summary

| # | Issue | Severity | Action |
|---|-------|----------|--------|
| 1 | No CLI flag for forced grand-staff; add `-option` for uncompressed output | Medium | Add `-option` flag |
| 2 | DPI 300 is borderline; 400 recommended | Medium | Raise default DPI to 400 |
| 3 | Pydantic mutation works now but will silently break if model is frozen | Low | Use `model_copy(update=...)` |
| 4 | `rglob` returns non-deterministic order for multi-file output | Low | Sort before returning |
| 5 | FORTNITE.pdf (1.2 MB) is normal scale — no action needed | Info | — |
