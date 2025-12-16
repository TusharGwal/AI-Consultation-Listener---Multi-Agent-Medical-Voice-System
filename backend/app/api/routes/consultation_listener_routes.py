# backend/app/api/routes/consultation_listener_routes.py

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException, Form
from fastapi.responses import StreamingResponse, JSONResponse
from uuid import uuid4
from typing import Optional
import urllib.parse

from app.services.consultation_listener_service import (
    get_or_create_consultation,
    append_transcript,
    run_extraction_agent,
    run_summary_agents,
    run_qa_agent,
    consultation_memory,
    speech_to_text,
    text_to_speech
)
from app.core.config import settings

router = APIRouter(prefix="/consultation", tags=["consultation"])


@router.post("/voice")
async def consultation_voice(
    audio: UploadFile = File(...),
    session_id: Optional[str] = Form(None),
    trigger_summary: bool = Form(False),
):
    """
    Main voice endpoint: receives audio from frontend,
    transcribes it, updates consultation, optionally triggers MAS,
    and returns a spoken reply.
    """
    # 1) Map session_id -> consultation_id
    if not session_id or session_id == "undefined":
        session_id = str(uuid4())
    consultation_id = get_or_create_consultation(session_id)

    # 2) Read audio bytes
    audio_bytes = await audio.read()

    # 3) Transcribe
    try:
        transcript_text = await speech_to_text(audio_bytes, audio.content_type or "audio/wav")
    except Exception as e:
        return JSONResponse({"error": f"STT Error: {str(e)}"}, status_code=400)
    
    if not transcript_text:
        # Fallback if STT fails
        return JSONResponse({"error": "Could not transcribe audio (empty result)"}, status_code=400)

    # 4) Append transcript to consultation
    consultation = append_transcript(consultation_id, transcript_text)

    # 5) Decide if we should trigger extraction/summaries
    # Simple heuristic: if user says something like "summarize" or "we're done" OR if trigger_summary is True
    lower = transcript_text.lower()
    reply_text = ""
    if trigger_summary or "summarize" in lower or "we are done" in lower or "finish summary" in lower:
        consultation = run_extraction_agent(consultation_id)
        consultation = run_summary_agents(consultation_id)
        reply_text = "Okay, I’ve summarized your visit. You can see the doctor and patient views on the screen. You can also ask me questions about your visit."
    else:
        # Otherwise, maybe echo or keep quiet
        reply_text = "I’m listening. You can continue, or say ‘we are done, please summarize’ when ready."

    # 6) Generate TTS audio from reply_text
    tts_bytes = await text_to_speech(reply_text)

    return StreamingResponse(
        iter([tts_bytes]),
        media_type="audio/wav",
        headers={"X-Session-Id": session_id, "X-Consultation-Id": consultation_id},
    )


@router.get("/{consultation_id}/summary")
async def get_consultation_summary(consultation_id: str):
    c = consultation_memory.get(consultation_id)
    if not c:
        raise HTTPException(status_code=404, detail="Consultation not found")
    return JSONResponse(
        {
            "consultation_id": consultation_id,
            "doctor_view": c.notes_for_doctor,
            "patient_view": c.notes_for_patient,
            "raw_transcript": c.raw_transcript,
        }
    )


@router.post("/{consultation_id}/qa")
async def consultation_qa(consultation_id: str, question: str = Form(...)):
    if consultation_id not in consultation_memory:
        raise HTTPException(status_code=404, detail="Consultation not found")

    answer = run_qa_agent(consultation_id, question)
    return {"answer": answer}


@router.post("/{consultation_id}/qa/voice")
async def consultation_qa_voice(
    consultation_id: str,
    audio: UploadFile = File(...)
):
    if consultation_id not in consultation_memory:
        raise HTTPException(status_code=404, detail="Consultation not found")

    # 1. Transcribe
    audio_bytes = await audio.read()
    question_text = await speech_to_text(audio_bytes, audio.content_type or "audio/wav")
    
    if not question_text:
        return JSONResponse({"error": "Could not transcribe audio"}, status_code=400)

    # 2. Get Answer
    answer_text = run_qa_agent(consultation_id, question_text)

    # 3. TTS
    tts_bytes = await text_to_speech(answer_text)

    # 4. Return Audio with Answer in Header (encoding to handle special chars)
    encoded_answer = urllib.parse.quote(answer_text)
    encoded_question = urllib.parse.quote(question_text)

    return StreamingResponse(
        iter([tts_bytes]),
        media_type="audio/wav",
        headers={
            "X-Question": encoded_question,
            "X-Answer": encoded_answer,
            "Access-Control-Expose-Headers": "X-Question, X-Answer"
        }
    )
