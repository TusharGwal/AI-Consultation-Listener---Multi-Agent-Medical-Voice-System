import React, { useEffect, useRef, useState } from "react";
import { sendConsultationAudio, fetchConsultationSummary, askConsultationQuestion, sendConsultationQAVoice } from "../api/consultationApi";

type Tab = "transcript" | "doctor" | "patient" | "qa";

interface QAItem {
  question: string;
  answer: string;
}

const ConsultationListenerVoice: React.FC = () => {
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [consultationId, setConsultationId] = useState<string | undefined>(undefined);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);
  
  // Data Views
  const [doctorView, setDoctorView] = useState("");
  const [patientView, setPatientView] = useState("");
  const [transcript, setTranscript] = useState("");
  
  // UI State
  const [activeTab, setActiveTab] = useState<Tab>("transcript");
  const [log, setLog] = useState<string[]>([]);
  
  // QA State
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [qaHistory, setQaHistory] = useState<QAItem[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Poll summaries every second when we have a consultationId
  useEffect(() => {
    if (!consultationId || consultationId === "demo-consultation") return;
    const interval = setInterval(async () => {
      try {
        const data = await fetchConsultationSummary(consultationId);
        setDoctorView(data.doctor_view || "");
        setPatientView(data.patient_view || "");
        setTranscript(data.raw_transcript || "");
      } catch (err) {
        // ignore if not ready
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [consultationId]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      chunksRef.current = [];
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/wav" });
        try {
            // Pass true to trigger summary on stop
            const result = await sendConsultationAudio(blob, sessionId, true);
            setSessionId(result.sessionId);
            setConsultationId(result.consultationId);
            setLog((prev) => [
                ...prev,
                `[Gateway] Sent audio chunk. consultationId=${result.consultationId}`,
                `[Gateway] Triggered summary generation.`
            ]);

            // play reply
            const audio = new Audio(result.audioUrl);
            audio.play();
        } catch (e) {
            console.error("Error sending audio", e);
            setLog((prev) => [...prev, `[Error] Failed to send audio: ${e}`]);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
      setLog((prev) => [...prev, "[Mic] Recording started..."]);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setLog((prev) => [...prev, "[Error] Could not access microphone."]);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        setLog((prev) => [...prev, "[Mic] Recording stopped. Sending..."]);
    }
  };

  const handleAskQuestion = async () => {
    if (!consultationId || !question.trim()) return;
    setIsAsking(true);
    try {
        const res = await askConsultationQuestion(consultationId, question);
        setQaHistory(prev => [...prev, { question, answer: res.answer }]);
        setQuestion(""); // Clear input
        setLog((prev) => [...prev, `[QA] Asked: ${question}`]);
    } catch (e) {
        console.error("QA Error", e);
        setLog((prev) => [...prev, `[QA] Error: ${e}`]);
    } finally {
        setIsAsking(false);
    }
  };

  // QA Voice Logic
  const [isQaRecording, setIsQaRecording] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [vadStatus, setVadStatus] = useState("Listening..."); // Visual status
  const [volumeDebug, setVolumeDebug] = useState(0); // Visual volume level
  const isLiveModeRef = useRef(false); 

  const qaMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const qaChunksRef = useRef<Blob[]>([]);
  const qaStreamCreatedRef = useRef<boolean>(false); // Track if we created the stream or borrowed it
  
  // VAD Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const speechDetectedRef = useRef<boolean>(false);
  const animationFrameRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);

  const startQaRecording = async (autoStart = false) => {
    console.log("startQaRecording called", { autoStart, isLiveMode: isLiveModeRef.current });
    if (!consultationId) return;
    
    if (autoStart && !isLiveModeRef.current) return;

    try {
      let stream: MediaStream;

      // Reuse existing stream if recording is active to avoid conflict
      const canReuseStream = isRecordingRef.current && mediaRecorderRef.current && mediaRecorderRef.current.stream.active;
      console.log("Stream Reuse Check:", { 
          isRecording: isRecordingRef.current, 
          hasMediaRecorder: !!mediaRecorderRef.current, 
          streamActive: mediaRecorderRef.current?.stream?.active 
      });

      if (canReuseStream && mediaRecorderRef.current) {
          console.log("Reusing existing consultation stream for QA");
          stream = mediaRecorderRef.current.stream;
          qaStreamCreatedRef.current = false;
      } else {
          console.log("Requesting new stream for QA");
          // Disable processing to get raw audio if possible, might help with VAD
          stream = await navigator.mediaDevices.getUserMedia({ 
              audio: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false
              } 
          });
          qaStreamCreatedRef.current = true;
      }

      const mediaRecorder = new MediaRecorder(stream);
      qaChunksRef.current = [];
      qaMediaRecorderRef.current = mediaRecorder;
      
      setVadStatus("Listening...");

      // VAD Setup
      if (autoStart) {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        console.log("AudioContext State:", audioContext.state);
        
        const analyser = audioContext.createAnalyser();
        
        // Log track info
        stream.getTracks().forEach(t => console.log(`Track: ${t.kind}, Enabled: ${t.enabled}, Muted: ${t.muted}, State: ${t.readyState}`));

        // Use stream directly instead of cloning to ensure data flow
        const source = audioContext.createMediaStreamSource(stream);
        
        // HACK: Connect to destination via zero-gain to force browser to process audio
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0.0; 
        
        source.connect(analyser);
        analyser.connect(gainNode);
        gainNode.connect(audioContext.destination);

        analyser.fftSize = 2048; // Increased for time domain
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        speechDetectedRef.current = false;
        frameCountRef.current = 0;

        const checkVolume = () => {
            // Use float data for better precision
            analyser.getFloatTimeDomainData(dataArray);
            
            // Calculate RMS (Root Mean Square)
            let sumSquares = 0;
            for (let i = 0; i < bufferLength; i++) {
                const sample = dataArray[i]; // already centered around 0
                sumSquares += sample * sample;
            }
            const rms = Math.sqrt(sumSquares / bufferLength);
            const average = rms * 1000; // scale to a readable integer-ish range

            // Update debug volume every 10 frames (~6 times/sec)
            frameCountRef.current++;
            if (frameCountRef.current % 10 === 0) {
                setVolumeDebug(Math.round(average));
                if (average === 0 && frameCountRef.current % 100 === 0) {
                    console.warn("VAD Warning: Volume is 0. AudioContext:", audioContext.state);
                    console.log("Raw Data Sample (float):", Array.from(dataArray.slice(0, 8)));
                }
            }

            // Thresholds (scaled because we multiplied by 1000)
            const SPEECH_THRESHOLD = 1; // very sensitive now
            const SILENCE_DURATION = 2000; 

            if (average > SPEECH_THRESHOLD) {
                if (!speechDetectedRef.current) {
                    speechDetectedRef.current = true;
                    setVadStatus("Speech Detected!");
                    // setLog((prev) => [...prev, "[VAD] Speech detected."]);
                }
                if (silenceTimerRef.current) {
                    clearTimeout(silenceTimerRef.current);
                    silenceTimerRef.current = null;
                }
            } else if (speechDetectedRef.current) {
                // We have spoken, now it's quiet
                if (!silenceTimerRef.current) {
                    silenceTimerRef.current = window.setTimeout(() => {
                        stopQaRecording(true); // Auto-stop and send
                    }, SILENCE_DURATION);
                }
            } else {
                // Not speaking yet, and haven't spoken yet.
                // Just waiting.
            }

            // Keep sampling while live mode is on, even if recorder glitches
            if (isLiveModeRef.current) {
                animationFrameRef.current = requestAnimationFrame(checkVolume);
            }
        };
        checkVolume();
      }

      mediaRecorder.ondataavailable = (e) => {
        qaChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        // Cleanup VAD
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        if (audioContextRef.current) audioContextRef.current.close();

        const blob = new Blob(qaChunksRef.current, { type: "audio/wav" });
        
        // Only send if we actually detected speech or if it was manual
        if (autoStart && !speechDetectedRef.current) {
             if (isLiveModeRef.current) {
                 setVadStatus("No speech detected, restarting...");
                 // Use a slightly longer timeout to avoid rapid loops if something is wrong
                 setTimeout(() => startQaRecording(true), 1000);
             }
             return;
        }

        setIsAsking(true);
        setVadStatus("Processing...");
        try {
            const result = await sendConsultationQAVoice(consultationId, blob);
            setQaHistory(prev => [...prev, { question: result.question, answer: result.answer }]);
            setLog((prev) => [...prev, `[QA Voice] Asked: ${result.question}`]);
            setLog((prev) => [...prev, `[QA Voice] Answer: ${result.answer}`]);
            
            setVadStatus("Speaking...");
            // Play audio answer
            console.log("Playing audio response...", result.audioUrl);
            const audio = new Audio(result.audioUrl);
            
            try {
                await audio.play();
                setLog((prev) => [...prev, `[QA Voice] Playing audio...`]);
            } catch (playErr) {
                console.error("Audio play error", playErr);
                setLog((prev) => [...prev, `[QA Voice] Audio play error: ${playErr}`]);
            }

            audio.onended = () => {
                setLog((prev) => [...prev, `[QA Voice] Audio finished. Resuming listening...`]);
                if (isLiveModeRef.current) {
                    startQaRecording(true);
                }
            };
        } catch (e) {
            console.error("QA Voice Error", e);
            setLog((prev) => [...prev, `[QA Voice] Error: ${e}`]);
            // If error, try to resume anyway?
            if (isLiveModeRef.current) {
                 setTimeout(() => startQaRecording(true), 2000);
            }
        } finally {
            setIsAsking(false);
        }
      };

      mediaRecorder.start();
      setIsQaRecording(true);
      if (autoStart) {
          setIsLiveMode(true);
          isLiveModeRef.current = true;
      }
    } catch (err) {
      console.error("Error accessing microphone for QA:", err);
    }
  };

  const stopQaRecording = (autoSend = false) => {
    if (qaMediaRecorderRef.current && qaMediaRecorderRef.current.state !== "inactive") {
        qaMediaRecorderRef.current.stop();
        
        // Only stop tracks if we created the stream specifically for QA
        if (qaStreamCreatedRef.current) {
            console.log("Stopping QA-specific stream tracks");
            qaMediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
        } else {
            console.log("Leaving shared consultation stream active");
        }

        setIsQaRecording(false);
        if (!autoSend) {
            setIsLiveMode(false); // Manual stop kills live mode
            isLiveModeRef.current = false;
        }
    }
  };
  // Tab Button Component
  const TabButton = ({ id, label }: { id: Tab; label: string }) => (
    <button
      onClick={() => setActiveTab(id)}
      style={{
        padding: "10px 20px",
        cursor: "pointer",
        backgroundColor: activeTab === id ? "#3498db" : "#ecf0f1",
        color: activeTab === id ? "white" : "#2c3e50",
        border: "none",
        borderRadius: "5px 5px 0 0",
        fontWeight: activeTab === id ? "bold" : "normal",
        marginRight: "5px"
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", padding: "1rem", gap: "1rem", fontFamily: "sans-serif", backgroundColor: "#f5f6fa" }}>
      {/* Left Panel: Controls & Log */}
      <div style={{ width: "300px", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div style={{ background: "white", padding: "1rem", borderRadius: "8px", boxShadow: "0 2px 5px rgba(0,0,0,0.1)" }}>
            <h1 style={{ fontSize: "1.2rem", margin: "0 0 1rem 0" }}>Consultation Listener</h1>
            {consultationId && <div style={{fontSize: "0.8rem", color: "green", marginBottom: "0.5rem"}}>Session Active: {consultationId.slice(0,8)}...</div>}
            <p style={{ fontSize: "0.9rem", color: "#666" }}>
            Roleplay a doctor–patient visit. 
            <br/>
            <strong>Click "Stop & Send" to summarize.</strong>
            </p>

            <button 
                onClick={isRecording ? stopRecording : startRecording}
                style={{
                    width: "100%",
                    padding: "12px",
                    fontSize: "16px",
                    backgroundColor: isRecording ? "#e74c3c" : "#2ecc71",
                    color: "white",
                    border: "none",
                    borderRadius: "5px",
                    cursor: "pointer",
                    fontWeight: "bold"
                }}
            >
            {isRecording ? "Stop & Send" : "Start Recording"}
            </button>
        </div>

        <div style={{ flex: 1, background: "white", padding: "1rem", borderRadius: "8px", boxShadow: "0 2px 5px rgba(0,0,0,0.1)", display: "flex", flexDirection: "column" }}>
          <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>System Log</h3>
          <pre style={{ 
              background: "#2c3e50", 
              color: "#2ecc71", 
              padding: "0.5rem", 
              flex: 1, 
              overflow: "auto", 
              borderRadius: "5px",
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap"
          }}>
            {log.join("\n")}
          </pre>
        </div>
      </div>

      {/* Right Panel: Tabs & Content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "white", borderRadius: "8px", boxShadow: "0 2px 5px rgba(0,0,0,0.1)", overflow: "hidden" }}>
        
        {/* Tabs Header */}
        <div style={{ display: "flex", borderBottom: "1px solid #ddd", padding: "1rem 1rem 0 1rem", background: "#f8f9fa" }}>
            <TabButton id="transcript" label="Transcript" />
            <TabButton id="doctor" label="Doctor Notes" />
            <TabButton id="patient" label="Patient Summary" />
            <TabButton id="qa" label="Q&A" />
        </div>

        {/* Tab Content */}
        <div style={{ flex: 1, padding: "1.5rem", overflow: "auto" }}>
            
            {activeTab === "transcript" && (
                <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                    <h2 style={{ marginTop: 0 }}>Live Transcript</h2>
                    <textarea
                        readOnly
                        value={transcript}
                        style={{ 
                            flex: 1, 
                            width: "100%", 
                            resize: "none", 
                            padding: "15px", 
                            borderRadius: "5px", 
                            border: "1px solid #ddd",
                            fontFamily: "monospace",
                            fontSize: "14px",
                            lineHeight: "1.5"
                        }}
                        placeholder="Transcript will appear here as you speak..."
                    />
                </div>
            )}

            {activeTab === "doctor" && (
                <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                    <h2 style={{ marginTop: 0 }}>Doctor Notes (SOAP)</h2>
                    <textarea
                        readOnly
                        value={doctorView}
                        style={{ 
                            flex: 1, 
                            width: "100%", 
                            resize: "none", 
                            padding: "15px", 
                            borderRadius: "5px", 
                            border: "1px solid #ddd",
                            fontFamily: "sans-serif",
                            fontSize: "15px",
                            lineHeight: "1.6"
                        }}
                        placeholder="Structured clinical notes will appear here..."
                    />
                </div>
            )}

            {activeTab === "patient" && (
                <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                    <h2 style={{ marginTop: 0 }}>Patient Summary</h2>
                    <textarea
                        readOnly
                        value={patientView}
                        style={{ 
                            flex: 1, 
                            width: "100%", 
                            resize: "none", 
                            padding: "15px", 
                            borderRadius: "5px", 
                            border: "1px solid #ddd",
                            fontFamily: "sans-serif",
                            fontSize: "15px",
                            lineHeight: "1.6"
                        }}
                        placeholder="Patient-friendly summary will appear here..."
                    />
                </div>
            )}

            {activeTab === "qa" && (
                <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                    <h2 style={{ marginTop: 0 }}>Ask Questions</h2>
                    
                    {/* Chat History */}
                    <div style={{ flex: 1, overflowY: "auto", marginBottom: "1rem", border: "1px solid #eee", borderRadius: "5px", padding: "1rem" }}>
                        {qaHistory.length === 0 ? (
                            <p style={{ color: "#999", textAlign: "center", marginTop: "2rem" }}>
                                Ask questions about the consultation here.
                            </p>
                        ) : (
                            qaHistory.map((item, idx) => (
                                <div key={idx} style={{ marginBottom: "1.5rem" }}>
                                    <div style={{ fontWeight: "bold", color: "#2c3e50", marginBottom: "0.25rem" }}>Q: {item.question}</div>
                                    <div style={{ background: "#f0f8ff", padding: "10px", borderRadius: "5px", color: "#34495e" }}>A: {item.answer}</div>
                                </div>
                            ))
                        )}
                    </div>

                    {/* Input Area */}
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <button
                            onClick={() => {
                                if (isLiveMode) {
                                    stopQaRecording(false);
                                } else {
                                    isLiveModeRef.current = true;
                                    setIsLiveMode(true);
                                    startQaRecording(true);
                                }
                            }}
                            disabled={!consultationId || isAsking}
                            style={{
                                padding: "0 15px",
                                cursor: "pointer",
                                backgroundColor: isLiveMode ? "#e74c3c" : "#9b59b6",
                                color: "white",
                                border: "none",
                                borderRadius: "4px",
                                fontWeight: "bold",
                                minWidth: "120px",
                                height: "44px"
                            }}
                            title="Toggle Live Voice Mode"
                        >
                            {isLiveMode ? "Stop Live" : "Start Live QA"}
                        </button>
                        
                        {isLiveMode && (
                            <div style={{ 
                                padding: "0 10px", 
                                color: vadStatus === "Speech Detected!" ? "#2ecc71" : "#7f8c8d",
                                fontWeight: "bold",
                                fontSize: "0.9rem",
                                minWidth: "150px"
                            }}>
                                {vadStatus} (Vol: {volumeDebug})
                            </div>
                        )}

                        <input 
                            type="text" 
                            value={question}
                            onChange={(e) => setQuestion(e.target.value)}
                            placeholder="e.g., What medication was prescribed?"
                            style={{ flex: 1, padding: "12px", borderRadius: "4px", border: "1px solid #ccc", fontSize: "16px" }}
                            onKeyDown={(e) => e.key === 'Enter' && handleAskQuestion()}
                            disabled={!consultationId}
                        />
                        <button 
                            onClick={handleAskQuestion} 
                            disabled={isAsking || !consultationId}
                            style={{ 
                                padding: "0 20px", 
                                cursor: "pointer",
                                backgroundColor: isAsking || !consultationId ? "#bdc3c7" : "#3498db",
                                color: "white",
                                border: "none",
                                borderRadius: "4px",
                                fontWeight: "bold"
                            }}
                        >
                            {isAsking ? "..." : "Ask"}
                        </button>
                    </div>
                    {!consultationId && (
                        <p style={{ fontSize: "0.8rem", color: "#e74c3c", marginTop: "0.5rem" }}>
                            * Start a consultation first to ask questions.
                        </p>
                    )}
                </div>
            )}

        </div>
      </div>
    </div>
  );
};

export default ConsultationListenerVoice;
