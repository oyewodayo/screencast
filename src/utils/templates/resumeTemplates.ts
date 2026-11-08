// utils/templates/resumeTemplates.ts
//
// The résumé / CV family behind the "Resume" template: one style per profession, each following
// that field's conventions (a one-page sidebar résumé for engineers, a multi-page academic CV with
// grants and publications, a physician's CV with licensure and board certification, a lawyer's
// with bar admissions and representative matters, ...). All people, employers and contact
// details are fictional.
//
// Every résumé is built from the same ResumeData shape by one of three layouts, so they share
// structure (and editing behaviour) while looking distinct: "classic" (left-aligned, ruled
// sections), "centered" (formal: medicine, law, academia) and "sidebar" (a shaded side column
// for contact, skills and education beside the experience).
import type { DocTemplate } from "./types";
import { FONTS, type RunStyle, h, hr, ol, p, run, table, ul } from "./templateHtml";

interface ResumeTheme {
  layout: "classic" | "centered" | "sidebar";
  body: string; // font stack
  heading: string; // font stack for the name and section titles
  accent: string;
  muted: string;
  size: number; // body pt
  // Sidebar layout only: the side column's fill, and whether it's dark (white text).
  sidebarBg?: string;
  sidebarDark?: boolean;
}

interface Entry {
  title: string;
  org: string;
  place?: string;
  dates: string;
  detail?: string;
  bullets?: string[];
}

type Section =
  | { title: string; kind: "text"; text: string }
  | { title: string; kind: "entries"; entries: Entry[] }
  | { title: string; kind: "bullets"; items: string[] }
  | { title: string; kind: "numbered"; items: string[] }
  | { title: string; kind: "pairs"; pairs: [string, string][] };

interface ResumeData {
  name: string;
  credentials?: string;
  headline: string;
  contact: string[];
  main: Section[];
  // Sidebar layout: these go in the side column. Other layouts append them after `main`.
  side?: Section[];
}

function renderer(t: ResumeTheme, dark = false) {
  const text: RunStyle = { font: t.body, size: t.size, color: dark ? "#ffffff" : undefined };
  const mutedStyle: RunStyle = { font: t.body, size: t.size - 1, color: dark ? "#cbd5e1" : t.muted };
  const body = (html: string) => run(text, html);
  const muted = (html: string) => run(mutedStyle, html);
  const centered = t.layout === "centered";

  const sectionTitle = (title: string) =>
    h(2, run({ font: t.heading, size: t.size + 1.5, color: dark ? "#ffffff" : t.accent }, title.toUpperCase()), {
      before: 10,
      after: 3,
      align: centered ? "center" : "left",
    }) + (t.layout === "classic" && !dark ? hr() : "");

  const entry = (e: Entry) =>
    [
      p(`${body(`<strong>${e.title}</strong>${e.org ? ` — ${e.org}` : ""}`)}<br>${muted(`${[e.place, e.dates].filter(Boolean).join(" · ")}`)}`, { before: 5 }),
      e.detail ? p(body(e.detail)) : "",
      e.bullets?.length ? ul(e.bullets.map(body)) : "",
    ].join("");

  const section = (s: Section): string => {
    const content = (() => {
      switch (s.kind) {
        case "text":
          return p(body(s.text));
        case "entries":
          return s.entries.map(entry).join("");
        case "bullets":
          return ul(s.items.map(body));
        case "numbered":
          return ol(s.items.map(body));
        case "pairs":
          return s.pairs.map(([k, v]) => p(`${body(`<strong>${k}</strong>`)}<br>${body(v)}`, { before: 3 })).join("");
      }
    })();
    return sectionTitle(s.title) + content;
  };

  return { body, muted, section };
}

function renderResume(t: ResumeTheme, d: ResumeData): string {
  const r = renderer(t);
  const name = run({ font: t.heading, size: 26, color: t.accent }, d.name) + (d.credentials ? run({ font: t.heading, size: 14, color: t.muted }, `, ${d.credentials}`) : "");

  if (t.layout === "sidebar") {
    const s = renderer(t, !!t.sidebarDark);
    const header =
      h(1, name, { after: 0 }) +
      p(run({ font: t.body, size: t.size + 2, color: t.muted }, d.headline), { after: 4 });
    const sideCol = [h(2, run({ font: t.heading, size: t.size + 1.5, color: t.sidebarDark ? "#ffffff" : t.accent }, "CONTACT"), { after: 3 }), ...d.contact.map((c) => p(s.body(c))), ...(d.side ?? []).map(s.section)].join("");
    const mainCol = d.main.map(r.section).join("");
    return (
      header +
      // 691px = the 7.2in text width left by the résumé's 0.65in side margins.
      table([[sideCol, mainCol]], { header: false, rules: "none", shade: (_row, col) => (col === 0 ? t.sidebarBg : undefined), widths: [230, 461] })
    );
  }

  const align = t.layout === "centered" ? "center" : "left";
  const header =
    h(1, name, { align, after: 0 }) +
    p(run({ font: t.body, size: t.size + 2, color: t.muted }, d.headline), { align, after: 2 }) +
    p(r.muted(d.contact.join(" &nbsp;·&nbsp; ")), { align, after: 4 }) +
    (t.layout === "centered" ? hr() : "");
  return header + [...d.main, ...(d.side ?? [])].map(r.section).join("");
}

const resumeTemplate = (
  id: string,
  name: string,
  description: string,
  group: string,
  theme: ResumeTheme,
  data: ResumeData,
  margins = { top: 0.6, right: 0.65, bottom: 0.6, left: 0.65 }
): DocTemplate => ({
  id: `resume-${id}`,
  name,
  description,
  group,
  category: "Personal",
  docTitle: () => `${data.name} – ${name}`,
  layout: { body: { fontFamily: theme.body, fontSize: theme.size, lineHeight: 1.35, blockSpacing: 2, paragraphIndent: 0 } },
  pageSetup: { margins },
  html: () => renderResume(theme, data),
});

// ---------------------------------------------------------------------------------------------

const softwareEngineer = resumeTemplate(
  "software-engineer",
  "Software engineer",
  "Modern sidebar résumé · impact-first bullets",
  "Technology",
  { layout: "sidebar", body: FONTS.inter, heading: FONTS.inter, accent: "#1d4ed8", muted: "#475569", size: 9.5, sidebarBg: "#eff6ff" },
  {
    name: "Daniel Mensah",
    headline: "Senior Software Engineer · Distributed systems & payments",
    contact: ["Accra, Ghana (open to remote)", "daniel.mensah@example.com", "+233 20 555 0187", "github.com/dmensah", "linkedin.com/in/daniel-mensah-dev"],
    main: [
      {
        title: "Profile",
        kind: "text",
        text: "Backend engineer with 8 years building high-throughput payment and logistics platforms in Go and TypeScript. Led the re-architecture of a card-processing pipeline from 300 to 4,500 transactions per second. Comfortable owning systems end to end, from design docs to on-call.",
      },
      {
        title: "Experience",
        kind: "entries",
        entries: [
          {
            title: "Senior Software Engineer",
            org: "Lumen Pay",
            place: "Accra / Remote",
            dates: "Mar 2022 – Present",
            bullets: [
              "Re-architected card authorisation into event-driven Go services on Kafka, raising throughput 15× and cutting p99 latency from 820 ms to 140 ms.",
              "Designed idempotent retry and ledger reconciliation that reduced settlement mismatches by 97% (≈ $1.2m/yr in manual ops).",
              "Mentored 5 engineers; introduced design reviews and an RFC process adopted across 9 teams.",
            ],
          },
          {
            title: "Software Engineer II",
            org: "Cobalt Logistics",
            place: "Lagos, Nigeria",
            dates: "Jun 2019 – Feb 2022",
            bullets: [
              "Built the real-time dispatch API (TypeScript, PostgreSQL, Redis) serving 2,300 vehicles and 150k deliveries per day.",
              "Cut cloud spend 31% by moving batch routing jobs to spot instances with checkpointing.",
            ],
          },
          {
            title: "Software Engineer",
            org: "Brightline Labs",
            place: "Accra, Ghana",
            dates: "Aug 2017 – May 2019",
            bullets: ["Shipped a React Native field-sales app used by 4,000 agents; 4.7★ rating across 12k reviews."],
          },
        ],
      },
      {
        title: "Selected projects",
        kind: "bullets",
        items: [
          "<strong>ledgerkit</strong> — open-source double-entry ledger library for Go (2.1k GitHub stars).",
          "<strong>Speaker</strong>, GopherCon Africa 2025: “Exactly-once payments without distributed transactions”.",
        ],
      },
    ],
    side: [
      {
        title: "Skills",
        kind: "pairs",
        pairs: [
          ["Languages", "Go, TypeScript, Python, SQL"],
          ["Infrastructure", "Kubernetes, Terraform, AWS, GCP"],
          ["Data", "PostgreSQL, Kafka, Redis, BigQuery"],
          ["Practices", "System design, observability, TDD, incident response"],
        ],
      },
      {
        title: "Education",
        kind: "entries",
        entries: [{ title: "BSc Computer Science", org: "", place: "Kwame Nkrumah Univ. of Science & Technology", dates: "2013 – 2017", detail: "First Class Honours" }],
      },
      { title: "Certifications", kind: "bullets", items: ["AWS Solutions Architect – Professional (2024)", "CKAD (2023)"] },
      { title: "Languages", kind: "bullets", items: ["English (native)", "Twi (native)", "French (B1)"] },
    ],
  }
);

const dataScientist = resumeTemplate(
  "data-scientist",
  "Data scientist",
  "Classic one-page · metrics and models",
  "Technology",
  { layout: "classic", body: FONTS.sourceSans, heading: FONTS.spaceGrotesk, accent: "#c2410c", muted: "#57534e", size: 10 },
  {
    name: "Priya Raman",
    headline: "Senior Data Scientist · Experimentation, causal inference & ML",
    contact: ["Bengaluru, India", "priya.raman@example.com", "+91 98 5550 2241", "linkedin.com/in/priyaraman-ds", "priyaraman.dev"],
    main: [
      {
        title: "Summary",
        kind: "text",
        text: "Data scientist with 7 years turning experimentation and ML into product decisions at consumer-scale companies. Built the A/B testing platform used for 400+ experiments a year and models worth $18m in annual incremental revenue.",
      },
      {
        title: "Experience",
        kind: "entries",
        entries: [
          {
            title: "Senior Data Scientist",
            org: "Kirana Commerce",
            place: "Bengaluru",
            dates: "2022 – Present",
            bullets: [
              "Built a CUPED-based experimentation platform that cut required sample sizes by 38% and made 400+ tests/year self-serve.",
              "Shipped a gradient-boosted reorder-propensity model (AUC 0.87) driving $11m incremental annual revenue.",
              "Led a causal-impact study of free-delivery thresholds that informed a pricing change worth $7m/yr.",
            ],
          },
          {
            title: "Data Scientist",
            org: "Monsoon Media",
            place: "Mumbai",
            dates: "2019 – 2022",
            bullets: [
              "Developed a two-tower recommendation model; +12% watch time in a 2-million-user A/B test.",
              "Automated weekly KPI reporting in dbt and Looker, saving the analytics team 20 hours/week.",
            ],
          },
          { title: "Analyst", org: "Ardent Consulting", place: "Chennai", dates: "2017 – 2019", bullets: ["Built churn models for 3 telecom clients; retention campaigns reduced churn 4.5 pts."] },
        ],
      },
      {
        title: "Skills",
        kind: "pairs",
        pairs: [
          ["Modelling", "Causal inference, Bayesian A/B testing, XGBoost, PyTorch, time-series forecasting"],
          ["Tools", "Python (pandas, scikit-learn, statsmodels), SQL, Spark, dbt, Airflow, Looker"],
        ],
      },
      {
        title: "Education",
        kind: "entries",
        entries: [
          { title: "MSc Statistics", org: "Indian Statistical Institute", place: "Kolkata", dates: "2015 – 2017" },
          { title: "BSc Mathematics", org: "St. Xavier’s College", place: "Mumbai", dates: "2012 – 2015" },
        ],
      },
      { title: "Publications & talks", kind: "bullets", items: ["“Variance reduction at scale”, PyData Bengaluru 2025.", "Co-author, “Heterogeneous treatment effects in marketplace pricing”, KDD Workshop on Causal ML, 2024."] },
    ],
  }
);

const productManager = resumeTemplate(
  "product-manager",
  "Product manager",
  "Classic · outcomes and launches",
  "Technology",
  { layout: "classic", body: FONTS.sourceSans, heading: FONTS.montserrat, accent: "#be123c", muted: "#57534e", size: 10 },
  {
    name: "Kemi Balogun",
    headline: "Senior Product Manager · Fintech & mobile growth",
    contact: ["Lagos, Nigeria", "kemi.balogun@example.com", "+234 803 555 0119", "linkedin.com/in/kemibalogun-pm"],
    main: [
      { title: "Summary", kind: "text", text: "Product manager with 6 years leading mobile products from discovery to scale. Grew a savings app from 40k to 1.3m monthly active users and launched products in 4 markets." },
      {
        title: "Experience",
        kind: "entries",
        entries: [
          {
            title: "Senior Product Manager, Growth",
            org: "Atlas Mobile",
            place: "Lagos",
            dates: "2023 – Present",
            bullets: [
              "Redesigned onboarding (5 → 3 screens) lifting completion +11.7 pts and Day-7 retention +1.3 pts.",
              "Launched referral programme: 210k new users in 6 months at 40% lower CAC than paid channels.",
              "Lead a squad of 9 (engineering, design, data); run quarterly OKR planning for the growth group.",
            ],
          },
          {
            title: "Product Manager",
            org: "Cowry Savings",
            place: "Lagos",
            dates: "2020 – 2023",
            bullets: ["Grew MAU from 40k to 1.3m; launched goal-based savings ($28m deposits in year one).", "Introduced a weekly customer-interview cadence (150+ interviews)."],
          },
          { title: "Associate Product Manager", org: "Brightline Labs", place: "Accra", dates: "2019 – 2020", bullets: ["Owned the agent-payments roadmap for 4,000 field agents."] },
        ],
      },
      { title: "Skills", kind: "bullets", items: ["Product discovery · experimentation · roadmapping · OKRs", "SQL, Amplitude, Mixpanel, Figma, Jira", "Stakeholder management across regulatory, finance and engineering"] },
      { title: "Education", kind: "entries", entries: [{ title: "MBA", org: "Lagos Business School", place: "Lagos", dates: "2018 – 2020" }, { title: "BSc Economics", org: "University of Ibadan", place: "Ibadan", dates: "2011 – 2015" }] },
    ],
  }
);

const graduate = resumeTemplate(
  "graduate",
  "Graduate / entry-level",
  "Education-first · internships and projects",
  "Early career",
  { layout: "sidebar", body: FONTS.poppins, heading: FONTS.poppins, accent: "#4338ca", muted: "#475569", size: 9, sidebarBg: "#eef2ff" },
  {
    name: "Liam Chen",
    headline: "Computer Science graduate · Machine learning & web development",
    contact: ["Toronto, Canada", "liam.chen@example.com", "+1 (416) 555 0136", "github.com/liamchen-dev", "liamchen.dev"],
    main: [
      { title: "Profile", kind: "text", text: "Recent Computer Science graduate (GPA 3.8/4.0) with two software internships and a published undergraduate research project in computer vision. Looking for a graduate software engineering role starting summer 2027." },
      {
        title: "Education",
        kind: "entries",
        entries: [
          {
            title: "BSc (Hons) Computer Science",
            org: "Lakeshore University",
            place: "Toronto",
            dates: "2022 – 2026",
            bullets: ["GPA 3.8 / 4.0 · Dean’s List (6 terms)", "Coursework: algorithms, distributed systems, machine learning, databases, HCI", "Thesis: “Lightweight crop-disease detection on mobile devices” (grade A+)"],
          },
        ],
      },
      {
        title: "Experience",
        kind: "entries",
        entries: [
          { title: "Software Engineering Intern", org: "Maple Health", place: "Toronto", dates: "May – Aug 2026", bullets: ["Built an appointment-reminder service in Python/FastAPI; reduced no-shows 14% in pilot clinics.", "Wrote 120+ unit tests, raising service coverage from 52% to 88%."] },
          { title: "Web Developer Intern", org: "Northern Lights Studio", place: "Remote", dates: "May – Aug 2025", bullets: ["Rebuilt a client marketing site in Next.js; Lighthouse performance score 61 → 97."] },
        ],
      },
      {
        title: "Projects",
        kind: "bullets",
        items: ["<strong>LeafScan</strong> — on-device plant-disease classifier (MobileNetV3, 94% accuracy); 3k downloads.", "<strong>StudyBuddy</strong> — real-time study-group matching app; won 1st place at HackLakeshore 2025."],
      },
      { title: "Leadership", kind: "bullets", items: ["President, Women & Allies in Computing society (2025–26): grew membership 60 → 210.", "Teaching assistant, Intro to Programming (2 terms, 180 students)."] },
    ],
    side: [
      { title: "Skills", kind: "pairs", pairs: [["Languages", "Python, TypeScript, Java, C++"], ["Frameworks", "React, Next.js, FastAPI, PyTorch"], ["Tools", "Git, Docker, PostgreSQL, AWS"]] },
      { title: "Awards", kind: "bullets", items: ["Undergraduate Research Award (2025)", "1st place, HackLakeshore (2025)"] },
      { title: "Languages", kind: "bullets", items: ["English (fluent)", "Mandarin (native)"] },
      { title: "Interests", kind: "bullets", items: ["Bouldering", "Film photography", "Chess (1850 rapid)"] },
    ],
  }
);

const researchScientist = resumeTemplate(
  "research-scientist",
  "Research scientist (industry)",
  "R&D résumé · publications and patents",
  "Research & academia",
  { layout: "classic", body: FONTS.plexSans, heading: FONTS.plexSerif, accent: "#6d28d9", muted: "#52525b", size: 10 },
  {
    name: "Tomás Alvarez",
    credentials: "PhD",
    headline: "Senior Research Scientist · Superconducting quantum hardware",
    contact: ["Zurich, Switzerland", "tomas.alvarez@example.com", "+41 44 555 0193", "scholar: Tomás Alvarez", "orcid.org/0000-0002-0000-0000"],
    main: [
      { title: "Research summary", kind: "text", text: "Experimental physicist with 9 years in superconducting qubit design and characterisation. Led device teams that achieved 99.92% two-qubit gate fidelity and 300 µs median T₁ across 127-qubit processors. 24 peer-reviewed papers (h-index 17) and 6 granted patents." },
      {
        title: "Experience",
        kind: "entries",
        entries: [
          {
            title: "Senior Research Scientist, Quantum Hardware",
            org: "Helvetia Quantum AG",
            place: "Zurich",
            dates: "2021 – Present",
            bullets: [
              "Lead a team of 7 developing tunable-coupler architectures; two-qubit CZ fidelity improved from 99.6% to 99.92%.",
              "Introduced a tantalum-on-sapphire process raising median T₁ from 110 µs to 300 µs.",
              "Principal investigator on a CHF 4.2m industry–academia consortium (3 universities).",
            ],
          },
          { title: "Postdoctoral Researcher", org: "Ardmore University, Centre for Correlated Matter", place: "Ardmore", dates: "2018 – 2021", bullets: ["Developed flux-qubit arrays for analogue quantum simulation of frustrated magnets; 6 papers incl. Nature Physics."] },
        ],
      },
      {
        title: "Selected publications",
        kind: "numbered",
        items: [
          "<strong>T. Alvarez</strong>, S. Keller, et al. “Tunable couplers for high-fidelity two-qubit gates at scale.” <em>PRX Quantum</em> 6, 020311 (2025).",
          "M. Iten, <strong>T. Alvarez</strong>, et al. “Materials losses in tantalum transmons.” <em>Applied Physics Letters</em> 124, 112601 (2024).",
          "<strong>T. Alvarez</strong>, I. Chukwu, H. Sato. “Programmable spin ice in a flux-qubit array.” <em>Nature Physics</em> 17, 1043 (2021).",
        ],
      },
      { title: "Patents", kind: "bullets", items: ["US 11,987,xxx — “Parametric coupler with suppressed ZZ crosstalk” (granted 2025).", "EP 4 112 xxx — “Low-loss substrate treatment for superconducting circuits” (granted 2024)."] },
      { title: "Technical skills", kind: "pairs", pairs: [["Experimental", "Dilution refrigerators, microwave measurement, cleanroom fabrication, cryo-CMOS"], ["Software", "Python (Qiskit, QCoDeS, NumPy), COMSOL, Sonnet, HFSS"]] },
      { title: "Education", kind: "entries", entries: [{ title: "PhD Physics", org: "ETH Zurich", place: "Zurich", dates: "2013 – 2018", detail: "Thesis: “Coherent control of flux qubits in strongly coupled arrays”" }, { title: "MSc Physics", org: "Universidad Autónoma de Madrid", place: "Madrid", dates: "2011 – 2013" }] },
    ],
  }
);

const academic = resumeTemplate(
  "academic-cv",
  "Academic CV",
  "Faculty CV · grants, publications, teaching, service",
  "Research & academia",
  { layout: "centered", body: FONTS.pagella, heading: FONTS.pagella, accent: "#1e3a8a", muted: "#44403c", size: 10.5 },
  {
    name: "Amara N. Okonkwo",
    credentials: "PhD, FInstP",
    headline: "Associate Professor of Physics · Institute for Quantum Matter, Halden University",
    contact: ["Halden 4021, Norway", "a.okonkwo@halden.example.edu", "+47 69 55 01 21", "okonkwo-lab.example.org", "ORCID 0000-0001-0000-0000"],
    main: [
      { title: "Research interests", kind: "text", text: "Frustrated quantum magnetism; emergent gauge theories; quantum simulation with programmable superconducting devices; tensor-network methods." },
      {
        title: "Academic appointments",
        kind: "entries",
        entries: [
          { title: "Associate Professor of Physics", org: "Halden University", place: "Norway", dates: "2021 – present" },
          { title: "Assistant Professor of Physics", org: "Halden University", place: "Norway", dates: "2017 – 2021" },
          { title: "Marie Skłodowska-Curie Fellow", org: "Ardmore University", place: "Ireland", dates: "2015 – 2017" },
          { title: "Postdoctoral Research Associate", org: "Lakeside Institute", place: "Canada", dates: "2013 – 2015" },
        ],
      },
      {
        title: "Education",
        kind: "entries",
        entries: [
          { title: "PhD in Theoretical Physics", org: "University of Cambridge", place: "UK", dates: "2013", detail: "Thesis: “Quantum fluctuations in frustrated Ising magnets”. Advisor: Prof. J. Whitmore." },
          { title: "BSc (First Class) Physics", org: "University of Nigeria, Nsukka", place: "Nigeria", dates: "2008" },
        ],
      },
      {
        title: "Grants and fellowships",
        kind: "bullets",
        items: [
          "<strong>ERC Consolidator Grant</strong> “GAUGESIM: Emergent gauge fields in programmable quantum matter”, €2.0m (PI), 2024–2029.",
          "<strong>Halden Research Council Frontier Grant</strong>, NOK 9.6m (PI), 2020–2024.",
          "<strong>Marie Skłodowska-Curie Individual Fellowship</strong>, €195k, 2015–2017.",
        ],
      },
      {
        title: "Selected publications",
        kind: "numbered",
        items: [
          "<strong>A. N. Okonkwo</strong>, J. Lindqvist, M.-L. Zhou, R. Ortega. “Order by disorder in a programmable quantum simulator.” <em>Physical Review X</em> 16, 031027 (2026).",
          "M.-L. Zhou, <strong>A. N. Okonkwo</strong>. “Tensor networks for pyrochlore magnets at 1,024 sites.” <em>Physical Review B</em> 111, 144402 (2025).",
          "<strong>A. N. Okonkwo</strong>, L. Brenner. “Emergent photons in quantum spin ice: a numerical perspective.” <em>Physical Review Letters</em> 130, 216701 (2023).",
          "<strong>A. N. Okonkwo</strong>. “Quantum order by disorder in Ising magnets.” <em>Annual Review of Condensed Matter Physics</em> 13, 211 (2022).",
        ],
      },
      { title: "Invited talks (selected)", kind: "bullets", items: ["APS March Meeting, invited symposium, Minneapolis (2026).", "Gordon Research Conference on Correlated Electron Systems (2024).", "Les Houches Summer School, lecturer (2023)."] },
      { title: "Teaching", kind: "bullets", items: ["PHYS 412 Quantum Mechanics II (graduate), 2019 – present — student rating 4.8/5.", "PHYS 210 Statistical Physics (undergraduate), 2017 – 2021.", "Faculty Teaching Excellence Award, 2022."] },
      { title: "Supervision", kind: "bullets", items: ["PhD students: 6 graduated, 4 current. Postdocs: 5 (3 now faculty).", "MSc theses supervised: 14."] },
      { title: "Service", kind: "bullets", items: ["Editorial Board, <em>Physical Review B</em> (2023 – present).", "Panel member, ERC Starting Grants PE3 (2025).", "Chair, Department Equality & Diversity Committee (2021 – 2024)."] },
      { title: "Honours", kind: "bullets", items: ["Fellow of the Institute of Physics (2024).", "Halden Young Researcher Prize (2019)."] },
      { title: "Referees", kind: "text", text: "Available on request." },
    ],
  },
  { top: 0.8, right: 0.9, bottom: 0.8, left: 0.9 }
);

const physician = resumeTemplate(
  "physician",
  "Physician / doctor",
  "Medical CV · licensure, training, clinical experience",
  "Healthcare",
  { layout: "centered", body: FONTS.sourceSerif, heading: FONTS.sourceSerif, accent: "#0f766e", muted: "#44403c", size: 10 },
  {
    name: "Sarah Whitfield",
    credentials: "MD, FACP",
    headline: "Consultant Physician · Internal Medicine & Cardiology",
    contact: ["Boston, MA", "s.whitfield@example.com", "+1 (617) 555 0164", "NPI 1234567890"],
    main: [
      { title: "Professional summary", kind: "text", text: "Board-certified internist with 11 years of inpatient and outpatient experience and a clinical focus on heart failure. Led a readmission-reduction programme that cut 30-day heart-failure readmissions from 24% to 15%." },
      {
        title: "Licensure & board certification",
        kind: "bullets",
        items: ["Massachusetts Medical License #278xxx — active, expires 2028", "Diplomate, American Board of Internal Medicine (2016; recertified 2026)", "Fellow, American College of Physicians (FACP), 2021", "ACLS / BLS certified (current)"],
      },
      {
        title: "Clinical experience",
        kind: "entries",
        entries: [
          {
            title: "Attending Physician, Department of Medicine",
            org: "Harborview General Hospital",
            place: "Boston, MA",
            dates: "2019 – Present",
            bullets: ["Inpatient attending on a 28-bed general medicine service; supervise 6 residents and 4 medical students per rotation.", "Founded the Heart Failure Transitions Clinic (1,100 patients/yr).", "Quality lead for sepsis bundle compliance (78% → 94%)."],
          },
          { title: "Hospitalist", org: "St. Agnes Medical Center", place: "Providence, RI", dates: "2016 – 2019", bullets: ["Managed 16–20 acute admissions per shift; procedural experience in central lines, paracentesis and thoracentesis."] },
        ],
      },
      {
        title: "Postgraduate training",
        kind: "entries",
        entries: [
          { title: "Chief Resident, Internal Medicine", org: "Lakeside University Hospital", place: "Chicago, IL", dates: "2015 – 2016" },
          { title: "Residency, Internal Medicine", org: "Lakeside University Hospital", place: "Chicago, IL", dates: "2012 – 2015" },
        ],
      },
      { title: "Education", kind: "entries", entries: [{ title: "Doctor of Medicine (MD)", org: "Northbridge School of Medicine", place: "Philadelphia, PA", dates: "2008 – 2012", detail: "Alpha Omega Alpha Honor Medical Society" }, { title: "BS Biology, summa cum laude", org: "Wellesford College", place: "Massachusetts", dates: "2004 – 2008" }] },
      { title: "Research & publications", kind: "numbered", items: ["<strong>Whitfield S</strong>, Ortiz M, Kaplan D. Nurse-led transitions of care reduce heart-failure readmissions: a pragmatic trial. <em>J Gen Intern Med</em>. 2024;39(5):812–819.", "Patel R, <strong>Whitfield S</strong>. Early palliative consultation in advanced heart failure. <em>JAMA Intern Med</em>. 2022;182(9):961–968."] },
      { title: "Teaching & leadership", kind: "bullets", items: ["Clerkship director, Internal Medicine (2021 – present).", "Residents’ Teaching Award (2020, 2023)."] },
      { title: "Professional memberships", kind: "bullets", items: ["American College of Physicians · Heart Failure Society of America · Massachusetts Medical Society"] },
    ],
  }
);

const accountant = resumeTemplate(
  "accountant",
  "Accountant / finance",
  "Classic · certifications, audit and reporting",
  "Finance & law",
  { layout: "classic", body: FONTS.plexSans, heading: FONTS.plexSans, accent: "#166534", muted: "#52525b", size: 10 },
  {
    name: "Michael Adeyemi",
    credentials: "ACA, CPA",
    headline: "Senior Financial Controller · IFRS reporting, audit & FP&A",
    contact: ["London, UK", "michael.adeyemi@example.com", "+44 20 7946 0158", "linkedin.com/in/michael-adeyemi-aca"],
    main: [
      { title: "Profile", kind: "text", text: "Chartered accountant with 10 years across Big Four audit and in-house finance. Led month-end close for a £420m-revenue group, shortening it from 12 to 5 working days, and delivered three clean statutory audits." },
      {
        title: "Experience",
        kind: "entries",
        entries: [
          {
            title: "Senior Financial Controller",
            org: "Kestrel Retail Group plc",
            place: "London",
            dates: "2021 – Present",
            bullets: ["Own consolidated IFRS reporting for 14 entities in 6 countries (£420m revenue).", "Cut month-end close from 12 to 5 days by automating intercompany reconciliations in BlackLine.", "Led IFRS 16 lease transition (£86m right-of-use assets) with no audit adjustments."],
          },
          {
            title: "Audit Manager, Assurance",
            org: "Harcourt & Lowe LLP",
            place: "London",
            dates: "2016 – 2021",
            bullets: ["Managed audits for listed retail and manufacturing clients (fees up to £1.1m); teams of up to 12.", "Identified a £3.4m revenue cut-off misstatement, leading to restated interim results."],
          },
          { title: "Audit Associate", org: "Harcourt & Lowe LLP", place: "Lagos", dates: "2014 – 2016", bullets: ["Statutory audits for banking and oil & gas clients under IFRS and Nigerian GAAP."] },
        ],
      },
      {
        title: "Qualifications",
        kind: "bullets",
        items: ["ACA — Institute of Chartered Accountants in England and Wales (2017)", "CPA — US Certified Public Accountant, Illinois (2019)", "ICAN — Institute of Chartered Accountants of Nigeria (2015)"],
      },
      { title: "Technical skills", kind: "pairs", pairs: [["Reporting", "IFRS, UK GAAP, consolidation, SOX controls, transfer pricing"], ["Systems", "SAP S/4HANA, Oracle NetSuite, BlackLine, Power BI, advanced Excel (VBA)"]] },
      { title: "Education", kind: "entries", entries: [{ title: "BSc Accounting, First Class", org: "University of Lagos", place: "Lagos", dates: "2009 – 2013" }] },
    ],
  }
);

const lawyer = resumeTemplate(
  "lawyer",
  "Lawyer / attorney",
  "Formal · bar admissions and representative matters",
  "Finance & law",
  { layout: "centered", body: FONTS.garamond, heading: FONTS.garamond, accent: "#1e3a5f", muted: "#44403c", size: 11 },
  {
    name: "Eleanor Vance",
    credentials: "Esq.",
    headline: "Senior Associate · Commercial Litigation & International Arbitration",
    contact: ["New York, NY", "eleanor.vance@example.com", "+1 (212) 555 0177"],
    main: [
      { title: "Summary", kind: "text", text: "Litigator with 8 years’ experience in complex commercial disputes and ICC/LCIA arbitration, with particular depth in energy and construction. First-chaired two arbitral hearings and secured over $310m in awards and settlements for clients." },
      { title: "Bar admissions", kind: "bullets", items: ["New York State Bar (2018)", "U.S. District Courts for the Southern and Eastern Districts of New York (2019)", "Solicitor of the Senior Courts of England and Wales (2022)"] },
      {
        title: "Legal experience",
        kind: "entries",
        entries: [
          {
            title: "Senior Associate",
            org: "Ashford Calloway LLP",
            place: "New York",
            dates: "2021 – Present",
            bullets: ["Lead associate on a $1.2bn ICC arbitration concerning an LNG supply agreement.", "First-chaired a construction arbitration; won $46m award including costs.", "Supervise a team of 5 associates and 3 paralegals; manage e-discovery over 4m documents."],
          },
          { title: "Associate", org: "Ashford Calloway LLP", place: "New York", dates: "2018 – 2021", bullets: ["Drafted dispositive motions in SDNY securities litigation; obtained dismissal with prejudice of a $90m claim."] },
          { title: "Judicial Law Clerk", org: "Hon. Margaret L. Chen, U.S. District Court (S.D.N.Y.)", place: "New York", dates: "2017 – 2018" },
        ],
      },
      {
        title: "Representative matters",
        kind: "bullets",
        items: ["Represented a national energy company in a $600m gas-price review arbitration (LCIA) — favourable award.", "Defended a global contractor in a $220m delay-and-disruption claim — settled at 15% of claim value.", "Pro bono: secured asylum for 4 clients through the Immigrant Justice Project."],
      },
      { title: "Education", kind: "entries", entries: [{ title: "Juris Doctor, magna cum laude", org: "Columbia Heights Law School", place: "New York", dates: "2014 – 2017", detail: "Articles Editor, <em>Journal of Transnational Law</em>" }, { title: "BA Political Science", org: "Wellesford College", place: "Massachusetts", dates: "2010 – 2014" }] },
      { title: "Publications", kind: "bullets", items: ["“Price review clauses after the energy transition”, <em>Arbitration International</em> (2025)."] },
      { title: "Languages", kind: "text", text: "English (native) · French (professional) · Spanish (conversational)" },
    ],
  }
);

const executive = resumeTemplate(
  "business-executive",
  "Business executive",
  "Executive résumé · leadership and results",
  "Business",
  {
    layout: "sidebar",
    body: FONTS.sourceSans,
    heading: FONTS.playfair,
    accent: "#1e3a5f",
    muted: "#475569",
    size: 9.5,
    sidebarBg: "#1e3a5f",
    sidebarDark: true,
  },
  {
    name: "Isabella Moretti",
    headline: "Chief Operating Officer · Scaling consumer and logistics businesses across EMEA",
    contact: ["Milan, Italy · London, UK", "isabella.moretti@example.com", "+39 02 5550 1832", "linkedin.com/in/isabellamoretti"],
    main: [
      { title: "Executive profile", kind: "text", text: "Operating executive with 18 years leading P&Ls of up to €1.1bn. Took a regional logistics business from €140m to €610m revenue in five years while raising EBITDA margin from 4% to 11%, and led two acquisitions and one successful IPO." },
      {
        title: "Leadership experience",
        kind: "entries",
        entries: [
          {
            title: "Chief Operating Officer",
            org: "Veloce Group S.p.A.",
            place: "Milan",
            dates: "2021 – Present",
            bullets: [
              "Lead operations, supply chain and technology (4,800 staff, 11 countries); €1.1bn revenue.",
              "Delivered €78m annual cost savings through network redesign and automation of 6 hubs.",
              "Co-led IPO on Euronext Milan (2024), raising €420m; ranked top-quartile ESG rating.",
            ],
          },
          {
            title: "Managing Director, Southern Europe",
            org: "Northwind Logistics",
            place: "Madrid",
            dates: "2016 – 2021",
            bullets: ["Grew revenue €140m → €610m; EBITDA margin 4% → 11%.", "Acquired and integrated two regional carriers (€95m combined) within 9 months."],
          },
          { title: "Engagement Manager", org: "Halcyon & Partners (management consulting)", place: "London", dates: "2008 – 2016", bullets: ["Led 30+ operations and growth engagements for FTSE 100 and private-equity clients."] },
        ],
      },
      { title: "Board & advisory", kind: "bullets", items: ["Non-Executive Director, Sana Retail plc (Audit Committee), 2023 – present.", "Advisory Board, Women in Supply Chain Europe, 2020 – present."] },
    ],
    side: [
      { title: "Key results", kind: "bullets", items: ["€1.1bn P&L led", "€420m IPO", "€78m savings", "2 acquisitions", "4,800-person organisation"] },
      { title: "Expertise", kind: "bullets", items: ["Operational transformation", "M&A integration", "Supply-chain strategy", "Digital & automation", "Board governance"] },
      { title: "Education", kind: "entries", entries: [{ title: "MBA", org: "", place: "INSEAD", dates: "2008" }, { title: "MSc Industrial Engineering", org: "", place: "Politecnico di Milano", dates: "2005" }] },
      { title: "Languages", kind: "bullets", items: ["Italian (native)", "English (fluent)", "Spanish (fluent)"] },
    ],
  }
);

const teacher = resumeTemplate(
  "teacher",
  "Teacher / educator",
  "Classic · classroom impact and qualifications",
  "Education",
  { layout: "classic", body: FONTS.literata, heading: FONTS.literata, accent: "#0e7490", muted: "#57534e", size: 10 },
  {
    name: "Grace Mwangi",
    credentials: "BEd, PGCE",
    headline: "Secondary Mathematics Teacher & Head of Year 10",
    contact: ["Nairobi, Kenya", "grace.mwangi@example.com", "+254 712 555 093", "TSC No. 512xxx"],
    main: [
      { title: "Profile", kind: "text", text: "Mathematics teacher with 9 years’ experience teaching KCSE and IGCSE to classes of up to 45. Raised the department’s mean KCSE mathematics grade from C to B− in three years through data-led intervention and peer tutoring." },
      {
        title: "Teaching experience",
        kind: "entries",
        entries: [
          {
            title: "Mathematics Teacher & Head of Year 10",
            org: "Riverside Academy",
            place: "Nairobi",
            dates: "2020 – Present",
            bullets: ["Teach Forms 3–4 mathematics (KCSE) and IGCSE Additional Mathematics; 5 classes, 190 students.", "Mean grade improved C → B− (2021–2024); A/A− share grew from 6% to 19%.", "Lead pastoral care for 210 Year 10 students and a team of 7 form tutors."],
          },
          { title: "Mathematics Teacher", org: "Kilimani Girls’ High School", place: "Nairobi", dates: "2016 – 2020", bullets: ["Introduced a peer-tutoring programme (60 tutors) and coached the national Mathematics Olympiad team to 3rd place (2019)."] },
        ],
      },
      { title: "Qualifications", kind: "bullets", items: ["Postgraduate Certificate in Education (PGCE), Nairobi Institute of Education, 2019", "Bachelor of Education (Mathematics & Physics), Kenyatta University, 2015 — First Class", "Registered with the Teachers Service Commission (TSC)"] },
      { title: "Professional development", kind: "bullets", items: ["Cambridge IGCSE Mathematics examiner training (2023)", "Google Certified Educator Level 2 (2022)", "Assessment for Learning, British Council (2021)"] },
      { title: "Skills", kind: "bullets", items: ["Differentiated instruction · formative assessment · classroom management", "GeoGebra, Desmos, Google Classroom, Excel for grade analytics"] },
      { title: "Extracurricular", kind: "bullets", items: ["Patron, Mathematics & Chess Club", "Coordinator, annual STEM Week (1,200 visitors)"] },
    ],
  }
);

export const RESUME_VARIANTS: DocTemplate[] = [
  softwareEngineer,
  dataScientist,
  productManager,
  graduate,
  researchScientist,
  academic,
  physician,
  accountant,
  lawyer,
  executive,
  teacher,
];

export const RESUME_GROUPS = ["Technology", "Research & academia", "Healthcare", "Finance & law", "Business", "Education", "Early career"];
