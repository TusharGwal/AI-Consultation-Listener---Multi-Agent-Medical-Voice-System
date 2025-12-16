# backend/app/services/consultation_listener_service.py

from typing import Dict, Optional
from uuid import uuid4
import json
from openai import AzureOpenAI
from app.models.consultation import Consultation, QAItem
from app.core.config import settings

# In-memory store for hackathon
consultation_memory: Dict[str, Consultation] = {}

def _get_azure_client() -> AzureOpenAI:
    return AzureOpenAI(
        api_version="2024-12-01-preview",
        azure_endpoint=settings.AZURE_FOUNDRY_ENDPOINT,
        api_key=settings.AZURE_FOUNDRY_API_KEY,
    )

client = _get_azure_client()

def get_or_create_consultation(session_id: str) -> str:
    """
    Map a voice session_id to a consultation_id.
    For hackathon, we can just reuse session_id as consultation_id.
    """
    if session_id not in consultation_memory:
        consultation_memory[session_id] = Consultation()
    return session_id


def append_transcript(consultation_id: str, new_text: str) -> Consultation:
    c = consultation_memory.get(consultation_id) or Consultation()
    if c.raw_transcript:
        c.raw_transcript += "\n" + new_text
    else:
        c.raw_transcript = new_text
    consultation_memory[consultation_id] = c
    return c


def run_extraction_agent(consultation_id: str) -> Consultation:
    c = consultation_memory[consultation_id]
    transcript = c.raw_transcript or ""
    if not transcript.strip():
        return c

    system_prompt = """
You are the Extraction Agent in a multi-agent medical consultation system.

You receive the FULL transcript of a doctor–patient visit.
Your job is to extract a clean, structured JSON object with:
- diagnoses (list of strings)
- symptoms (list of strings)
- medications (list of objects with name, dose, frequency, duration, notes)
- tests (list of strings)
- follow_up (string, may be empty)
- lifestyle_advice (list of strings)
- red_flags (list of strings describing "call doctor / ER if..." cases)

Return ONLY valid JSON. Do NOT hallucinate new diagnoses or medications.
If something is unclear, leave the field empty or omit it.
"""

    try:
        completion = client.chat.completions.create(
            model=settings.AZURE_CHAT_DEPLOYMENT,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Transcript:\n{transcript}"},
            ],
            response_format={"type": "json_object"},
        )

        json_text = completion.choices[0].message.content
        data = Consultation.model_validate_json(json_text)
        # Keep original transcript
        data.raw_transcript = c.raw_transcript
        consultation_memory[consultation_id] = data
        return data
    except Exception as e:
        print(f"Extraction failed: {e}")
        return c


def run_summary_agents(consultation_id: str) -> Consultation:
    c = consultation_memory[consultation_id]
    json_str = c.model_dump_json()

    patient_sys = """
You are the Patient Summary Agent.

Input: a structured JSON describing a medical consultation.
Output: a short, plain-language summary for the patient at about 8th-grade level.

Format:
- One short paragraph explaining the main problem and diagnosis.
- A bullet list "How to take your medicines".
- A bullet list "Things to watch out for".
- A sentence about the next follow-up or tests.

Do NOT add new medications, diagnoses or advice that are not in the JSON.
If something is missing, say "This part was not clearly discussed, please confirm with your doctor."
"""

    doctor_sys = """
You are the Doctor Summary Agent.

Input: structured JSON of a consultation.
Output: a concise clinical note suitable to copy into an EHR.

Use a SOAP-style structure:
- Subjective:
- Assessment:
- Plan:

Include medications (name, dose, frequency, duration) and follow-up.
Do NOT invent data that is not in the JSON.
"""

    try:
        patient_res = client.chat.completions.create(
            model=settings.AZURE_CHAT_DEPLOYMENT,
            messages=[
                {"role": "system", "content": patient_sys},
                {"role": "user", "content": json_str},
            ],
        )
        doctor_res = client.chat.completions.create(
            model=settings.AZURE_CHAT_DEPLOYMENT,
            messages=[
                {"role": "system", "content": doctor_sys},
                {"role": "user", "content": json_str},
            ],
        )

        c.notes_for_patient = patient_res.choices[0].message.content
        c.notes_for_doctor = doctor_res.choices[0].message.content
        consultation_memory[consultation_id] = c
    except Exception as e:
        print(f"Summary agents failed: {e}")
    
    return c


def run_qa_agent(consultation_id: str, question: str) -> str:
    c = consultation_memory[consultation_id]
    
    # Build history string
    history_text = ""
    if c.qa_history:
        history_text = "PREVIOUS Q&A:\n" + "\n".join([f"Q: {item.question}\nA: {item.answer}" for item in c.qa_history]) + "\n\n"

    qa_sys = """
You are the Q&A Agent for a past consultation.

You get:
- A structured consultation JSON
- A history of previous Q&A (optional)
- A patient's question

Answer ONLY using information from the JSON.
If the answer is not clearly in the JSON, say:
"I'm not sure, this wasn’t clearly discussed in this visit — please confirm with your doctor."

Be brief and patient-friendly.
"""

    payload = f"CONSULTATION JSON:\n{c.model_dump_json(indent=2, exclude={'qa_history'})}\n\n{history_text}QUESTION:\n{question}"

    try:
        res = client.chat.completions.create(
            model=settings.AZURE_CHAT_DEPLOYMENT,
            messages=[
                {"role": "system", "content": qa_sys},
                {"role": "user", "content": payload},
            ],
        )
        answer = res.choices[0].message.content
        
        # Save to history
        c.qa_history.append(QAItem(question=question, answer=answer))
        consultation_memory[consultation_id] = c
        
        return answer
    except Exception as e:
        return f"I'm sorry, I couldn't process that question. Error: {e}"

# STT and TTS helpers
async def speech_to_text(audio_bytes: bytes, content_type: str = "audio/wav") -> str:
    """Convert speech to text using Azure OpenAI Whisper"""
    try:
        transcript = client.audio.transcriptions.create(
            model="whisper", 
            file=("audio.wav", audio_bytes, content_type),
            response_format="verbose_json"
        )
        
        text = transcript.text
        if not text:
            raise RuntimeError("No transcript returned from Whisper")
        return text
    except Exception as e:
        print(f"STT failed: {e}")
        raise e

async def text_to_speech(text: str) -> bytes:
    """Convert text to speech using Azure OpenAI TTS"""
    try:
        with client.audio.speech.with_streaming_response.create(
            model=settings.AZURE_TTS_DEPLOYMENT,
            voice=settings.AZURE_TTS_VOICE,
            input=text,
            response_format="wav",
        ) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"TTS failed with status {resp.status_code}")
            audio_bytes = resp.read()
            if not audio_bytes or len(audio_bytes) < 44:
                raise RuntimeError(f"Invalid audio: {len(audio_bytes)} bytes")
        return audio_bytes
    except Exception as e:
        print(f"TTS failed: {e}")
        return b""
