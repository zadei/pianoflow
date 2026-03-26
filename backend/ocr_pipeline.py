"""OMR pipeline: PDF/image → Audiveris → MusicXML → music21 → note sequence."""

import asyncio
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Optional

import music21

from models import NoteEvent

logger = logging.getLogger(__name__)

# Limit concurrent Audiveris processes to prevent resource exhaustion
_ocr_semaphore = asyncio.Semaphore(2)

# Bundled dependency paths (relative to project root, one level up from backend/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_BUNDLED_AUDIVERIS = _PROJECT_ROOT / "dep" / "audiveris" / "bin" / "Audiveris.bat"
_BUNDLED_POPPLER_BIN = _PROJECT_ROOT / "dep" / "poppler" / "Library" / "bin"


def _find_audiveris_cmd() -> list[str]:
    """Return argv prefix for Audiveris: bundled dep first, then PATH."""
    if _BUNDLED_AUDIVERIS.exists():
        logger.info(f"Using bundled Audiveris: {_BUNDLED_AUDIVERIS}")
        # .bat files require cmd /c on Windows
        if sys.platform == "win32":
            return ["cmd", "/c", str(_BUNDLED_AUDIVERIS)]
        return [str(_BUNDLED_AUDIVERIS)]
    found = shutil.which("audiveris")
    if found:
        if sys.platform == "win32" and found.lower().endswith(".bat"):
            return ["cmd", "/c", found]
        return [found]
    return ["audiveris"]  # last-resort, will raise FileNotFoundError if absent


def _find_poppler_path() -> Optional[str]:
    """Return Poppler bin directory: bundled dep first, then PATH."""
    if _BUNDLED_POPPLER_BIN.exists():
        logger.info(f"Using bundled Poppler: {_BUNDLED_POPPLER_BIN}")
        return str(_BUNDLED_POPPLER_BIN)
    pdftoppm = shutil.which("pdftoppm")
    if pdftoppm:
        return str(Path(pdftoppm).parent)
    return None


def _detect_part_staff(part: music21.stream.Part, fallback_idx: int) -> int:
    """Return 1 (treble) or 2 (bass) based on the first recognized clef found in the part."""
    for clef in part.flatten().getElementsByClass(music21.clef.Clef):
        # Include base FClef to catch generic Audiveris bass clefs
        if isinstance(clef, (
            music21.clef.BassClef,
            music21.clef.Bass8vbClef,
            music21.clef.Bass8vaClef,
            music21.clef.FClef,
        )):
            return 2
        
        # Include base GClef to catch generic Audiveris treble clefs
        if isinstance(clef, (
            music21.clef.TrebleClef,
            music21.clef.Treble8vbClef,
            music21.clef.Treble8vaClef,
            music21.clef.AltoClef,
            music21.clef.GClef,
        )):
            return 1
            
    return 1 if fallback_idx == 0 else 2


def _resolve_staff(
    element: music21.base.Music21Object,
    default_staff: int,
    single_part_mode: bool,
    fallback_midi: Optional[float] = None,
) -> int:
    """Determine staff number (1=treble, 2=bass) for a note/chord element."""
    
    # Priority 1: Check PartStaff context (using strings avoids module attribute errors)
    staff_ctx = element.getContextByClass('PartStaff') or element.getContextByClass('Staff')
    if staff_ctx and getattr(staff_ctx, 'id', None) is not None:
        try:
            staff_id = str(staff_ctx.id)
            if '2' in staff_id: 
                return 2
            if '1' in staff_id: 
                return 1
            return int(staff_id)
        except (ValueError, TypeError):
            pass

    # (Backup for some music21 versions where explicit staff is stored in style)
    if getattr(element.style, 'staffNumber', None) is not None:
        try:
            return int(element.style.staffNumber)
        except (ValueError, TypeError):
            pass

    # Priority 2: Check Voice context
    voice_ctx = element.getContextByClass('Voice')
    if voice_ctx and getattr(voice_ctx, 'id', None) is not None:
        try:
            return 1 if int(voice_ctx.id) <= 2 else 2
        except (ValueError, TypeError):
            pass

    # Priority 3: Pitch-based heuristic (single-part grand staff fallback)
    if single_part_mode:
        midi = fallback_midi
        if midi is None and hasattr(element, 'pitch'):
            midi = element.pitch.midi
        if midi is not None:
            return 2 if midi < 60 else 1

    return default_staff


def _parse_musicxml(xml_path: str) -> tuple[list[NoteEvent], dict]:
    """Parse a MusicXML file into a list of NoteEvents and metadata."""
    score = music21.converter.parse(xml_path)

    metadata = {
        "tempo_bpm": 120.0,
        "time_signature": "4/4",
        "key_signature": "C major",
    }

    # Extract tempo.
    # getQuarterBPM() converts the written beat unit to quarter-note BPM (e.g. half=60 → 120).
    # numberImplicit lets music21 estimate BPM from text-only marks like "Andante".
    for mm in score.flatten().getElementsByClass(music21.tempo.MetronomeMark):
        bpm = None
        try:
            bpm = mm.getQuarterBPM()
        except Exception:
            pass
        if not bpm:
            bpm = mm.number or mm.numberImplicit
        if bpm and bpm > 0:
            # Clamp to a playable range
            metadata["tempo_bpm"] = float(max(20.0, min(300.0, bpm)))
            break

    # Extract time signature
    for ts in score.flatten().getElementsByClass(music21.meter.TimeSignature):
        metadata["time_signature"] = ts.ratioString
        break

    # Extract key signature
    for ks in score.flatten().getElementsByClass(music21.key.Key):
        metadata["key_signature"] = str(ks)
        break
    for ks in score.flatten().getElementsByClass(music21.key.KeySignature):
        metadata["key_signature"] = str(ks)
        break

    notes = []
    parts = score.parts

    # Detect single-part grand staff: if only 1 part, use voice 1/2 → staff 1/2
    single_part_mode = len(parts) == 1

    for part_idx, part in enumerate(parts):
        default_staff = _detect_part_staff(part, part_idx)
        for element in part.flatten().notesAndRests:
            if isinstance(element, music21.note.Note):
                # Skip grace notes — quarterLength=0 causes Pydantic validation error
                if element.quarterLength <= 0:
                    continue
                note_staff = _resolve_staff(element, default_staff, single_part_mode)
                notes.append(NoteEvent(
                    pitch=element.nameWithOctave,
                    midi_number=element.pitch.midi,
                    start_beat=float(element.offset),
                    duration_beats=float(element.quarterLength),
                    staff=note_staff,
                ))
            elif isinstance(element, music21.chord.Chord):
                # Skip grace chords
                if element.quarterLength <= 0:
                    continue
                # Use average pitch of chord for staff detection fallback
                avg_midi = sum(p.midi for p in element.pitches) / len(element.pitches)
                chord_staff = _resolve_staff(element, default_staff, single_part_mode, avg_midi)
                for p in element.pitches:
                    notes.append(NoteEvent(
                        pitch=p.nameWithOctave,
                        midi_number=p.midi,
                        start_beat=float(element.offset),
                        duration_beats=float(element.quarterLength),
                        staff=chord_staff,
                    ))

    notes.sort(key=lambda n: (n.start_beat, n.midi_number))
    return notes, metadata


def _convert_pdf_to_images(pdf_path: str, output_dir: str, max_pages: int = 20) -> list[str]:
    """Convert PDF pages to PNG images. Returns list of image paths."""
    from pdf2image import convert_from_path

    poppler_path = _find_poppler_path()

    images = convert_from_path(pdf_path, first_page=1, last_page=max_pages, dpi=400, poppler_path=poppler_path)
    paths = []
    for i, img in enumerate(images):
        img_path = os.path.join(output_dir, f"page_{i + 1}.png")
        img.save(img_path, "PNG")
        paths.append(img_path)
    return paths


async def _run_audiveris(input_path: str, output_dir: str) -> Optional[str]:
    """Run Audiveris CLI on an image/PDF, return path to MusicXML output."""
    cmd = _find_audiveris_cmd() + ["-batch", "-export", "-output", output_dir, input_path]
    logger.info(f"Running Audiveris: {' '.join(cmd)}")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        logger.error("Audiveris not found in bundled dep/ or PATH.")
        raise RuntimeError(
            "Audiveris not found. Java 17+ is required for image/PDF scanning. "
            "Download Java from https://adoptium.net — or upload a MusicXML file (.xml/.mxl) directly to skip OCR."
        )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        logger.error(f"Audiveris failed (code {proc.returncode}): {stderr.decode()}")
        return None

    # Find the generated MusicXML file (sort for deterministic selection)
    mxl_files = sorted(Path(output_dir).rglob("*.mxl"))
    if mxl_files:
        return str(mxl_files[0])
    xml_files = sorted(Path(output_dir).rglob("*.xml"))
    if xml_files:
        return str(xml_files[0])

    logger.error("Audiveris produced no MusicXML output")
    return None


async def process_upload(
    file_path: str,
    file_ext: str,
    work_dir: str,
) -> tuple[list[NoteEvent], dict, Optional[str]]:
    """
    Full OCR pipeline. Returns (notes, metadata, warning).
    Raises RuntimeError on failure.
    """
    async with _ocr_semaphore:
        warning = None

        # Direct MusicXML upload — skip OCR entirely
        if file_ext in (".xml", ".mxl", ".musicxml"):
            notes, metadata = _parse_musicxml(file_path)
            if not notes:
                raise RuntimeError("No notes found in MusicXML file")
            return notes, metadata, None

        # PDF → images first
        image_paths = []
        if file_ext == ".pdf":
            try:
                image_paths = _convert_pdf_to_images(file_path, work_dir)
            except Exception as e:
                raise RuntimeError(f"PDF conversion failed: {e}")
        else:
            image_paths = [file_path]

        # Run Audiveris on each image
        all_notes = []
        metadata = {}
        failed_pages = []

        for i, img_path in enumerate(image_paths):
            audiveris_out = os.path.join(work_dir, f"audiveris_page_{i}")
            os.makedirs(audiveris_out, exist_ok=True)

            xml_path = await _run_audiveris(img_path, audiveris_out)
            if xml_path is None:
                failed_pages.append(i + 1)
                continue

            try:
                page_notes, page_meta = _parse_musicxml(xml_path)
                if not metadata:
                    metadata = page_meta
                # Offset notes for subsequent pages (use model_copy to avoid mutating frozen models)
                if all_notes:
                    max_beat = max(n.start_beat + n.duration_beats for n in all_notes)
                    page_notes = [n.model_copy(update={"start_beat": n.start_beat + max_beat}) for n in page_notes]
                all_notes.extend(page_notes)
            except Exception as e:
                logger.error(f"Failed to parse page {i + 1}: {e}")
                failed_pages.append(i + 1)

        if not all_notes:
            raise RuntimeError(
                "Could not extract any notes. Try uploading a MusicXML file directly."
            )

        if failed_pages:
            warning = f"Pages {failed_pages} could not be parsed. Partial results returned."

        if not metadata:
            metadata = {"tempo_bpm": 120.0, "time_signature": "4/4", "key_signature": "C major"}

        return all_notes, metadata, warning


def cleanup_work_dir(work_dir: str) -> None:
    """Remove temporary working directory."""
    try:
        shutil.rmtree(work_dir, ignore_errors=True)
    except Exception as e:
        logger.warning(f"Cleanup failed for {work_dir}: {e}")
