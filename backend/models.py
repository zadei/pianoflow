"""Pydantic models for PianoFlow note data and API responses."""

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class NoteEvent(BaseModel):
    pitch: str = Field(..., description="Note name with octave, e.g. C4")
    midi_number: int = Field(..., ge=21, le=108, description="MIDI note number (A0=21 to C8=108)")
    start_beat: float = Field(..., ge=0.0, description="Start position in beats")
    duration_beats: float = Field(..., gt=0.0, description="Duration in beats")
    staff: int = Field(1, ge=1, le=2, description="Staff number (1=treble, 2=bass)")


class UploadResponse(BaseModel):
    job_id: str
    status: JobStatus = JobStatus.PROCESSING
    message: str = "Processing started"


class StatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    message: str = ""
    error: Optional[str] = None
    warning: Optional[str] = None


class NotesResponse(BaseModel):
    job_id: str
    notes: list[NoteEvent]
    tempo_bpm: float = 120.0
    time_signature: str = "4/4"
    key_signature: str = "C major"
    warning: Optional[str] = None
