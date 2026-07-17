// src/modal.js
import React, { useState } from 'react';
import ReactDOM from "react-dom/client";
import FileModal from "../../../src/components/Modals/FileModal";

const CompletedRecordingApp = () => {
  const [filePath, setFilePath] = useState<string | null>(null);
  return <FileModal filePath={filePath ?? ''} setFilePath={setFilePath} />;
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <CompletedRecordingApp />
    </React.StrictMode>,
  );
