import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./appSettings";

export type AutoBlurMode = "off" | "recording" | "always";

export function isPrivacyShieldArmed(st: AppSettings): boolean {
  return st.annotationAutoBlurWhatsApp !== "off" || st.annotationAutoBlurText !== "off";
}

export function isPrivacyShieldActiveNow(st: AppSettings, isRecording: boolean): boolean {
  const active = (mode: AutoBlurMode) => mode === "always" || (mode === "recording" && isRecording);
  return active(st.annotationAutoBlurWhatsApp) || active(st.annotationAutoBlurText);
}

export function privacyShieldSummary(st: AppSettings): string {
  const parts: string[] = [];
  if (st.annotationAutoBlurWhatsApp !== "off") parts.push("WhatsApp");
  if (st.annotationAutoBlurText !== "off") parts.push("Sensitive text");
  return parts.length > 0 ? parts.join(" · ") : "Off";
}

export function buildScreenBlurConfig(st: AppSettings, isRecording: boolean) {
  const active = (mode: AutoBlurMode) => mode === "always" || (mode === "recording" && isRecording);
  return {
    strength: st.annotationBlurStrength,
    autoWhatsapp: active(st.annotationAutoBlurWhatsApp),
    whatsappParts: st.annotationBlurWhatsAppParts,
    autoText: active(st.annotationAutoBlurText),
    textRules: {
      ...st.annotationBlurTextRules,
      keywords: st.annotationBlurKeywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    },
  };
}

export function syncScreenBlurConfig(st: AppSettings, isRecording: boolean): Promise<void> {
  return invoke("screen_blur_configure", {
    config: buildScreenBlurConfig(st, isRecording),
  })
    .then(() => undefined)
    .catch((err) => {
      console.error("Screen blur config:", err);
    });
}
