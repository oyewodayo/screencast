// utils/templates/researchReferences.ts
//
// A small, real reference library shared by the research templates - genuine, well-known papers
// on frustrated magnetism, so a template's citations and reference list are correct as printed and
// the user can keep or swap them. Ids are the citation keys the templates' data-cite spans use.
import type { BibEntry } from "../docBibliography";

const date = (year: number) => ({ "date-parts": [[year]] });

export const FRUSTRATED_MAGNETISM_REFS: BibEntry[] = [
  {
    id: "wannier1950",
    type: "article-journal",
    title: "Antiferromagnetism. The triangular Ising net",
    author: [{ family: "Wannier", given: "G. H." }],
    "container-title": "Physical Review",
    "container-title-short": "Phys. Rev.",
    volume: "79",
    page: "357–364",
    issued: date(1950),
    DOI: "10.1103/PhysRev.79.357",
  },
  {
    id: "villain1980",
    type: "article-journal",
    title: "Order as an effect of disorder",
    author: [
      { family: "Villain", given: "J." },
      { family: "Bidaux", given: "R." },
      { family: "Carton", given: "J.-P." },
      { family: "Conte", given: "R." },
    ],
    "container-title": "Journal de Physique",
    "container-title-short": "J. Phys. France",
    volume: "41",
    page: "1263–1272",
    issued: date(1980),
    DOI: "10.1051/jphys:0198000410110126300",
  },
  {
    id: "moessner2001",
    type: "article-journal",
    title: "Ising models of quantum frustration",
    author: [
      { family: "Moessner", given: "R." },
      { family: "Sondhi", given: "S. L." },
    ],
    "container-title": "Physical Review B",
    "container-title-short": "Phys. Rev. B",
    volume: "63",
    "article-number": "224401",
    issued: date(2001),
    DOI: "10.1103/PhysRevB.63.224401",
  },
  {
    id: "isakov2003",
    type: "article-journal",
    title: "Interplay of quantum and thermal fluctuations in a frustrated magnet",
    author: [
      { family: "Isakov", given: "S. V." },
      { family: "Moessner", given: "R." },
    ],
    "container-title": "Physical Review B",
    "container-title-short": "Phys. Rev. B",
    volume: "68",
    "article-number": "104409",
    issued: date(2003),
    DOI: "10.1103/PhysRevB.68.104409",
  },
  {
    id: "castelnovo2008",
    type: "article-journal",
    title: "Magnetic monopoles in spin ice",
    author: [
      { family: "Castelnovo", given: "C." },
      { family: "Moessner", given: "R." },
      { family: "Sondhi", given: "S. L." },
    ],
    "container-title": "Nature",
    volume: "451",
    page: "42–45",
    issued: date(2008),
    DOI: "10.1038/nature06433",
  },
  {
    id: "balents2010",
    type: "article-journal",
    title: "Spin liquids in frustrated magnets",
    author: [{ family: "Balents", given: "L." }],
    "container-title": "Nature",
    volume: "464",
    page: "199–208",
    issued: date(2010),
    DOI: "10.1038/nature08917",
  },
  {
    id: "savary2017",
    type: "article-journal",
    title: "Quantum spin liquids: a review",
    author: [
      { family: "Savary", given: "L." },
      { family: "Balents", given: "L." },
    ],
    "container-title": "Reports on Progress in Physics",
    "container-title-short": "Rep. Prog. Phys.",
    volume: "80",
    "article-number": "016502",
    issued: date(2017),
    DOI: "10.1088/0034-4885/80/1/016502",
  },
];
