// contexts/ThemeContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { AppSettings, loadSettings, saveSettings } from "../utils/appSettings";

export type ThemePreference = AppSettings["theme"];
export type ResolvedTheme = "light" | "dark";

const prefersDarkQuery = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: dark)");

const resolveTheme = (pref: ThemePreference): ResolvedTheme =>
  pref === "system" ? (prefersDarkQuery().matches ? "dark" : "light") : pref;

// Applies the resolved theme to the document root. Exported standalone (not just via the
// provider below) so windows outside the main React tree — the completed-recording popup has
// its own separate HTML entry point/render root, see completed_recording.tsx — can sync to the
// same preference without needing to mount a ThemeProvider of their own.
export function applyThemeClass(pref: ThemePreference): void {
  const resolved = resolveTheme(pref);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

// One-shot setup for those standalone windows: applies the persisted preference immediately and
// keeps it synced if it's "system" and the OS preference changes while the window is open.
export function initTheme(): () => void {
  const pref = loadSettings().theme;
  applyThemeClass(pref);
  if (pref !== "system") return () => {};
  const mql = prefersDarkQuery();
  const handleChange = (): void => applyThemeClass("system");
  mql.addEventListener("change", handleChange);
  return () => mql.removeEventListener("change", handleChange);
}

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemePreference>(() => loadSettings().theme);

  useEffect(() => {
    applyThemeClass(theme);
    if (theme !== "system") return;
    const mql = prefersDarkQuery();
    const handleChange = (): void => applyThemeClass("system");
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [theme]);

  // Applies (and persists) immediately, independent of any Save/Cancel flow elsewhere — matches
  // how a theme toggle is expected to behave everywhere else (System Settings, browsers, etc).
  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    saveSettings({ ...loadSettings(), theme: next });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme: resolveTheme(theme), setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
