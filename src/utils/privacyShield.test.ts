import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./appSettings";
import {
  buildScreenBlurConfig,
  isPrivacyShieldActiveNow,
  isPrivacyShieldArmed,
  privacyShieldSummary,
} from "./privacyShield";

describe("privacyShield helpers", () => {
  it("reports armed state and summary for WhatsApp and sensitive text rules", () => {
    expect(isPrivacyShieldArmed(DEFAULT_SETTINGS)).toBe(true);
    expect(privacyShieldSummary(DEFAULT_SETTINGS)).toBe("WhatsApp · Sensitive text");

    const onlyWa = { ...DEFAULT_SETTINGS, annotationAutoBlurText: "off" as const };
    expect(isPrivacyShieldArmed(onlyWa)).toBe(true);
    expect(privacyShieldSummary(onlyWa)).toBe("WhatsApp");

    const offAll = {
      ...DEFAULT_SETTINGS,
      annotationAutoBlurWhatsApp: "off" as const,
      annotationAutoBlurText: "off" as const,
    };
    expect(isPrivacyShieldArmed(offAll)).toBe(false);
    expect(privacyShieldSummary(offAll)).toBe("Off");
  });

  it("activates 'recording' rules only while recording and 'always' rules anytime", () => {
    expect(isPrivacyShieldActiveNow(DEFAULT_SETTINGS, false)).toBe(false);
    expect(isPrivacyShieldActiveNow(DEFAULT_SETTINGS, true)).toBe(true);

    const alwaysWa = { ...DEFAULT_SETTINGS, annotationAutoBlurWhatsApp: "always" as const };
    expect(isPrivacyShieldActiveNow(alwaysWa, false)).toBe(true);
  });

  it("builds trimmed keyword list and active flags in screen blur config", () => {
    const st = {
      ...DEFAULT_SETTINGS,
      annotationBlurStrength: 75,
      annotationAutoBlurWhatsApp: "always" as const,
      annotationAutoBlurText: "recording" as const,
      annotationBlurKeywords: " Acme Corp , , secret-proj ",
    };
    const idleCfg = buildScreenBlurConfig(st, false);
    expect(idleCfg.strength).toBe(75);
    expect(idleCfg.autoWhatsapp).toBe(true);
    expect(idleCfg.autoText).toBe(false);
    expect(idleCfg.textRules.keywords).toEqual(["Acme Corp", "secret-proj"]);

    const recCfg = buildScreenBlurConfig(st, true);
    expect(recCfg.autoWhatsapp).toBe(true);
    expect(recCfg.autoText).toBe(true);
  });
});
