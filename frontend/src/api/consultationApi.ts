// frontend/src/api/consultationApi.ts

export async function sendConsultationAudio(
  audioBlob: Blob,
  sessionId?: string,
  triggerSummary: boolean = false
): Promise<{ audioUrl: string; sessionId: string; consultationId: string }> {
  const formData = new FormData();
  formData.append("audio", audioBlob, "audio.wav");
  if (sessionId) formData.append("session_id", sessionId);
  if (triggerSummary) formData.append("trigger_summary", "true");

  // Use relative path, assuming proxy or same origin
  // If running locally with Vite proxy, this should work.
  // If not, might need full URL from env.
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000";
  const res = await fetch(`${apiUrl}/consultation/voice`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to send audio");
  }

  const newSessionId = res.headers.get("X-Session-Id") || sessionId || "";
  const consultationId =
    res.headers.get("X-Consultation-Id") || "demo-consultation";

  const audioBlobReply = await res.blob();
  const audioUrl = URL.createObjectURL(audioBlobReply);

  return { audioUrl, sessionId: newSessionId, consultationId };
}

export async function fetchConsultationSummary(consultationId: string) {
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000";
  const res = await fetch(`${apiUrl}/consultation/${consultationId}/summary`);
  if (!res.ok) throw new Error("Failed to fetch summary");
  return res.json() as Promise<{
    doctor_view: string | null;
    patient_view: string | null;
    raw_transcript: string | null;
  }>;
}

export async function askConsultationQuestion(consultationId: string, question: string) {
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000";
  const formData = new FormData();
  formData.append("question", question);
  
  const res = await fetch(`${apiUrl}/consultation/${consultationId}/qa`, {
    method: "POST",
    body: formData,
  });
  
  if (!res.ok) throw new Error("Failed to ask question");
  return res.json() as Promise<{ answer: string }>;
}

export async function sendConsultationQAVoice(
  consultationId: string,
  audioBlob: Blob
): Promise<{ question: string; answer: string; audioUrl: string }> {
  const formData = new FormData();
  formData.append("audio", audioBlob, "audio.wav");

  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000";
  const res = await fetch(`${apiUrl}/consultation/${consultationId}/qa/voice`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) throw new Error("Failed to send voice question");

  const questionEncoded = res.headers.get("X-Question") || "";
  const answerEncoded = res.headers.get("X-Answer") || "";
  
  const question = decodeURIComponent(questionEncoded);
  const answer = decodeURIComponent(answerEncoded);

  const audioBlobReply = await res.blob();
  const audioUrl = URL.createObjectURL(audioBlobReply);

  return { question, answer, audioUrl };
}
