import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import './index.css'
import { ThemeProvider } from "./contexts/ThemeContext";
import { startCanvasLossMonitor, startStallMonitor } from "./utils/stallMonitor";
import { installGlobalErrorReporting } from "./utils/telemetry";
import { initSettings } from "./utils/appSettings";
// import "./App.css";

startStallMonitor();
startCanvasLossMonitor();
installGlobalErrorReporting();

// Settings live in a file owned by Rust; every component reads them synchronously from a cache,
// so the cache has to be filled before anything renders. initSettings never rejects.
void initSettings().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  );
});
