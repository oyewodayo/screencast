
import RecordingOverlayWindow from "./components/RecordingOverlayWindow";
import Dashboard from "./pages/Dashboard";
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Dashboard />} />

        <Route path="/recording-overlay" element={<RecordingOverlayWindow />} /> 
        {/* <Route path="/file-modal" element={<FileModal />} /> */}
        {/* <Route path="/settings" element={} /> */}
      </Routes>
    </Router>
  );
}

export default App;
