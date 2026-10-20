// utils/templates/researchTemplates.ts
//
// Research templates, filled with realistic sample content so a user sees what a finished
// document of that kind looks like and edits it into theirs. People and institutions are
// fictional; the cited papers (researchReferences.ts) are real.
import type { DocTemplate } from "./types";
import { FRUSTRATED_MAGNETISM_REFS } from "./researchReferences";
import {
  FONTS,
  bibliography,
  callout,
  caption,
  cite,
  h,
  hr,
  m,
  math,
  ol,
  p,
  pageBreak,
  quote,
  run,
  table,
  tasks,
  toc,
  ul,
  xref,
} from "./templateHtml";

const R = String.raw;

// ---------------------------------------------------------------------------------------------
// Research paper - single-column preprint, typeset like an arXiv LaTeX article.

const paperSection = (text: string) => h(2, run({ size: 12.5 }, text));
const paperSubsection = (text: string) => h(3, run({ size: 11 }, text));

const researchPaper: DocTemplate = {
  id: "research-paper",
  name: "Research paper",
  description: "Preprint with equations, tables and live citations",
  category: "Research",
  docTitle: () => "Order by disorder in a programmable quantum simulator",
  layout: {
    body: { fontFamily: FONTS.latinModern, fontSize: 11, lineHeight: 1.3, blockSpacing: 0, paragraphIndent: 15, justify: true, hyphenate: true },
  },
  references: FRUSTRATED_MAGNETISM_REFS,
  citationStyle: "aps",
  html: () =>
    [
      h(1, run({ size: 17 }, "Order by Disorder in a Programmable Quantum Simulator of the Transverse-Field Triangular Ising Antiferromagnet"), { align: "center", after: 10 }),
      p(run({ size: 11 }, "Amara N. Okonkwo<sup>1,*</sup>, Jonas Lindqvist<sup>2</sup>, Mei-Ling Zhou<sup>1</sup> and Rafael Ortega<sup>1</sup>"), { align: "center", noIndent: true }),
      p(
        run(
          { size: 9 },
          "<sup>1</sup>Institute for Quantum Matter, Halden University, Halden 4021, Norway<br><sup>2</sup>Department of Applied Physics, Västerby Institute of Technology, Västerby, Sweden<br><sup>*</sup>Corresponding author: a.okonkwo@halden.example.edu"
        ),
        { align: "center", after: 8, noIndent: true }
      ),
      callout(
        p(
          `<strong>Abstract.</strong> Geometric frustration in the triangular Ising antiferromagnet leaves an extensively degenerate classical ground state with no long-range order. A transverse field ${m(R`\Gamma`)} lifts this degeneracy through quantum fluctuations, selecting a three-sublattice clock phase by an order-by-disorder mechanism. We realise this model on a 486-site programmable array of superconducting flux qubits and map the phase diagram in the ${m(R`(\Gamma/J,\,T/J)`)} plane. The clock order parameter rises sharply below ${m(R`\Gamma_c/J = 0.61 \pm 0.03`)}, consistent with quantum Monte Carlo predictions for the three-dimensional XY universality class, and the measured spin structure factor peaks at the ${m(R`K`)} points of the Brillouin zone. Our results establish programmable annealers as quantitative simulators of frustrated quantum magnets at system sizes beyond exact diagonalisation.`
        ),
        "#f1f5f9"
      ),
      p(`<strong>Keywords:</strong> geometric frustration; order by disorder; transverse-field Ising model; quantum annealing; quantum simulation`, { noIndent: true, before: 6 }),

      paperSection("1. Introduction"),
      p(
        `Frustrated magnets — systems whose interactions cannot all be satisfied simultaneously — are a central arena for emergent collective phenomena, from spin liquids ${cite("balents2010", "savary2017")} to the fractionalised monopole excitations of spin ice ${cite("castelnovo2008")}. The simplest example is the antiferromagnetic Ising model on the triangular lattice, whose classical ground state is macroscopically degenerate with a residual entropy of ${m(R`0.323\,k_B`)} per spin ${cite("wannier1950")}.`
      ),
      p(
        `Weak perturbations can lift such degeneracies in a manner selected by fluctuations rather than energetics, a phenomenon known as <em>order by disorder</em> ${cite("villain1980")}. Adding a transverse field converts the model into a quantum problem whose low-energy physics maps onto a three-dimensional XY model with a six-fold clock anisotropy ${cite("moessner2001", "isakov2003")}. Here we present a direct, large-scale realisation of this mechanism.`
      ),
      p("Our main contributions are:"),
      ul([
        "a calibrated mapping of a 486-qubit programmable annealer onto the transverse-field triangular Ising Hamiltonian with independently tuned couplings;",
        "a full phase diagram from 3,200 independent anneals per point, with finite-size scaling across five system sizes;",
        "a quantitative comparison with quantum Monte Carlo that bounds residual control errors below 2%.",
      ]),

      paperSection("2. Model and methods"),
      paperSubsection("2.1 Hamiltonian"),
      p("We study the transverse-field Ising model on a triangular lattice with periodic boundary conditions,", { noIndent: true }),
      math(R`\hat{H} = J \sum_{\langle i,j \rangle} \hat{\sigma}^z_i \hat{\sigma}^z_j \;-\; \Gamma \sum_i \hat{\sigma}^x_i ,`, { id: "eq-hamiltonian" }),
      p(
        `where ${m(R`J > 0`)} is the antiferromagnetic exchange, ${m(R`\Gamma`)} the transverse field and the first sum runs over nearest-neighbour bonds. At ${m(R`\Gamma = 0`)} every triangle hosts one frustrated bond. Long-range order is detected through the complex clock order parameter`,
        { noIndent: true }
      ),
      math(R`\psi = \frac{1}{N} \sum_{j} \langle \hat{\sigma}^z_j \rangle\, e^{\,i \mathbf{Q} \cdot \mathbf{r}_j}, \qquad \mathbf{Q} = \left(\tfrac{4\pi}{3a}, 0\right),`, { id: "eq-order" }),
      p(`whose modulus ${m(R`|\psi|`)} is finite in the clock phase and vanishes in the paramagnet. The phase ${m(R`\arg\psi`)} distinguishes the six symmetry-related ordered states.`, { noIndent: true }),
      paperSubsection("2.2 Experimental protocol"),
      p(
        `Each data point combines 3,200 anneals of 20 µs followed by a projective measurement in the ${m(R`\sigma^z`)} basis. Couplings were calibrated with a shimming procedure that equalises single-qubit magnetisations to within 0.5%. The effective temperature was extracted from the fluctuation–dissipation relation on isolated test triangles.`
      ),

      paperSection("3. Results"),
      p(
        `${xref("tab-results")} summarises the order parameter and structure factor across the transition. The clock order parameter of ${xref("eq-order")} grows continuously below a critical field ${m(R`\Gamma_c`)}, with no hysteresis between forward and reverse anneals, indicating a continuous transition.`
      ),
      caption("table", "Clock order parameter and spin structure factor at the K point for the largest system (N = 486) at T/J = 0.12. Uncertainties are one standard error over independent calibrations.", "tab-results"),
      table(
        [
          [m(R`\Gamma/J`), m(R`|\psi|`), m(R`S(\mathbf{K})/N`), "Binder ratio", "Phase"],
          ["0.20", "0.412 ± 0.006", "0.171 ± 0.004", "0.651", "Clock"],
          ["0.40", "0.355 ± 0.007", "0.128 ± 0.005", "0.643", "Clock"],
          ["0.55", "0.241 ± 0.009", "0.062 ± 0.004", "0.598", "Clock"],
          ["0.61", "0.132 ± 0.011", "0.019 ± 0.003", "0.487", "Critical"],
          ["0.70", "0.048 ± 0.008", "0.004 ± 0.002", "0.311", "Paramagnet"],
          ["0.90", "0.021 ± 0.006", "0.001 ± 0.001", "0.205", "Paramagnet"],
        ],
        { rules: "booktabs", fit: true }
      ),
      p(
        `Finite-size scaling of the Binder ratio across ${m(R`N = 96, 150, 216, 294, 486`)} yields crossing points that extrapolate to ${m(R`\Gamma_c/J = 0.61 \pm 0.03`)}, in agreement with the quantum Monte Carlo value of 0.60 for the same model ${cite("isakov2003")}. Using the XY correlation-length exponent ${m(R`\nu = 0.672`)} collapses the data for all sizes onto a single curve.`
      ),

      paperSection("4. Discussion"),
      p(
        `The agreement with theory indicates that control errors on the device act as a weak random field that does not destroy the clock phase at the system sizes studied. This contrasts with classical simulated annealing, which freezes into domain-wall networks with ${m(R`|\psi| < 0.05`)} at all temperatures probed. Two limitations remain: the effective temperature cannot be lowered independently of the annealing schedule, and next-nearest-neighbour crosstalk of order ${m(R`0.01J`)} could stabilise competing orders in larger arrays.`
      ),

      paperSection("5. Conclusion"),
      p(
        "We have demonstrated quantum order by disorder in a programmable simulator of the triangular Ising antiferromagnet and located the clock transition with percent-level precision. The same platform can address open questions on the stability of spin-liquid phases on the kagome and pyrochlore lattices."
      ),

      paperSection("Acknowledgements"),
      p("We thank L. Haugen for discussions on finite-size scaling. This work was supported by the Halden Research Council under grant HRC-2025-0412.", { noIndent: true }),
      paperSection("Data availability"),
      p("Raw measurement records and analysis scripts are available from the corresponding author on reasonable request.", { noIndent: true }),
      paperSection("References"),
      bibliography(),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Journal letter - two-column, Physical Review style.

const journalLetter: DocTemplate = {
  id: "journal-letter",
  name: "Journal letter (two-column)",
  description: "PRL-style two-column letter",
  category: "Research",
  docTitle: () => "Emergent monopole dynamics in quantum spin ice",
  layout: {
    columns: 2,
    body: { fontFamily: FONTS.stix, fontSize: 10, lineHeight: 1.22, blockSpacing: 0, paragraphIndent: 10, justify: true, hyphenate: true },
  },
  pageSetup: { margins: { top: 0.75, right: 0.7, bottom: 0.75, left: 0.7 } },
  references: FRUSTRATED_MAGNETISM_REFS,
  citationStyle: "aps",
  html: () =>
    [
      h(1, run({ size: 15 }, "Emergent Monopole Dynamics in a Quantum Spin Ice Simulator"), { align: "center", span: true, after: 6 }),
      p("Lukas Brenner,<sup>1</sup> Ifeoma Chukwu,<sup>1,2</sup> and Hana Sato<sup>1</sup>", { align: "center", span: true, noIndent: true }),
      p(
        run({ size: 8.5 }, "<em><sup>1</sup>Centre for Correlated Matter, Ardmore University, Ardmore, Ireland<br><sup>2</sup>Quantum Devices Laboratory, Lakeside Institute, Toronto, Canada</em>"),
        { align: "center", span: true, after: 4, noIndent: true }
      ),
      p(run({ size: 8.5 }, "(Received 2 June 2026; accepted 14 September 2026)"), { align: "center", span: true, after: 8, noIndent: true }),
      p(
        `We report time-resolved measurements of magnetic-monopole excitations in a 1,024-site programmable quantum simulator of pyrochlore spin ice. Monopoles created by local field quenches propagate diffusively with a hopping rate that scales as ${m(R`(\Gamma/J)^2`)}, demonstrating that quantum tunnelling, not thermal activation, dominates their motion below ${m(R`T/J = 0.2`)}. The measured monopole density relaxes with a characteristic time ${m(R`\tau = 4.1 \pm 0.3\ \mu\text{s}`)} that agrees with a Coulomb-gas model including a dynamically screened interaction.`,
        { span: true, after: 10, noIndent: true }
      ),
      p(
        `<em>Introduction.</em>—Spin ice materials host emergent magnetic monopoles: point-like defects that violate the local “two-in, two-out” ice rule and interact through a magnetic Coulomb law ${cite("castelnovo2008")}. In quantum spin ice, transverse exchange processes make the ice manifold itself fluctuate, potentially stabilising a U(1) quantum spin liquid with emergent photons ${cite("savary2017", "balents2010")}.`
      ),
      p(
        "Direct observation of monopole motion has so far been limited to bulk probes. Here we use a programmable simulator to create single monopole pairs on demand and image their subsequent dynamics."
      ),
      p(`<em>Model.</em>—We implement the nearest-neighbour quantum spin-ice Hamiltonian`, { noIndent: true }),
      math(R`\hat{H} = J_{zz} \sum_{\langle ij \rangle} \hat{S}^z_i \hat{S}^z_j - J_{\pm} \sum_{\langle ij \rangle} \big(\hat{S}^+_i \hat{S}^-_j + \text{h.c.}\big),`, { id: "eq-qsi" }),
      p(`with ${m(R`J_{\pm}/J_{zz}`)} tunable between 0 and 0.12. The ice rule is satisfied for every tetrahedron in the ground state at ${m(R`J_{\pm} = 0`)}.`, { noIndent: true }),
      p(
        `<em>Results.</em>—${xref("tab-monopole")} lists the extracted hopping rates. The quadratic scaling with ${m(R`J_{\pm}`)} is the hallmark of a second-order tunnelling process across a tetrahedron, as predicted by perturbation theory.`
      ),
      caption("table", "Monopole hopping rate and relaxation time versus transverse exchange.", "tab-monopole"),
      table(
        [
          [m(R`J_\pm/J_{zz}`), m(R`\nu_{\rm hop}`) + " (MHz)", m(R`\tau`) + " (µs)"],
          ["0.02", "0.18(2)", "9.7(6)"],
          ["0.05", "1.12(5)", "6.2(4)"],
          ["0.08", "2.91(9)", "4.1(3)"],
          ["0.12", "6.40(18)", "2.6(2)"],
        ],
        { rules: "doubled", fit: true }
      ),
      p(
        "<em>Conclusion.</em>—Programmable simulators give direct access to fractionalised excitations in frustrated quantum magnets, opening a route to measuring emergent photon dispersion in the same platform."
      ),
      p(run({ size: 8.5 }, "We acknowledge support from the Ardmore Quantum Initiative."), { noIndent: true, before: 6 }),
      bibliography(),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Thesis - title page, front matter, contents, first chapter.

const thesisChapter = (text: string) => h(1, run({ size: 20 }, text), { before: 24, after: 18 });
const thesisSection = (text: string) => h(2, run({ size: 14 }, text));

const thesis: DocTemplate = {
  id: "thesis",
  name: "Thesis / dissertation",
  description: "Title page, front matter, contents, chapters",
  category: "Research",
  docTitle: () => "PhD thesis",
  layout: {
    body: { fontFamily: FONTS.pagella, fontSize: 12, lineHeight: 1.5, blockSpacing: 0, paragraphIndent: 18, justify: true, hyphenate: true },
  },
  pageSetup: { margins: { top: 1, right: 1, bottom: 1, left: 1.5 } },
  references: FRUSTRATED_MAGNETISM_REFS,
  citationStyle: "nature",
  html: () =>
    [
      p("<br>", { noIndent: true }),
      p("<br>", { noIndent: true }),
      h(1, run({ size: 24 }, "Emergent Gauge Fields in Frustrated Quantum Magnets"), { align: "center", after: 24 }),
      p(run({ size: 13 }, "<em>A thesis submitted in fulfilment of the requirements for the degree of</em>"), { align: "center", noIndent: true }),
      p(run({ size: 14 }, "<strong>Doctor of Philosophy in Physics</strong>"), { align: "center", noIndent: true, after: 36 }),
      p(run({ size: 14 }, "by"), { align: "center", noIndent: true }),
      p(run({ size: 16 }, "<strong>Mei-Ling Zhou</strong>"), { align: "center", noIndent: true, after: 36 }),
      p(run({ size: 12 }, "Supervisor: Prof. Amara N. Okonkwo<br>Co-supervisor: Dr. Rafael Ortega"), { align: "center", noIndent: true, after: 48 }),
      p(run({ size: 12 }, "Institute for Quantum Matter<br>Faculty of Natural Sciences<br>Halden University"), { align: "center", noIndent: true }),
      p(run({ size: 12 }, "September 2026"), { align: "center", noIndent: true }),
      pageBreak(),
      thesisChapter("Declaration"),
      p(
        "I, Mei-Ling Zhou, declare that this thesis titled “Emergent Gauge Fields in Frustrated Quantum Magnets” and the work presented in it are my own. Where I have consulted the published work of others, this is always clearly attributed. Where I have quoted from the work of others, the source is always given. Parts of Chapters 3 and 4 have been published as journal articles, listed in the publications section."
      ),
      p("<br>Signed: ______________________ &nbsp;&nbsp;&nbsp;&nbsp; Date: ______________", { noIndent: true }),
      pageBreak(),
      thesisChapter("Abstract"),
      p(
        "Frustrated magnets can evade conventional magnetic order down to the lowest temperatures, instead forming highly entangled states described by emergent gauge theories. This thesis develops numerical and experimental tools to identify such states. Chapter 2 introduces a tensor-network method for the pyrochlore lattice that reaches 1,024 sites with controlled truncation errors. Chapter 3 applies it to quantum spin ice and identifies the emergent photon in the dynamical structure factor. Chapter 4 reports measurements on a programmable quantum simulator that reproduce these signatures, and Chapter 5 discusses implications for candidate materials."
      ),
      thesisChapter("Acknowledgements"),
      p(
        "I am deeply grateful to my supervisor, Prof. Amara Okonkwo, for her guidance, patience and unfailing curiosity, and to Dr. Rafael Ortega for countless hours at the whiteboard. I thank the members of the Institute for Quantum Matter for a stimulating environment, and my family for their constant support."
      ),
      pageBreak(),
      toc(2),
      pageBreak(),
      thesisChapter("1&nbsp;&nbsp;Introduction"),
      thesisSection("1.1&nbsp;&nbsp;Frustration and the absence of order"),
      p(
        `In most magnets, interactions between spins drive a transition to an ordered state at low temperature. Frustration — the impossibility of satisfying all interactions at once — can prevent this ${cite("balents2010")}. The canonical example is the triangular Ising antiferromagnet, whose ground state remains disordered with a finite entropy per spin ${cite("wannier1950")}.`
      ),
      thesisSection("1.2&nbsp;&nbsp;Emergent gauge structure"),
      p(`In spin ice, the local constraint that each tetrahedron carries two spins pointing in and two out can be written as a lattice divergence condition,`, { noIndent: true }),
      math(R`\nabla \cdot \mathbf{B} = 0,`, { id: "eq-divergence" }),
      p(
        `identifying the coarse-grained spin field with an emergent magnetic field. Violations of this constraint behave as magnetic monopoles ${cite("castelnovo2008")}, and quantum fluctuations promote the classical Coulomb phase to a U(1) quantum spin liquid ${cite("savary2017")}.`,
        { noIndent: true }
      ),
      thesisSection("1.3&nbsp;&nbsp;Outline of this thesis"),
      ul([
        "<strong>Chapter 2</strong> develops the numerical method.",
        "<strong>Chapter 3</strong> studies the emergent photon in quantum spin ice.",
        "<strong>Chapter 4</strong> reports quantum-simulator experiments.",
        "<strong>Chapter 5</strong> concludes and outlines open problems.",
      ]),
      pageBreak(),
      thesisChapter("Bibliography"),
      bibliography(),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Lab notebook entry

const labNotebook: DocTemplate = {
  id: "lab-notebook",
  name: "Lab notebook entry",
  description: "Objective, procedure checklist, data, sign-off",
  category: "Research",
  docTitle: (today) => `Lab notebook – ${today}`,
  html: (today) =>
    [
      h(1, "Floating-zone growth of Yb₂Ti₂O₇ single crystal"),
      table(
        [
          ["<strong>Entry</strong>", "LN-2026-041", "<strong>Date</strong>", today],
          ["<strong>Project</strong>", "Quantum spin ice — sample synthesis", "<strong>Researcher</strong>", "Mei-Ling Zhou"],
          ["<strong>Location</strong>", "Crystal Growth Lab, Room B214", "<strong>Supervisor</strong>", "Prof. A. N. Okonkwo"],
        ],
        { header: false, rules: "none", shade: (_r, c) => (c % 2 === 0 ? "#f1f5f9" : undefined), widths: [110, 202, 110, 202] }
      ),
      h(2, "Objective"),
      p("Grow a stoichiometric Yb₂Ti₂O₇ single crystal (≥ 30 mm, crack-free) by optical floating zone for neutron scattering at 50 mK, avoiding the Yb-stuffing defects reported for fast growth rates."),
      h(2, "Hypothesis"),
      p(`Reducing the growth rate from 5 mm/h to 1 mm/h under 4 atm O₂ will suppress Yb stuffing (target ${m(R`x < 0.01`)} in Yb${m(R`_{2+x}`)}Ti${m(R`_{2-x}`)}O${m(R`_{7-x/2}`)}) and give a single sharp specific-heat peak near 265 mK.`),
      h(2, "Materials & equipment"),
      table(
        [
          ["Item", "Supplier / model", "Lot / ID", "Notes"],
          ["Yb₂O₃ powder, 99.998%", "Alfa Aesar", "Lot 23B0915", "Dried 900 °C, 12 h"],
          ["TiO₂ (rutile), 99.995%", "Sigma-Aldrich", "Lot MKCQ4417", "Dried 600 °C, 6 h"],
          ["Optical floating-zone furnace", "Crystal Systems FZ-T-4000", "FZ-02", "4 × 300 W lamps"],
          ["Hydrostatic press", "Specac Atlas", "HP-01", "60 MPa, 15 min"],
        ],
        { headerBg: "#e2e8f0" }
      ),
      h(2, "Procedure"),
      tasks([
        [true, "Weigh Yb₂O₃ (15.762 g) and TiO₂ (6.389 g) in 1 : 2 molar ratio; mix in agate mortar for 30 min."],
        [true, "Calcine at 1200 °C for 24 h in air; regrind; repeat twice. Confirm phase purity by powder XRD."],
        [true, "Pack into rubber balloon, press hydrostatically at 60 MPa; sinter rods at 1400 °C for 12 h."],
        [false, "Mount feed and seed rods; purge chamber with O₂ to 4 atm."],
        [false, "Pre-melt feed rod at 15 mm/h; then grow at 1 mm/h with counter-rotation 15 / 15 rpm."],
        [false, "Cool over 6 h; photograph boule; cut 2 mm slice for Laue and specific heat."],
      ]),
      h(2, "Observations"),
      table(
        [
          ["Time", "Lamp power (%)", "Zone temp. (°C)", "Observation"],
          ["09:12", "52.0", "≈ 1780", "Feed rod melting evenly; stable zone formed."],
          ["10:40", "53.5", "≈ 1800", "Slight bubbling at zone top — reduced power 0.5%."],
          ["13:05", "53.0", "≈ 1795", "Zone stable; boule surface glossy and transparent."],
          ["16:30", "53.0", "≈ 1795", "18 mm grown; no visible cracks."],
        ],
        { headerBg: "#e2e8f0" }
      ),
      h(2, "Results"),
      p(`Powder XRD of the calcined precursor indexes to the pyrochlore structure (${m(R`Fd\bar{3}m`)}, ${m(R`a = 10.031(2)`)} Å) with no impurity peaks above 1%. Growth was paused at 18 mm at end of shift; zone re-established without defects on restart.`),
      callout(p("<strong>Key result:</strong> stable zone at 53% lamp power and 1 mm/h — record these as the baseline for the next growth (LN-2026-042)."), "#dcfce7"),
      h(2, "Issues & deviations"),
      ul(["Zone bubbling at 10:40 likely from residual moisture in feed rod — dry rods at 150 °C before mounting next time.", "O₂ pressure drifted from 4.0 to 3.8 atm over 6 h; regulator to be checked."]),
      h(2, "Next steps"),
      tasks([
        [false, "Complete growth to 35 mm (continue tomorrow, 08:30)."],
        [false, "Laue alignment along [111]; book diffractometer for Oct 20."],
        [false, "Specific heat 100 mK – 2 K on PPMS dilution insert."],
      ]),
      hr(),
      table(
        [
          ["Recorded by", "Witnessed by"],
          ["Mei-Ling Zhou &nbsp;·&nbsp; signature: ____________", "Rafael Ortega &nbsp;·&nbsp; signature: ____________"],
        ],
        { rules: "none" }
      ),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Literature review

const literatureReview: DocTemplate = {
  id: "literature-review",
  name: "Literature review",
  description: "Search strategy, evidence table, themes, gaps",
  category: "Research",
  docTitle: () => "Literature review – quantum spin liquids",
  references: FRUSTRATED_MAGNETISM_REFS,
  citationStyle: "nature",
  html: () =>
    [
      h(1, "Literature Review: Order, Disorder and Spin Liquids in Frustrated Magnets"),
      p("<strong>Prepared by:</strong> Mei-Ling Zhou &nbsp;·&nbsp; <strong>For:</strong> Thesis Chapter 1 &nbsp;·&nbsp; <strong>Status:</strong> Draft v2"),
      callout(
        p(
          "<strong>Research question.</strong> Under what conditions do frustrated Ising and Heisenberg magnets avoid conventional order, and which experimental signatures distinguish a quantum spin liquid from a disordered classical state?"
        )
      ),
      h(2, "1. Scope and search strategy"),
      table(
        [
          ["Databases", "Web of Science, INSPIRE-HEP, arXiv (cond-mat.str-el)"],
          ["Search terms", "“frustrated magnet” AND (“spin liquid” OR “order by disorder” OR “spin ice”)"],
          ["Time window", "1950 – 2026; seminal papers included regardless of date"],
          ["Inclusion", "Peer-reviewed theory or experiment on lattice spin models; reviews with > 500 citations"],
          ["Exclusion", "Itinerant magnets; purely mean-field studies without fluctuation analysis"],
          ["Screened / included", "412 records screened → 63 full texts → 7 core papers below"],
        ],
        { header: false, shade: (_r, c) => (c === 0 ? "#f1f5f9" : undefined), widths: [150, 474] }
      ),
      h(2, "2. Evidence summary"),
      caption("table", "Core papers, ordered by year.", "tab-evidence"),
      table(
        [
          ["Study", "Approach", "Key finding", "Relevance"],
          [`Wannier ${cite("wannier1950")}`, "Exact solution", "Triangular Ising AFM has extensive ground-state entropy", "Defines the frustration problem"],
          [`Villain et al. ${cite("villain1980")}`, "Analytical", "Fluctuations can select order from degenerate states", "Origin of “order by disorder”"],
          [`Moessner & Sondhi ${cite("moessner2001")}`, "Mapping + QMC", "Transverse field gives clock order on triangular lattice", "Directly tested in Ch. 4"],
          [`Isakov & Moessner ${cite("isakov2003")}`, "Quantum Monte Carlo", "Phase diagram; XY universality", "Benchmark for our Γ_c"],
          [`Castelnovo et al. ${cite("castelnovo2008")}`, "Theory", "Monopole excitations in spin ice", "Motivates Ch. 3 dynamics"],
          [`Balents ${cite("balents2010")}`, "Review", "Criteria and candidates for spin liquids", "Framing"],
          [`Savary & Balents ${cite("savary2017")}`, "Review", "Field theory of QSLs; experimental probes", "Framing; probes"],
        ],
        { headerBg: "#e0e7ff" }
      ),
      h(2, "3. Themes"),
      h(3, "3.1 Degeneracy and its lifting"),
      p(`The extensive ground-state degeneracy identified by Wannier ${cite("wannier1950")} is fragile: thermal or quantum fluctuations can select a subset of states ${cite("villain1980")}. For the transverse-field triangular model this selection produces a clock phase ${cite("moessner2001", "isakov2003")}.`),
      h(3, "3.2 Emergent gauge fields"),
      p(`Where degeneracy survives, local constraints can generate emergent gauge structure and fractionalised excitations ${cite("castelnovo2008")}, the defining feature of spin liquids ${cite("balents2010", "savary2017")}.`),
      h(2, "4. Gaps and open questions"),
      ol([
        "Few experiments resolve quantum (rather than thermal) order by disorder at large system sizes.",
        "The effect of weak disorder on emergent photons in quantum spin ice remains unsettled.",
        "Programmable simulators have not yet been benchmarked quantitatively against QMC for frustrated models.",
      ]),
      h(2, "References"),
      bibliography(),
    ].join(""),
};

// ---------------------------------------------------------------------------------------------
// Lecture notes

const lectureNotes: DocTemplate = {
  id: "lecture-notes",
  name: "Lecture notes",
  description: "Summary box, definitions, derivations, exercises",
  category: "Research",
  docTitle: (today) => `Lecture notes – ${today}`,
  html: (today) =>
    [
      h(1, "PHYS 412 · Quantum Mechanics II"),
      h(2, "Lecture 7 — Time-Dependent Perturbation Theory"),
      p(`<strong>Date:</strong> ${today} &nbsp;·&nbsp; <strong>Lecturer:</strong> Prof. R. Ortega &nbsp;·&nbsp; <strong>Reading:</strong> Sakurai §5.6–5.7`),
      callout(
        `${p("<strong>Summary.</strong> A weak time-dependent perturbation drives transitions between eigenstates of the unperturbed Hamiltonian. To first order the transition amplitude is the Fourier transform of the matrix element at the Bohr frequency; for a harmonic perturbation this yields Fermi’s golden rule.")}`,
        "#fef9c3"
      ),
      h(3, "1. Set-up"),
      p(`Split the Hamiltonian as ${m(R`\hat H(t) = \hat H_0 + \hat V(t)`)} with known eigenstates ${m(R`\hat H_0 |n\rangle = E_n |n\rangle`)}. Expanding the state in the interaction picture,`),
      math(R`|\psi(t)\rangle = \sum_n c_n(t)\, e^{-iE_n t/\hbar} |n\rangle .`),
      h(3, "2. First-order amplitude"),
      p("Integrating the Schrödinger equation to first order in V gives"),
      math(R`c_f^{(1)}(t) = -\frac{i}{\hbar} \int_0^t \langle f | \hat V(t') | i \rangle\, e^{i\omega_{fi} t'}\, dt', \qquad \omega_{fi} = \frac{E_f - E_i}{\hbar}.`, { id: "eq-first-order" }),
      h(3, "3. Fermi’s golden rule"),
      p(`For ${m(R`\hat V(t) = \hat V e^{-i\omega t} + \text{h.c.}`)} and a continuum of final states with density ${m(R`\rho(E_f)`)}, the transition rate becomes`),
      math(R`\Gamma_{i \to f} = \frac{2\pi}{\hbar}\, |\langle f | \hat V | i \rangle|^2\, \rho(E_f)\, \delta(E_f - E_i - \hbar\omega).`, { id: "eq-golden" }),
      h(3, "Key definitions"),
      table(
        [
          ["Term", "Meaning"],
          ["Interaction picture", "States evolve under V only; operators under H₀"],
          ["Bohr frequency ω_fi", "Energy difference between final and initial state divided by ħ"],
          ["Density of states ρ(E)", "Number of final states per unit energy"],
          ["Selection rule", "Condition for a non-zero matrix element ⟨f|V|i⟩"],
        ],
        { headerBg: "#e2e8f0", widths: [190, 434] }
      ),
      h(3, "Worked example — hydrogen in an oscillating field"),
      p(`For ${m(R`\hat V = e E_0 \hat z \cos\omega t`)}, the matrix element ${m(R`\langle 2p_0 | \hat z | 1s \rangle = \frac{128\sqrt{2}}{243} a_0 \approx 0.745\, a_0`)} is non-zero, while ${m(R`\langle 2s | \hat z | 1s \rangle = 0`)} by parity: only ${m(R`\Delta \ell = \pm 1`)} transitions are allowed in dipole approximation.`),
      h(3, "Exercises"),
      tasks([
        [false, "Derive the first-order amplitude for a constant perturbation switched on at t = 0."],
        [false, "Show that the sinc² function tends to 2πt δ(ω) for large t."],
        [false, "Problem set 4, questions 2 and 5 (due Friday)."],
      ]),
      quote("“The golden rule is neither golden nor a rule — but it works remarkably well.” — overheard in office hours"),
    ].join(""),
};

export const RESEARCH_TEMPLATES: DocTemplate[] = [researchPaper, journalLetter, thesis, labNotebook, literatureReview, lectureNotes];
