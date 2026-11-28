import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandLoader, BrandSpinner, BriefcastBeamLogo } from "./BrandLoader";

describe("BrandLoader", () => {
  it("renders with default props as a clean SVG vector without blurry filters or rectangular box", () => {
    const html = renderToStaticMarkup(React.createElement(BrandLoader));
    expect(html).toContain("briefcast-beacon");
    expect(html).toContain("briefcast-screen-frame");
    expect(html).toContain("briefcast-wave-1");
    expect(html).toContain("Loading");
    expect(html).not.toContain("feGaussianBlur");
    expect(html).not.toContain("purple");
  });

  it("renders BriefcastBeamLogo with clean SVG paths", () => {
    const html = renderToStaticMarkup(React.createElement(BriefcastBeamLogo, { size: "md" }));
    expect(html).toContain("<svg");
    expect(html).toContain("briefcast-wave-1");
    expect(html).toContain("briefcast-wave-2");
    expect(html).toContain("briefcast-wave-3");
    expect(html).toContain("briefcast-screen-frame");
  });

  it("renders custom message and description cleanly", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrandLoader, {
        message: "Loading document",
        description: "Setting up your editor",
        size: "md",
      })
    );
    expect(html).toContain("Loading document");
    expect(html).toContain("Setting up your editor");
  });

  it("renders progress percentage when provided", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrandLoader, {
        message: "Preparing video",
        progress: 75,
      })
    );
    expect(html).toContain("75%");
    expect(html).toContain("width:75%");
  });

  it("renders inline variant correctly", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrandLoader, {
        variant: "inline",
        message: "Saving changes",
      })
    );
    expect(html).toContain("Saving changes");
    expect(html).toContain("inline-flex");
  });

  it("renders BrandSpinner with custom size", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrandSpinner, { size: "sm" })
    );
    expect(html).toContain("width:32px");
  });
});
