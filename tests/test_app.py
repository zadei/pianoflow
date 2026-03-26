"""Integration tests for PianoFlow backend."""

import sys
import os
import tempfile

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

import pytest
from fastapi.testclient import TestClient
from models import NoteEvent, JobStatus, NotesResponse, StatusResponse, UploadResponse


def get_client():
    from main import app
    return TestClient(app)


# --- Model Tests ---

class TestModels:
    def test_note_event_valid(self):
        n = NoteEvent(pitch="C4", midi_number=60, start_beat=0.0, duration_beats=1.0, staff=1)
        assert n.pitch == "C4"
        assert n.midi_number == 60

    def test_note_event_midi_range(self):
        with pytest.raises(Exception):
            NoteEvent(pitch="X", midi_number=200, start_beat=0, duration_beats=1, staff=1)

    def test_note_event_duration_positive(self):
        with pytest.raises(Exception):
            NoteEvent(pitch="C4", midi_number=60, start_beat=0, duration_beats=0, staff=1)

    def test_upload_response(self):
        r = UploadResponse(job_id="abc")
        assert r.status == JobStatus.PROCESSING

    def test_notes_response(self):
        r = NotesResponse(job_id="abc", notes=[], tempo_bpm=100.0)
        assert r.tempo_bpm == 100.0
        assert r.time_signature == "4/4"


# --- API Tests ---

class TestAPI:
    def test_serve_index(self):
        client = get_client()
        res = client.get("/")
        assert res.status_code == 200
        assert "PianoFlow" in res.text

    def test_serve_css(self):
        client = get_client()
        res = client.get("/css/style.css")
        assert res.status_code == 200
        assert "body" in res.text

    def test_serve_js(self):
        client = get_client()
        res = client.get("/js/app.js")
        assert res.status_code == 200
        assert "PianoFlow" in res.text

    def test_upload_no_file(self):
        client = get_client()
        res = client.post("/api/upload")
        assert res.status_code == 422  # validation error

    def test_upload_bad_extension(self):
        client = get_client()
        res = client.post("/api/upload", files={"file": ("test.txt", b"hello", "text/plain")})
        assert res.status_code == 400
        assert "Unsupported" in res.json()["detail"]

    def test_upload_musicxml(self):
        """Upload a minimal MusicXML file and verify full pipeline."""
        client = get_client()
        musicxml = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>1</duration>
        <type>quarter</type>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>1</duration>
        <type>quarter</type>
      </note>
      <note>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>1</duration>
        <type>quarter</type>
      </note>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>1</duration>
        <type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>"""

        res = client.post(
            "/api/upload",
            files={"file": ("test.xml", musicxml.encode(), "application/xml")},
        )
        assert res.status_code == 200
        data = res.json()
        assert "job_id" in data
        job_id = data["job_id"]

        # Poll until done (MusicXML is instant, no Audiveris needed)
        import time
        for _ in range(10):
            status_res = client.get(f"/api/status/{job_id}")
            status = status_res.json()
            if status["status"] != "processing":
                break
            time.sleep(0.3)

        assert status["status"] == "completed"

        # Get notes
        notes_res = client.get(f"/api/notes/{job_id}")
        assert notes_res.status_code == 200
        notes_data = notes_res.json()
        assert len(notes_data["notes"]) == 4

        # Verify note sequence: C4, E4, G4, C5
        pitches = [n["pitch"] for n in notes_data["notes"]]
        assert "C4" in pitches
        assert "E4" in pitches
        assert "G4" in pitches
        assert "C5" in pitches

        # Verify MIDI numbers
        midis = sorted([n["midi_number"] for n in notes_data["notes"]])
        assert midis == [60, 64, 67, 72]

    def test_status_not_found(self):
        client = get_client()
        res = client.get("/api/status/nonexistent")
        assert res.status_code == 404

    def test_notes_not_found(self):
        client = get_client()
        res = client.get("/api/notes/nonexistent")
        assert res.status_code == 404


# --- OCR Pipeline Unit Tests ---

class TestOCRPipeline:
    def test_parse_musicxml_basic(self):
        from ocr_pipeline import _parse_musicxml
        import tempfile

        musicxml = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>1</duration>
        <type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>"""

        with tempfile.NamedTemporaryFile(suffix='.xml', mode='w', delete=False) as f:
            f.write(musicxml)
            f.flush()
            notes, metadata = _parse_musicxml(f.name)

        assert len(notes) >= 1
        assert notes[0].pitch == "A4"
        assert notes[0].midi_number == 69
        assert metadata["time_signature"] == "4/4"

        os.unlink(f.name)

    def test_cleanup_work_dir(self):
        from ocr_pipeline import cleanup_work_dir
        d = tempfile.mkdtemp()
        assert os.path.exists(d)
        cleanup_work_dir(d)
        assert not os.path.exists(d)

    def test_cleanup_nonexistent_dir(self):
        from ocr_pipeline import cleanup_work_dir
        # Should not raise
        cleanup_work_dir("/tmp/nonexistent_pianoflow_test_dir_xyz")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
