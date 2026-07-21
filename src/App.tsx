
import RecordingOverlayWindow from "./components/RecordingOverlayWindow";
import ScreenshotOverlayWindow from "./components/ScreenshotOverlayWindow";
import AnnotationOverlayWindow from "./components/AnnotationOverlayWindow";
import Dashboard from "./pages/Dashboard";
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Dashboard />} />

        <Route path="/recording-overlay" element={<RecordingOverlayWindow />} />
        <Route path="/screenshot-overlay" element={<ScreenshotOverlayWindow />} />
        <Route path="/annotation-overlay" element={<AnnotationOverlayWindow />} />
        {/* <Route path="/file-modal" element={<FileModal />} /> */}
        {/* <Route path="/settings" element={} /> */}
      </Routes>
    </Router>
  );
}

export default App;
