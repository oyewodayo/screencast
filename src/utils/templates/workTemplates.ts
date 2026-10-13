// utils/templates/workTemplates.ts
//
// Business templates with realistic sample content. Every company, person and figure here is
// fictional.
import type { DocTemplate } from "./types";
import { callout, h, hr, ol, p, pageBreak, run, table, tasks, toc, ul } from "./templateHtml";

const ACCENT = "#1d4ed8";

// ---------------------------------------------------------------------------------------------
// Report

const report: DocTemplate = {
  id: "report",
  name: "Business report",
  description: "Title page, contents, KPI tables, recommendations",
  category: "Work",
  docTitle: () => "Q3 2026 operations review",
  pageSetup: { footerText: "Northwind Logistics · Confidential — internal use only" },
  html: (today) =>
    [
      p("<br>"),
      p("<br>"),
      p(run({ color: ACCENT, size: 12 }, "<strong>NORTHWIND LOGISTICS</strong>")),
      h(1, run({ size: 34 }, "Q3 2026 Operations Review")),
      p(run({ size: 15, color: "#475569" }, "Delivery performance, warehouse efficiency and cost-to-serve across West Africa")),
      p("<br>"),
      table(
        [
          ["Prepared by", "Operations Strategy Team"],
          ["Lead author", "Funmilayo Adebayo, Head of Operations Strategy"],
          ["Date", today],
          ["Distribution", "Executive Committee · Regional Directors"],
        ],
        { header: false, rules: "none", shade: (_r, c) => (c === 0 ? "#f1f5f9" : undefined), widths: [160, 464] }
      ),
      pageBreak(),
      toc(2),
      pageBreak(),
      h(1, "1. Executive summary"),
      p(
        "Q3 was the strongest quarter on record for on-time delivery, driven by the Lagos and Accra route-optimisation pilots. Volume grew 18% year on year while cost-to-serve fell 6%. Two risks require Executive Committee attention: driver attrition in Kano (21% annualised) and a 9-day backlog at the Tema port gateway."
      ),
      table(
        [
          ["KPI", "Q3 2025", "Q2 2026", "Q3 2026", "Target", "Status"],
          ["On-time delivery", "86.4%", "90.1%", "93.7%", "92.0%", "✅ Ahead"],
          ["Parcels delivered (m)", "4.12", "4.58", "4.86", "4.70", "✅ Ahead"],
          ["Cost per parcel (₦)", "1,245", "1,190", "1,171", "1,150", "⚠️ Close"],
          ["Warehouse pick accuracy", "99.1%", "99.3%", "99.5%", "99.5%", "✅ On target"],
          ["Driver attrition (annualised)", "14%", "17%", "19%", "12%", "❌ Behind"],
        ],
        { headerBg: "#1e3a5f", shade: (r) => (r > 0 && r % 2 === 0 ? "#f8fafc" : undefined) }
      ),
      callout(p("<strong>Decision needed:</strong> approve the ₦240m driver-retention programme (Section 4.1) before the November peak season."), "#fef9c3"),
      h(1, "2. Background"),
      p("Northwind operates 14 fulfilment centres and 2,300 delivery vehicles across Nigeria, Ghana and Côte d’Ivoire. This review covers 1 July – 30 September 2026 and compares performance against the 2026 operating plan approved in January."),
      h(1, "3. Findings"),
      h(2, "3.1 Route optimisation delivered the on-time gains"),
      p("The dynamic routing pilot in Lagos and Accra cut average stops-per-route time by 11 minutes and lifted on-time delivery from 89.8% to 95.2% in pilot zones, against 91.6% elsewhere."),
      table(
        [
          ["Region", "Parcels (k)", "On-time", "Δ vs Q2", "Cost / parcel (₦)"],
          ["Lagos", "1,920", "95.4%", "+4.1 pts", "1,104"],
          ["Accra", "1,055", "94.8%", "+3.6 pts", "1,132"],
          ["Abuja", "814", "92.0%", "+1.2 pts", "1,201"],
          ["Kano", "602", "88.3%", "−0.7 pts", "1,298"],
          ["Abidjan", "469", "91.7%", "+0.9 pts", "1,256"],
          ["<strong>Total</strong>", "<strong>4,860</strong>", "<strong>93.7%</strong>", "<strong>+3.6 pts</strong>", "<strong>1,171</strong>"],
        ],
        { headerBg: "#e2e8f0", shade: (r) => (r === 6 ? "#f1f5f9" : undefined) }
      ),
      h(2, "3.2 Driver attrition is concentrated in Kano"),
      p("Exit interviews (n = 84) cite pay relative to ride-hailing (52%), long shifts in peak weeks (31%) and vehicle condition (17%). Each departure costs an estimated ₦1.9m in recruiting, training and lost productivity."),
      h(2, "3.3 Port backlog at Tema"),
      p("Customs inspection changes introduced in August raised average clearance time from 3.2 to 9.1 days. Inventory held at the port reached ₦1.4bn on 30 September."),
      h(1, "4. Recommendations"),
      ol([
        "<strong>Approve a driver-retention programme</strong> (₦240m): 8% pay uplift for drivers with 12+ months’ tenure, capped peak-week hours and a vehicle refresh in Kano.",
        "<strong>Scale dynamic routing</strong> to Abuja and Kano in Q4 (₦65m), targeting +3 pts on-time delivery.",
        "<strong>Open a bonded-warehouse option</strong> in Tema with a licensed partner to move inventory off the port within 72 hours.",
      ]),
      h(1, "5. Next steps"),
      tasks([
        [false, "Finance to validate retention-programme payback (owner: CFO office, due 24 Oct)."],
        [false, "Routing rollout plan for Abuja and Kano (owner: Tech Ops, due 31 Oct)."],
        [false, "Shortlist bonded-warehouse partners (owner: Ghana Country Manager, due 7 Nov)."],
      ]),
      h(1, "Appendix A — Methodology"),
      p("On-time delivery is measured against the promised delivery window shown to customers at checkout. Cost per parcel includes line-haul, last-mile and warehouse labour but excludes head-office overheads."),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Meeting notes

const meetingNotes: DocTemplate = {
  id: "meeting-notes",
  name: "Meeting notes",
  description: "Agenda, discussion, decisions, action checklist",
  category: "Work",
  docTitle: (today) => `Product sync – ${today}`,
  html: (today) =>
    [
      h(1, "Atlas Mobile — Weekly Product Sync"),
      table(
        [
          ["📅 Date", today, "🕙 Time", "10:00 – 10:45 WAT"],
          ["📍 Where", "Room Kilimanjaro / Google Meet", "📝 Notes by", "Kemi Balogun"],
          ["👥 Attendees", "Kemi Balogun (PM), David Osei (Eng lead), Aisha Bello (Design), Tunde Fashola (QA), Lara Mendes (Data)", "🚫 Apologies", "Samuel Eze (Marketing)"],
        ],
        { header: false, rules: "none", shade: (_r, c) => (c % 2 === 0 ? "#f1f5f9" : undefined), widths: [100, 230, 100, 194] }
      ),
      h(2, "Agenda"),
      ol([
        "Release 4.2 status and go/no-go (10 min)",
        "Onboarding funnel results from the A/B test (15 min)",
        "Payments outage post-mortem follow-ups (10 min)",
        "AOB (5 min)",
      ]),
      h(2, "Discussion"),
      h(3, "1. Release 4.2 status"),
      ul([
        "All 23 planned tickets merged; 2 P2 bugs open (Android 9 crash on photo upload, iOS dark-mode contrast on receipts).",
        "QA regression pass at 96% (142/148 cases). Remaining 6 blocked on staging payment sandbox.",
        "David: crash fix is a one-line null check — low risk to ship in 4.2.",
      ]),
      h(3, "2. Onboarding A/B test"),
      table(
        [
          ["Variant", "Users", "Completed onboarding", "Day-7 retention"],
          ["A — current (5 screens)", "12,480", "61.2%", "34.8%"],
          ["B — 3 screens + skip", "12,512", "72.9%", "36.1%"],
        ],
        { headerBg: "#dbeafe" }
      ),
      ul(["Variant B lifts completion by 11.7 pts (p < 0.001) with no drop in Day-7 retention.", "Aisha flagged that ‘Skip’ users see fewer notification permission prompts — Lara to segment."]),
      h(3, "3. Payments outage follow-ups"),
      ul(["Root cause: expired TLS certificate on the card-tokenisation gateway (38 min outage, 1,912 failed payments).", "Automated certificate monitoring is now live; runbook updated."]),
      h(2, "Decisions"),
      callout(
        ul([
          "<strong>Go</strong> for release 4.2 on Thursday, including the Android crash fix.",
          "Roll out onboarding variant B to 100% of new users from Monday.",
          "Payment certificate checks move into the weekly on-call checklist.",
        ]),
        "#dcfce7"
      ),
      h(2, "Action items"),
      tasks([
        [true, "Merge Android photo-upload null check — <strong>David</strong> · today"],
        [false, "Fix receipt contrast in iOS dark mode — <strong>Aisha</strong> · Wed"],
        [false, "Unblock payment sandbox and finish regression — <strong>Tunde</strong> · Wed"],
        [false, "Segment ‘Skip’ users by notification opt-in — <strong>Lara</strong> · Fri"],
        [false, "Draft release notes and app-store copy — <strong>Kemi</strong> · Thu"],
      ]),
      h(2, "Next meeting"),
      p("Next Tuesday, 10:00 WAT — focus: 4.2 launch metrics and Q4 roadmap."),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Project proposal

const projectProposal: DocTemplate = {
  id: "project-proposal",
  name: "Project proposal",
  description: "Problem, objectives, timeline, budget, risks",
  category: "Work",
  docTitle: () => "Project proposal – SolarCool",
  html: (today) =>
    [
      p(run({ color: "#15803d" }, "<strong>PROJECT PROPOSAL</strong>")),
      h(1, "SolarCool: Solar-Powered Cold Storage for Smallholder Farmers in Kano State"),
      table(
        [
          ["Submitted by", "GreenHarvest Cooperative Society", "Date", today],
          ["Project lead", "Ibrahim Musa, Programme Director", "Requested", "₦186,400,000 (≈ US$121,000)"],
          ["Duration", "18 months (Jan 2027 – Jun 2028)", "Beneficiaries", "1,200 farming households"],
        ],
        { header: false, rules: "none", shade: (_r, c) => (c % 2 === 0 ? "#dcfce7" : undefined), widths: [110, 220, 100, 194] }
      ),
      h(2, "1. Summary"),
      p(
        "Up to 40% of tomatoes and leafy vegetables grown by smallholders in Kano spoil before reaching market because farmers have no access to cold storage. SolarCool will install six 10-tonne solar-powered cold rooms at aggregation points, operated on a pay-per-crate model, extending shelf life from 2 to 21 days and raising participating farmers’ incomes by an estimated 35%."
      ),
      h(2, "2. Problem and evidence"),
      ul([
        "Post-harvest losses for tomato in northern Nigeria are estimated at 35–45% of production.",
        "Grid electricity at the target sites is available on average 6 hours per day.",
        "A 2026 baseline survey of 410 cooperative members found 78% sell at the farm gate within 48 hours of harvest, at prices 30–50% below urban markets.",
      ]),
      h(2, "3. Objectives"),
      table(
        [
          ["Objective", "Indicator", "Baseline", "Target (Month 18)"],
          ["Reduce post-harvest loss", "% of produce spoiled before sale", "38%", "≤ 12%"],
          ["Increase farmer income", "Avg. seasonal net income (₦)", "412,000", "556,000"],
          ["Financial sustainability", "Cold-room cost recovery", "—", "≥ 100% of O&M"],
          ["Inclusion", "Share of women-led households served", "22%", "≥ 40%"],
        ],
        { headerBg: "#15803d" }
      ),
      h(2, "4. Approach"),
      ol([
        "<strong>Site selection</strong> — six aggregation points chosen with the State Ministry of Agriculture on road access, farmer density and security.",
        "<strong>Installation</strong> — containerised 10-tonne cold rooms with 12 kWp solar arrays and thermal storage for 24-hour autonomy.",
        "<strong>Operations</strong> — cooperative-employed operators; ₦300 per crate per day via mobile money.",
        "<strong>Market linkage</strong> — agreements with three Kano and Abuja off-takers for weekly collection.",
      ]),
      h(2, "5. Timeline"),
      table(
        [
          ["Phase", "Key deliverables", "Start", "End"],
          ["1. Inception", "Site agreements, procurement, baseline update", "Jan 2027", "Mar 2027"],
          ["2. Build", "Six cold rooms installed and commissioned", "Apr 2027", "Jul 2027"],
          ["3. Operate", "Pay-per-crate service live; operator training", "Aug 2027", "Apr 2028"],
          ["4. Evaluate", "Endline survey, impact report, scale-up plan", "May 2028", "Jun 2028"],
        ],
        { headerBg: "#dcfce7" }
      ),
      h(2, "6. Budget"),
      table(
        [
          ["Line item", "Qty", "Unit cost (₦)", "Total (₦)"],
          ["Solar cold room, installed", "6", "21,500,000", "129,000,000"],
          ["Site preparation & fencing", "6", "2,400,000", "14,400,000"],
          ["Operator training & salaries (12 months)", "6", "3,000,000", "18,000,000"],
          ["Mobile-money integration & software", "1", "6,500,000", "6,500,000"],
          ["Monitoring & evaluation", "1", "9,800,000", "9,800,000"],
          ["Contingency (5%)", "—", "—", "8,700,000"],
          ["<strong>Total requested</strong>", "", "", "<strong>186,400,000</strong>"],
        ],
        { headerBg: "#e2e8f0", shade: (r) => (r === 7 ? "#dcfce7" : undefined) }
      ),
      h(2, "7. Risks and mitigation"),
      table(
        [
          ["Risk", "Likelihood", "Impact", "Mitigation"],
          ["Low uptake in first season", "Medium", "High", "Free first two weeks; farmer champions at each site"],
          ["Equipment theft or vandalism", "Low", "High", "Fencing, community guards, insurance"],
          ["Price volatility for produce", "High", "Medium", "Forward agreements with three off-takers"],
        ],
        { headerBg: "#e2e8f0" }
      ),
      h(2, "8. Team"),
      ul([
        "<strong>Ibrahim Musa</strong> — Programme Director; 12 years in agricultural value chains.",
        "<strong>Dr. Hauwa Abdullahi</strong> — Post-harvest specialist, Bayero Agricultural Research Centre.",
        "<strong>Chidi Nwosu</strong> — Solar engineer; delivered 40+ off-grid installations.",
      ]),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Weekly update

const weeklyUpdate: DocTemplate = {
  id: "status-update",
  name: "Weekly update",
  description: "Done, next, blockers, metrics",
  category: "Work",
  docTitle: (today) => `Weekly update – ${today}`,
  html: (today) =>
    [
      h(1, "Platform Team — Weekly Update"),
      p(`<strong>Week ending</strong> ${today} &nbsp;·&nbsp; <strong>Author:</strong> David Osei, Engineering Lead &nbsp;·&nbsp; <strong>Overall:</strong> 🟢 On track`),
      callout(p("<strong>TL;DR</strong> — Release 4.2 shipped on schedule; API p95 latency down 23%; one blocker on the payments sandbox needs Finance sign-off by Wednesday."), "#dbeafe"),
      h(2, "✅ Done this week"),
      tasks([
        [true, "Shipped release 4.2 to 100% of users (crash-free sessions 99.6%)."],
        [true, "Migrated order service to PostgreSQL 16; zero downtime."],
        [true, "Added automated TLS certificate expiry alerts across all gateways."],
        [true, "Interviewed 4 backend candidates; 1 offer extended."],
      ]),
      h(2, "🎯 Plan for next week"),
      tasks([
        [false, "Begin Q4 search re-architecture spike (owner: Ngozi)."],
        [false, "Load-test checkout at 3× Black Friday peak (owner: Tunde)."],
        [false, "Close out 12 remaining P3 bugs from the 4.2 bug bash."],
      ]),
      h(2, "⚠️ Blockers & risks"),
      table(
        [
          ["Issue", "Impact", "Ask", "Owner"],
          ["Payments sandbox credentials expire Fri", "Blocks regression testing", "Finance to approve renewal", "Kemi"],
          ["One SRE on leave next 2 weeks", "Reduced on-call cover", "Borrow 1 engineer from Data team", "David"],
        ],
        { headerBg: "#ffedd5" }
      ),
      h(2, "📊 Metrics"),
      table(
        [
          ["Metric", "Last week", "This week", "Trend"],
          ["API p95 latency", "412 ms", "318 ms", "▼ 23%"],
          ["Crash-free sessions", "99.2%", "99.6%", "▲ 0.4 pts"],
          ["Deploys to production", "14", "19", "▲ 5"],
          ["Open P1/P2 bugs", "7", "2", "▼ 5"],
        ],
        { headerBg: "#e2e8f0" }
      ),
      h(2, "🙌 Shout-outs"),
      p("Thanks to Tunde for working through the weekend to unblock the 4.2 regression pass."),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Invoice

const invoice: DocTemplate = {
  id: "invoice",
  name: "Invoice",
  description: "Itemised invoice with totals and payment details",
  category: "Work",
  docTitle: () => "Invoice INV-2026-0187",
  html: (today) =>
    [
      table(
        [
          [
            `${h(1, run({ size: 22, color: "#ffffff" }, "Brightwave Studio Ltd"))}${p(run({ color: "#cbd5e1" }, "Brand · Web · Motion design<br>12 Admiralty Way, Lekki Phase 1, Lagos<br>hello@brightwave.example · +234 (0) 801 555 0142"))}`,
            `${h(1, run({ size: 26, color: "#ffffff" }, "INVOICE"), { align: "right" })}${p(run({ color: "#cbd5e1" }, `No. INV-2026-0187<br>Issued: ${today}<br>Due: within 30 days`), { align: "right" })}`,
          ],
        ],
        { header: false, rules: "none", shade: () => "#1e3a5f", widths: [380, 244] }
      ),
      p("<br>"),
      table(
        [
          ["<strong>BILL TO</strong>", "<strong>PROJECT</strong>"],
          ["Northwind Logistics Ltd<br>Attn: Funmilayo Adebayo<br>45 Marina Road, Lagos Island, Lagos<br>accounts@northwind.example", "Customer app redesign — Phase 2<br>PO number: NW-PO-55821<br>Period: 1 – 30 September 2026"],
        ],
        { header: false, rules: "none", widths: [312, 312] }
      ),
      p("<br>"),
      table(
        [
          ["Description", "Qty", "Rate (₦)", "Amount (₦)"],
          ["UX research — 12 user interviews and synthesis report", "1", "1,800,000", "1,800,000"],
          ["UI design — 28 high-fidelity screens (iOS & Android)", "28", "95,000", "2,660,000"],
          ["Interactive prototype and usability test round", "1", "1,150,000", "1,150,000"],
          ["Design system: components, tokens and documentation", "1", "2,400,000", "2,400,000"],
          ["Motion design — onboarding animations", "6", "120,000", "720,000"],
        ],
        { headerBg: "#e2e8f0", shade: (r) => (r > 0 && r % 2 === 0 ? "#f8fafc" : undefined), widths: [334, 60, 110, 120] }
      ),
      table(
        [
          ["", "Subtotal", "₦8,730,000"],
          ["", "VAT (7.5%)", "₦654,750"],
          ["", "<strong>Total due</strong>", "<strong>₦9,384,750</strong>"],
        ],
        { header: false, rules: "none", shade: (r, c) => (r === 2 && c > 0 ? "#dbeafe" : undefined), widths: [334, 170, 120] }
      ),
      h(3, "Payment details"),
      table(
        [
          ["Bank", "Crestline Bank Plc"],
          ["Account name", "Brightwave Studio Ltd"],
          ["Account number", "1014 552 087"],
          ["Reference", "INV-2026-0187"],
        ],
        { header: false, rules: "none", shade: (_r, c) => (c === 0 ? "#f1f5f9" : undefined), widths: [160, 464] }
      ),
      hr(),
      p(run({ color: "#64748b", size: 9 }, "Thank you for your business. Late payments attract interest at 2% per month after the due date. Questions about this invoice? Contact accounts@brightwave.example.")),
    ].join(""),
};

export const WORK_TEMPLATES: DocTemplate[] = [report, meetingNotes, projectProposal, weeklyUpdate, invoice];
