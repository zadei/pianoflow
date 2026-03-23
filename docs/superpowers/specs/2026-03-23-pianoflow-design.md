# PianoFlow — Design Spec

## Overview

A lightweight piano learning app that uses microphone-based note detection and OCR-parsed sheet music to present a Synthesia-style falling-notes interface. Built with a Python (FastAPI) backend and browser-based frontend.

**Target user**: Someone with an acoustic grand piano (no MIDI), who wants to practice by uploading sheet music and playing along with visual guidance.

## Architecture

```
[User uploads sheet music] → [FastAPI backend]
    ↓
[PDF/Image → Audiveris OMR → MusicXML → music21 → Note Sequence JSON]
    ↓
[Browser Frontend via REST API]
    ↓
[Canvas: falling notes + dynamic keyboard + effects]
    ↓
[Web Audio API: mic → pitch detection → match against expected notes]
```

### Backend (Python + FastAPI)

Responsibilities:
- Serve the web application (static files)
- Accept sheet music uploads (JPG, PNG, PDF)
- Run the OCR/OMR pipeline to extract note data
- Expose REST endpoints for upload and note sequence retrieval
- Async OCR processing via `asyncio.create_task` (Audiveris can take 30+ seconds on complex scores)

### Frontend (HTML Canvas + Vanilla JS)

Responsibilities:
- Render falling-note visualization on HTML Canvas
- Render dynamic piano keyboard (range adapts to current piece)
- Real-time pitch detection via Web Audio API (no server round-trip)
- Visual effects (glow, particles) for correct note hits
- Tempo control slider
- Pause mode toggle

## Sheet Music OCR Pipeline

### Input Formats
- **Images**: JPG, PNG (photos/scans of physical sheet music)
- **PDF**: Digital sheet music files (converted to images internally)

### Processing Steps
1. **PDF → Images**: `pdf2image` (via poppler) converts each page to PNG
2. **OMR**: Audiveris (Java-based, invoked as subprocess) processes images → outputs MusicXML
3. **Parsing**: `music21` (Python) reads MusicXML → extracts note sequence
4. **Output**: JSON array of note events:
   ```json
   [
     {
       "pitch": "C4",
       "midi_number": 60,
       "start_beat": 0.0,
       "duration_beats": 1.0,
       "staff": 1
     }
   ]
   ```
5. **Fallback**: Direct MusicXML upload supported as bypass if OMR quality is poor

### Audiveris Integration
- Invoked as CLI subprocess: `audiveris -batch -export -output <dir> <input_file>`
- Requires Java runtime (JRE 17+)
- Returns MusicXML file which music21 parses

## Frontend Visuals

### Falling Notes Display
- Dark background (black/near-black)
- Note blocks are golden/amber colored (matching reference screenshot aesthetic)
- Notes fall vertically downward toward the keyboard
- Fall speed determined by current tempo setting
- Note block height proportional to note duration
- Note block horizontal position maps to its key on the keyboard

### Dynamic Keyboard
- Rendered at the bottom of the canvas
- Shows only the range of keys relevant to the current piece (with small padding)
- White keys and black keys rendered with 3D-ish styling
- Keys light up when the corresponding note is detected from the mic

### Visual Feedback

#### Correct Note Hit
- Golden glow effect radiating from the key
- Particle burst upward from the key (small golden sparks)
- Note block illuminates brightly as it crosses the hit line
- Streak counter increments

#### Missed Note
- Note block dims/fades to a muted color as it passes the hit line
- No harsh punishment — subtle visual only
- Streak counter resets

#### Pause Mode (Toggleable)
- When enabled: falling notes freeze until the correct note is played
- Allows learning at own pace
- Visual indicator showing pause mode is active
- Notes resume falling once correct note is detected

### Tempo Control
- Slider UI: range 0.25x to 2.0x (default 1.0x)
- Adjusts the speed at which notes fall
- Does not change pitch — purely a visual speed adjustment
- Display shows current tempo multiplier and resulting BPM

## Pitch Detection (Browser-Side)

### Approach
- Web Audio API `getUserMedia()` captures microphone input
- **AudioWorklet** processes audio in a dedicated thread for consistent low-latency callbacks
- AudioWorklet sends detected frequency data to the main thread via `MessagePort`
- Main thread reads latest pitch data in `requestAnimationFrame` loop for rendering sync
- **Algorithm**: Autocorrelation-based (YIN variant) for monophonic pitch detection

### Pitch Mapping
- Detected frequency mapped to nearest semitone (A0=27.5Hz to C8=4186Hz)
- Tolerance window: +/- 50 cents (half semitone) for match
- Octave detection critical — algorithm must distinguish C3 from C4 reliably

### Note Matching
- Detected pitch compared against next expected note(s) in the sequence
- Timing window: note is "hittable" when its block is within +/- 200ms of the hit line (configurable)
- **v1 is monophonic** — detects one note at a time. For chords, each note is matched individually as played (arpeggiated). Polyphonic detection is a future goal

### Error States
- **Mic not available**: Prompt user to grant permission, show clear instructions
- **No pitch detected**: No action — silence is not penalized
- **Ambient noise**: Configurable volume threshold to filter background noise

## API Endpoints

### REST
- `POST /api/upload` — Upload sheet music file (image/PDF/MusicXML), returns job ID. Max file size: 20MB, max 20 pages for PDFs
- `GET /api/status/{job_id}` — Check OCR processing status. States: `processing`, `completed`, `failed` (with error message)
- `GET /api/notes/{job_id}` — Retrieve parsed note sequence JSON
- `GET /` — Serve the web application

All session state (tempo, pause, progress) is managed entirely client-side — no WebSocket needed for a single-user local app.

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Backend | Python 3.11+ / FastAPI | API server, file handling, OCR orchestration |
| OMR | Audiveris 5.x (Java) | Sheet music image → MusicXML |
| PDF Processing | pdf2image + poppler | PDF → image conversion |
| Music Parsing | music21 | MusicXML → structured note data |
| Frontend | HTML Canvas + vanilla JS | All rendering and interaction |
| Audio | Web Audio API + AudioWorklet | Microphone capture + pitch detection |

## File Structure

```
piano/
├── backend/
│   ├── main.py              # FastAPI app, routes
│   ├── ocr_pipeline.py      # OMR orchestration (pdf→image→audiveris→music21)
│   ├── models.py            # Pydantic models for note data
│   └── requirements.txt     # Python dependencies
├── frontend/
│   ├── index.html           # Main page
│   ├── css/
│   │   └── style.css        # Styling
│   └── js/
│       ├── app.js           # Main app entry, state management
│       ├── renderer.js      # Canvas rendering (falling notes, keyboard, effects)
│       ├── pitch-worklet.js  # AudioWorklet processor (runs in audio thread)
│       ├── pitch.js         # Pitch detection manager (main thread side)
│       ├── particles.js     # Particle system for hit effects
│       └── audio.js         # Microphone setup and audio pipeline
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-03-23-pianoflow-design.md
```

## Dependencies

### Python
- `fastapi` + `uvicorn` — web server
- `python-multipart` — file upload handling
- `music21` — MusicXML parsing
- `pdf2image` — PDF to image conversion
- `Pillow` — image handling

### External
- **Poppler** — required by pdf2image for PDF rendering. On Windows: install via `conda install poppler` or download binaries and add to PATH
- **Java JRE 17+** — required by Audiveris
- **Audiveris 5.x** — OMR engine (installed separately)

### OCR Pipeline Error Handling
- **Corrupt/unreadable file**: Return `failed` status with descriptive error message
- **Audiveris parse failure**: Return `failed` with suggestion to try MusicXML upload instead
- **Partial parse**: If some pages fail, return successfully parsed notes with a warning flag
- **Frontend**: Show clear error message with actionable next steps (retry, try different format, upload MusicXML directly)

### Frontend
- No npm dependencies — vanilla JS only
- Web Audio API (built into modern browsers)
- Canvas API (built into modern browsers)

## Non-Goals (v1)
- MIDI input/output support
- Multi-instrument support (piano only)
- Lesson/curriculum system
- User accounts or progress persistence
- Mobile support
- Audio playback of the sheet music
- Polyphonic (chord) detection — v1 is monophonic, chords must be arpeggiated
