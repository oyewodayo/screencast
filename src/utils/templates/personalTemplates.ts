// utils/templates/personalTemplates.ts
import type { DocTemplate } from "./types";
import { RESUME_VARIANTS } from "./resumeTemplates";
import { FONTS, p, run } from "./templateHtml";

// The family entry: picking it opens the style picker over RESUME_VARIANTS. Its own html is the
// preview shown on the card (the software-engineer style).
const resume: DocTemplate = {
  ...RESUME_VARIANTS[0],
  id: "resume",
  name: "Resume / CV",
  description: `${RESUME_VARIANTS.length} styles by profession`,
  group: undefined,
  variants: RESUME_VARIANTS,
};

const coverLetter: DocTemplate = {
  id: "cover-letter",
  name: "Cover letter",
  description: "Tailored job application letter",
  category: "Personal",
  docTitle: () => "Cover letter – Sahel Payments",
  layout: { body: { fontFamily: FONTS.sourceSerif, fontSize: 11, lineHeight: 1.45, blockSpacing: 9, paragraphIndent: 0 } },
  html: (today) =>
    [
      p(run({ size: 20, color: "#1d4ed8", font: FONTS.inter }, "<strong>Daniel Mensah</strong>")),
      p(run({ size: 9.5, color: "#475569", font: FONTS.inter }, "Accra, Ghana &nbsp;·&nbsp; daniel.mensah@example.com &nbsp;·&nbsp; +233 20 555 0187 &nbsp;·&nbsp; github.com/dmensah")),
      p("<br>"),
      p(today),
      p("Ms. Abena Owusu<br>Director of Engineering<br>Sahel Payments<br>14 Independence Avenue, Accra"),
      p("<strong>Re: Staff Software Engineer, Payments Platform (Ref. ENG-2026-114)</strong>"),
      p("Dear Ms. Owusu,"),
      p(
        "I am writing to apply for the Staff Software Engineer role on the Payments Platform team. At Lumen Pay I have led the re-architecture of card authorisation from a monolith into event-driven Go services, raising throughput fifteen-fold and cutting p99 latency from 820 ms to 140 ms. I would welcome the chance to take that work further as Sahel Payments expands into three new markets next year."
      ),
      p(
        "The posting emphasises reliability at scale and growing other engineers. Both have defined my recent work. I designed the idempotent retry and reconciliation system that reduced settlement mismatches by 97%, and I introduced the RFC process now used by nine teams at Lumen Pay. I also mentor five engineers, two of whom have since been promoted to senior roles."
      ),
      p(
        "What draws me to this role is the chance to shape the platform’s multi-currency ledger from first principles. I recently released <em>ledgerkit</em>, an open-source double-entry ledger library for Go, and spoke at GopherCon Africa on exactly-once payments, so the problem space is one I care about deeply."
      ),
      p("I would be glad to discuss how I could contribute. Thank you for your time and consideration."),
      p("Yours sincerely,"),
      p("<br>"),
      p("<strong>Daniel Mensah</strong>"),
    ].join(""),
};

export const PERSONAL_TEMPLATES: DocTemplate[] = [resume, coverLetter];
