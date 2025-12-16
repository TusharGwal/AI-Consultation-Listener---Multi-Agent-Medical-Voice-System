import React from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import ConsultationListenerVoice from "./pages/ConsultationListenerVoice";

const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        {/* Main Consultation Listener Route */}
        <Route path="/" element={<ConsultationListenerVoice />} />
        
        {/* Redirect any unknown routes to home */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
};

export default App;
