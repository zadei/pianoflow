# PianoFlow

A piano learning app for acoustic piano players — no MIDI required. Upload sheet music, and PianoFlow renders a Synthesia-style falling-notes display while listening to your microphone to track what you play in real time.

---

## Features

- **Sheet music upload** — JPG, PNG, PDF, or MusicXML
- **Falling-notes display** — dark background, golden note blocks, Synthesia-style
- **Dynamic keyboard** — auto-adapts range to the piece; keys light up on correct hits
- **Real-time pitch detection** — microphone-based, no MIDI hardware needed
- **Pause mode** — notes freeze until you play the correct note (learn at your own pace)
- **Tempo control** — 0.25×–2.0× speed slider
- **Visual feedback** — glow + particle burst on hits; subtle dim on misses
- **Async OCR** — sheet music processing runs in the background (Audiveris can take 30+ seconds on complex scores)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.11+ | |
| Java JRE | 17+ | Required by Audiveris |
| Audiveris | 5.x | OMR engine — [install separately](https://github.com/Audiveris/audiveris), must be in `PATH` |
| Poppler | latest | Required for PDF support — Windows: `conda install poppler` or add binaries to `PATH` |

---

## Installation & Setup

```bash
cd backend
pip install -r requirements.txt
```

### Start the server

```bash
python main.py
```

App runs at **http://127.0.0.1:8000**

---

## Usage

1. Open http://127.0.0.1:8000 in your browser
2. Grant microphone access when prompted
3. Upload a sheet music file (JPG, PNG, PDF, or MusicXML)
4. Wait for OCR processing to complete
5. Use the tempo slider to set your practice speed
6. Play along — notes light up as you hit them correctly

**Tip**: If OCR quality is poor, export your sheet music as MusicXML and upload that directly to bypass Audiveris.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload sheet music. Returns `job_id`. Max 20MB, max 20 pages (PDF). |
| `GET` | `/api/status/{job_id}` | Poll processing status: `processing` \| `completed` \| `failed` |
| `GET` | `/api/notes/{job_id}` | Retrieve parsed note sequence JSON |
| `GET` | `/` | Serve the web application |

### Note event schema

```json
{
  "pitch": "C4",
  "midi_number": 60,
  "start_beat": 0.0,
  "duration_beats": 1.0,
  "staff": 1
}
```

---

## Project Structure

```
piano/
├── backend/
│   ├── main.py              # FastAPI app and routes
│   ├── ocr_pipeline.py      # OMR orchestration (PDF → image → Audiveris → music21)
│   ├── models.py            # Pydantic response models
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js           # App entry point and state management
│       ├── renderer.js      # Canvas rendering (notes, keyboard, effects)
│       ├── pitch-worklet.js # AudioWorklet processor (audio thread)
│       ├── pitch.js         # Pitch detection manager (main thread)
│       ├── particles.js     # Particle system for hit effects
│       └── audio.js         # Microphone setup and audio pipeline
└── docs/
    └── README.md
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Backend | Python 3.11+ / FastAPI | API server, file handling, OCR orchestration |
| OMR | Audiveris 5.x (Java) | Sheet music image → MusicXML |
| PDF Processing | pdf2image + Poppler | PDF → image conversion |
| Music Parsing | music21 | MusicXML → structured note data |
| Frontend | HTML Canvas + vanilla JS | All rendering and interaction (no npm deps) |
| Audio | Web Audio API + AudioWorklet | Microphone capture and pitch detection |

---

## v1 Scope & Non-Goals

This is a v1 focused on solo acoustic piano practice. The following are explicitly out of scope:

- MIDI input/output
- Multi-instrument support
- User accounts or progress persistence
- Mobile support
- Audio playback of the sheet music
- Polyphonic chord detection — v1 is monophonic; play chords as arpeggios
