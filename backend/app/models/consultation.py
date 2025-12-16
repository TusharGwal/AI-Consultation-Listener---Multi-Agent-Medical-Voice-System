# backend/app/models/consultation.py

from pydantic import BaseModel
from typing import List, Optional


class Medication(BaseModel):
    name: str
    dose: Optional[str] = None
    frequency: Optional[str] = None
    duration: Optional[str] = None
    notes: Optional[str] = None

class QAItem(BaseModel):
    question: str
    answer: str

class Consultation(BaseModel):
    patient_name: Optional[str] = None
    visit_date: Optional[str] = None
    diagnoses: List[str] = []
    symptoms: List[str] = []
    medications: List[Medication] = []
    tests: List[str] = []
    follow_up: Optional[str] = None
    lifestyle_advice: List[str] = []
    red_flags: List[str] = []
    notes_for_doctor: Optional[str] = None
    notes_for_patient: Optional[str] = None
    raw_transcript: Optional[str] = None
    qa_history: List[QAItem] = []
