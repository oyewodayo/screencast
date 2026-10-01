import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import './index.css'
import { ThemeProvider } from "./contexts/ThemeContext";
import { startStallMonitor } from "./utils/stallMonitor";
// import "./App.css";

startStallMonitor();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
