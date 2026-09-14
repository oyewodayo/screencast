// components/whiteboard/LatticeGaugeWidget.tsx
//
// The live body of a "latticeGauge" WhiteboardNode (see whiteboardTypes.ts's own doc comment on
// that shapeType) - a small lattice-gauge-theory teaching widget: matter fields (quarks) as colored
// spheres on an N×N×N cubic lattice's sites, gauge fields (gluons) as colored links between
// neighboring sites, rendered with a real WebGL scene (three.js, transparent background) instead
// of the flat SVG/div body every other whiteboard shape gets from shapeOutlineFor. Mounted directly
// by WhiteboardCanvas.tsx in place of that usual shape body.
//
// This file owns ONLY the live 3D view and the one small text readout in its bottom-left corner -
// every actual CONTROL (teaching mode, lattice size/spacing, the three visibility toggles) lives in
// WhiteboardStylePanel.tsx's own "latticeGauge" Field block instead, edited the same way any other
// shape's own parametric fields are (an amplifier's lead length, a function plot's domain scale,
// ...), undo-tracked through the ordinary onEditNode/batchEditNodes path - this component never
// calls onCommit for any of those. The one exception is picking a new plaquette anchor
// (pickPlaquetteAnchor below), which has to happen by clicking an actual site IN the 3D view, so
// that alone still commits from here.
//
// Two kinds of state, same split WhiteboardCanvas.tsx itself makes between the document and its own
// view state (pan/zoom): the lattice's own DATA lives on the WhiteboardNode and is undo-tracked;
// the CAMERA (orbit/zoom/pan) is a pure view preference, kept in a local ref and never persisted -
// reopening this board always starts from the same default angle, the same way WhiteboardEditor's
// own pan/zoom resets per session rather than being saved into the document.
import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  DEFAULT_LATTICE_LINK_WIDTH,
  DEFAULT_LATTICE_SITE_RADIUS,
  DEFAULT_LATTICE_SITE_SPACING,
  DEFAULT_LATTICE_SIZE,
  DEFAULT_LATTICE_SPIN_ARROW_SIZE,
  MAX_LATTICE_LINK_WIDTH,
  MAX_LATTICE_SITE_RADIUS,
  MAX_LATTICE_SITE_SPACING,
  MAX_LATTICE_SIZE,
  MAX_LATTICE_SPIN_ARROW_SIZE,
  MIN_LATTICE_LINK_WIDTH,
  MIN_LATTICE_SITE_RADIUS,
  MIN_LATTICE_SITE_SPACING,
  MIN_LATTICE_SIZE,
  MIN_LATTICE_SPIN_ARROW_SIZE,
  WhiteboardNode,
} from "../../utils/whiteboardTypes";

type SpinModel = "ising" | "xy" | "heisenberg";

export interface LatticeGaugeWidgetProps {
  node: WhiteboardNode;
  // The whiteboard's own ambient zoom (WhiteboardCanvas.tsx's pan/zoom, NOT this widget's own
  // orbit-camera zoom) - divides pointer-drag deltas so orbiting/panning the 3D camera feels the
  // same regardless of how zoomed-in the surrounding diagram canvas happens to be, the same
  // "divide screen deltas by zoom" convention every drag gesture in that file already follows.
  canvasZoom: number;
  // Persists one discrete change as a single ordinary node edit - WhiteboardCanvas.tsx wires this
  // to onEditNode(node, { ...node, ...patch }), the same commit path any other shape-specific
  // style-panel field goes through. In practice this widget only ever calls it for one thing now
  // (see this file's own top comment) - picking a new plaquette anchor by clicking a quark.
  onCommit: (patch: Partial<WhiteboardNode>) => void;
  // A plain click on the 3D view (not a drag - that orbits) selects this node, the same outcome
  // clicking any other shape's own body gets - WhiteboardCanvas.tsx wires this to
  // onSelectionChange(new Set([node.id]), new Set()). Needed because this widget has no other
  // chrome left to click for that (see this file's own top comment) - every other shape's node
  // div does it via its own onPointerDown directly, which this widget's viewport deliberately
  // intercepts (stopPropagation) for orbiting instead.
  onSelect: () => void;
}

// ---- Theme -----------------------------------------------------------------------------------
const SITE_COLOR = new THREE.Color("#e0584a");
// The link fragment shader (LINK_FRAGMENT_SHADER below) carries its own copy of this same color as
// a GLSL literal - the plaquette-highlight blend happens entirely on the GPU (see recolorLattice's
// own doc comment on why), so there's no JS-side buffer that would actually read a THREE.Color
// constant for it.
const LINK_COLOR = new THREE.Color("#2dd4bf");
// Radial segment count for the (potentially many thousands of) gluon-link cylinders - 6 rather
// than the plaquette overlay's 8 since there are only ever 4 of those but there can be ~3*N^3 of
// these; still reads as round at the sizes these render at.
const LINK_RADIAL_SEGMENTS = 6;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---- Pure lattice geometry -------------------------------------------------------------------
// Deliberately free of any THREE.* types - a plain description of where every site/link sits,
// built once per (n, spacing) pair and turned into actual GPU buffers by the component below.
// Sites are indexed i + j*n + k*n*n; links only run in the +x/+y/+z direction from each site (so
// every link is counted exactly once), with each link's two endpoint site indices (linkSites) kept
// for gauge-mode color blending and for positioning its own instanced cylinder (see the geometry-
// rebuild effect's own link-construction block).
interface LatticeGeometry {
  n: number;
  sitePositions: Float32Array; // n^3 * 3
  linkSites: Uint32Array; // numLinks * 2 - [siteA, siteB] per link
  linkOrigin: Int32Array; // numLinks - the site index each link runs FROM (its lower-coordinate end)
  linkAxis: Uint8Array; // numLinks - which axis it runs along, 0=x/1=y/2=z
  numSites: number;
  numLinks: number;
}

function buildLatticeGeometry(n: number, spacing: number): LatticeGeometry {
  const numSites = n * n * n;
  const sitePositions = new Float32Array(numSites * 3);
  const siteIndex = (i: number, j: number, k: number) => i + j * n + k * n * n;
  const coord = (v: number) => (v - (n - 1) / 2) * spacing;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const s = siteIndex(i, j, k) * 3;
        sitePositions[s] = coord(i);
        sitePositions[s + 1] = coord(j);
        sitePositions[s + 2] = coord(k);
      }
    }
  }

  const linkSitePairs: number[] = [];
  const linkOriginList: number[] = [];
  const linkAxisList: number[] = [];
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = siteIndex(i, j, k);
        if (i + 1 < n) {
          linkSitePairs.push(a, siteIndex(i + 1, j, k));
          linkOriginList.push(a);
          linkAxisList.push(0);
        }
        if (j + 1 < n) {
          linkSitePairs.push(a, siteIndex(i, j + 1, k));
          linkOriginList.push(a);
          linkAxisList.push(1);
        }
        if (k + 1 < n) {
          linkSitePairs.push(a, siteIndex(i, j, k + 1));
          linkOriginList.push(a);
          linkAxisList.push(2);
        }
      }
    }
  }

  return {
    n,
    sitePositions,
    linkSites: new Uint32Array(linkSitePairs),
    linkOrigin: new Int32Array(linkOriginList),
    linkAxis: new Uint8Array(linkAxisList),
    numSites,
    numLinks: linkOriginList.length,
  };
}

// Which lattice site (i, j, k) a plaquette highlight is anchored at, clamped to a range that's
// always a valid unit-square corner for the CURRENT lattice size - see WhiteboardNode's own
// latticePlaquetteAnchor doc comment for why this clamps at read time instead of eagerly.
function clampPlaquetteAnchor(anchor: { i: number; j: number; k: number } | undefined, n: number): { i: number; j: number; k: number } {
  const a = anchor ?? { i: 0, j: 0, k: 0 };
  return { i: clamp(Math.round(a.i), 0, n - 2), j: clamp(Math.round(a.j), 0, n - 2), k: clamp(Math.round(a.k), 0, n - 1) };
}

// The highlighted plaquette is always the unit square in the xy-plane anchored at (ai,aj,ak) - see
// WhiteboardNode.latticePlaquetteAnchor's own doc comment for its 4 corners. Expressed as
// (originSiteIndex, axis) pairs matching LatticeGeometry.linkOrigin/linkAxis, so recolorLattice can
// test each link with one Set lookup instead of re-deriving (i,j,k) from a link index every time.
function plaquetteEdgeKeys(anchor: { i: number; j: number; k: number }, n: number): Set<string> {
  const siteIndex = (i: number, j: number, k: number) => i + j * n + k * n * n;
  const { i: ai, j: aj, k: ak } = anchor;
  return new Set([
    `${siteIndex(ai, aj, ak)}:0`, // +x edge from (ai,aj,ak)
    `${siteIndex(ai + 1, aj, ak)}:1`, // +y edge from (ai+1,aj,ak)
    `${siteIndex(ai, aj + 1, ak)}:0`, // +x edge from (ai,aj+1,ak)
    `${siteIndex(ai, aj, ak)}:1`, // +y edge from (ai,aj,ak)
  ]);
}

// World-space endpoints of the highlighted plaquette's 4 edges, in order around the loop - the
// thick amber overlay (see cylinderBetween/rebuildPlaquetteOverlay) is built directly from these,
// and the caption panel's own site/plane readout is built from `anchor` alongside it.
function plaquetteLoopSegments(anchor: { i: number; j: number; k: number }, n: number, spacing: number): [THREE.Vector3, THREE.Vector3][] {
  const coord = (v: number) => (v - (n - 1) / 2) * spacing;
  const point = (i: number, j: number, k: number) => new THREE.Vector3(coord(i), coord(j), coord(k));
  const { i: ai, j: aj, k: ak } = anchor;
  const p00 = point(ai, aj, ak);
  const p10 = point(ai + 1, aj, ak);
  const p11 = point(ai + 1, aj + 1, ak);
  const p01 = point(ai, aj + 1, ak);
  return [
    [p00, p10],
    [p10, p11],
    [p11, p01],
    [p01, p00],
  ];
}

// A thin cylinder mesh spanning a to b - real 3D geometry rather than a fat THREE.Line (WebGL
// ignores gl.lineWidth past 1px on most platforms, ANGLE/Windows included, so a "thick highlight"
// drawn as a wide line would render exactly as thin as every other link) - this is what actually
// makes the plaquette loop read as a bold, unmistakable outline instead of the subtle in-shader
// glow LINK_FRAGMENT_SHADER's own aHighlight blend gives the underlying thin link (kept alongside
// this, not replaced by it, so the two reinforce each other).
function cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const delta = new THREE.Vector3().subVectors(b, a);
  const length = Math.max(delta.length(), 0.0001);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8, 1), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}

// Tiny seeded PRNG (mulberry32) - deterministic per gaugeSeed so re-rendering doesn't reshuffle
// colors on its own, only clicking "Gauge transformation" again (which bumps the seed) does.
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Link flux/highlight shader ----------------------------------------------------------------
// Gluon links are an InstancedMesh of unit cylinders (radius 1, height 1, axis along local +Y) -
// see cylinderBetween's own doc comment for why real 3D geometry rather than a GPU line at all
// (WebGL line width is stuck at ~1px on most platforms, which would make the new adjustable
// "Gluon width" style-panel field a no-op). Each instance is scaled/rotated/positioned to span one
// link (see the geometry-rebuild effect's own link-construction block) - since every instance
// shares the exact same unit-cylinder base geometry, "how far along this link am I" falls straight
// out of the base geometry's own local Y coordinate (-0.5..0.5 -> 0..1) with no extra per-vertex
// attribute needed; aColorA/aColorB/aHighlight are the only custom data, one INSTANCED value each
// (not per-vertex), set by recolorLattice below. The flux travel/highlight pulse math itself is
// identical to what the old per-vertex-line version did, just reading instanced inputs instead.
const LINK_VERTEX_SHADER = `
  attribute vec3 aColorA;
  attribute vec3 aColorB;
  attribute float aHighlight;
  varying float vAlong;
  varying float vHighlight;
  varying vec3 vColorA;
  varying vec3 vColorB;
  void main() {
    vAlong = position.y + 0.5;
    vHighlight = aHighlight;
    vColorA = aColorA;
    vColorB = aColorB;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const LINK_FRAGMENT_SHADER = `
  precision mediump float;
  uniform float uTime;
  uniform float uFlow;
  varying float vAlong;
  varying float vHighlight;
  varying vec3 vColorA;
  varying vec3 vColorB;
  void main() {
    vec3 highlight = vec3(0.976, 0.812, 0.082);
    vec3 base = mix(mix(vColorA, vColorB, vAlong), highlight, vHighlight);
    float travel = mix(1.0, 0.5 + 0.5 * sin((vAlong * 10.0 - uTime * 2.2) * 6.28318530718), uFlow);
    float pulse = mix(1.0, 0.75 + 0.35 * sin(uTime * 3.0), vHighlight);
    gl_FragColor = vec4(base * mix(0.6, 1.5, travel) * pulse, 1.0);
  }
`;

// Recomputes every color (site instance colors + link instance colors) for the CURRENT teaching
// mode/gaugeSeed, without touching geometry topology - called on mount, whenever the lattice is
// rebuilt, and whenever mode/seed/visibility changes. "gauge" mode assigns each site its own
// random hue (seeded by gaugeSeed) and gives each link its two endpoint sites' colors as aColorA/
// aColorB (the GPU linearly interpolates that pair across the cylinder's own length in the
// fragment shader - see LINK_FRAGMENT_SHADER - so this alone is what makes a link "flow" from one
// site's color into the other's).
function recolorLattice(
  geo: LatticeGeometry,
  siteMesh: THREE.InstancedMesh,
  linkColorAAttr: THREE.InstancedBufferAttribute,
  linkColorBAttr: THREE.InstancedBufferAttribute,
  linkHighlightAttr: THREE.InstancedBufferAttribute,
  mode: "free" | "plaquette" | "gauge",
  gaugeSeed: number,
  plaquetteAnchor: { i: number; j: number; k: number }
) {
  if (mode === "gauge") {
    const rng = mulberry32(gaugeSeed);
    const siteColors = new Array<THREE.Color>(geo.numSites);
    const tmp = new THREE.Color();
    for (let s = 0; s < geo.numSites; s++) {
      const hue = rng();
      siteColors[s] = tmp.clone().setHSL(hue, 0.65, 0.55);
      siteMesh.setColorAt(s, siteColors[s]);
    }
    for (let li = 0; li < geo.numLinks; li++) {
      const a = siteColors[geo.linkSites[li * 2]];
      const b = siteColors[geo.linkSites[li * 2 + 1]];
      linkColorAAttr.setXYZ(li, a.r, a.g, a.b);
      linkColorBAttr.setXYZ(li, b.r, b.g, b.b);
    }
  } else {
    for (let s = 0; s < geo.numSites; s++) siteMesh.setColorAt(s, SITE_COLOR);
    for (let li = 0; li < geo.numLinks; li++) {
      linkColorAAttr.setXYZ(li, LINK_COLOR.r, LINK_COLOR.g, LINK_COLOR.b);
      linkColorBAttr.setXYZ(li, LINK_COLOR.r, LINK_COLOR.g, LINK_COLOR.b);
    }
  }

  if (mode === "plaquette") {
    const edgeKeys = plaquetteEdgeKeys(plaquetteAnchor, geo.n);
    for (let li = 0; li < geo.numLinks; li++) {
      linkHighlightAttr.setX(li, edgeKeys.has(`${geo.linkOrigin[li]}:${geo.linkAxis[li]}`) ? 1 : 0);
    }
  } else {
    for (let li = 0; li < geo.numLinks; li++) linkHighlightAttr.setX(li, 0);
  }

  if (siteMesh.instanceColor) siteMesh.instanceColor.needsUpdate = true;
  linkColorAAttr.needsUpdate = true;
  linkColorBAttr.needsUpdate = true;
  linkHighlightAttr.needsUpdate = true;
}

// ---- Spin arrows -------------------------------------------------------------------------------
// Per-site spin direction + color, purely a display convention (see WhiteboardNode.latticeSpinModel's
// own doc comment) - "ising" is the classic two-state up/down spin, colored by sign; "xy" is a
// continuous planar (U(1)) angle, arrows lying flat in the lattice's own xz-plane; "heisenberg" is a
// continuous, fully 3D (O(3)) direction. Both continuous models are hue-colored by their azimuthal
// angle so a glance at color alone already suggests "this one points a different way" before even
// reading the arrow itself.
const SPIN_UP_COLOR = new THREE.Color("#f97316");
const SPIN_DOWN_COLOR = new THREE.Color("#3b82f6");
const ARROW_RADIAL_SEGMENTS = 6;

interface SpinField {
  // numSites * 3 each - a site's own direction/color live at [s*3, s*3+1, s*3+2].
  directions: Float32Array;
  colors: Float32Array;
}

// Writes ONE site's freshly-rolled spin into `directions`/`colors` at index `s` - shared by
// buildSpinField (every site, on a fresh model/seed) and the spin-animation effect (a handful of
// sites at a time, re-rolled with plain Math.random() rather than the seeded rng - see that
// effect's own doc comment for why reproducibility doesn't matter there).
function rollSpin(rng: () => number, model: SpinModel, s: number, directions: Float32Array, colors: Float32Array) {
  const i = s * 3;
  if (model === "ising") {
    const up = rng() < 0.5;
    directions[i] = 0;
    directions[i + 1] = up ? 1 : -1;
    directions[i + 2] = 0;
    const c = up ? SPIN_UP_COLOR : SPIN_DOWN_COLOR;
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
    return;
  }
  const phi = rng() * Math.PI * 2;
  const tmp = new THREE.Color();
  if (model === "xy") {
    directions[i] = Math.cos(phi);
    directions[i + 1] = 0;
    directions[i + 2] = Math.sin(phi);
    tmp.setHSL(phi / (Math.PI * 2), 0.7, 0.55);
  } else {
    const cosTheta = rng() * 2 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    directions[i] = sinTheta * Math.cos(phi);
    directions[i + 1] = cosTheta;
    directions[i + 2] = sinTheta * Math.sin(phi);
    tmp.setHSL(phi / (Math.PI * 2), 0.6, 0.5 + 0.2 * cosTheta);
  }
  colors[i] = tmp.r;
  colors[i + 1] = tmp.g;
  colors[i + 2] = tmp.b;
}

function buildSpinField(numSites: number, model: SpinModel, seed: number): SpinField {
  const rng = mulberry32(seed);
  const directions = new Float32Array(numSites * 3);
  const colors = new Float32Array(numSites * 3);
  for (let s = 0; s < numSites; s++) rollSpin(rng, model, s, directions, colors);
  return { directions, colors };
}

// Arrow shaft/head lengths+radii for a given "Spin arrow size" slider value - shaft:head length
// ratio and head:shaft radius ratio are fixed proportions (an ArrowHelper-like silhouette), only the
// overall scale is user-adjustable.
function spinArrowDims(size: number) {
  const shaftLength = size * 0.65;
  const headLength = size * 0.35;
  const shaftRadius = Math.max(size * 0.07, 0.01);
  const headRadius = shaftRadius * 2.2;
  return { shaftLength, headLength, shaftRadius, headRadius };
}

// Positions/orients/colors ONE site's shaft+head instance pair from its own spin direction - shared
// by the full geometry rebuild, the model/seed recolor effect (every site), and the spin-animation
// effect (just the handful of sites it re-rolled this tick).
function applySpinInstance(
  s: number,
  geo: LatticeGeometry,
  spinField: SpinField,
  dims: ReturnType<typeof spinArrowDims>,
  shaftMesh: THREE.InstancedMesh,
  headMesh: THREE.InstancedMesh,
  dummy: THREE.Object3D,
  up: THREE.Vector3,
  dir: THREE.Vector3,
  color: THREE.Color
) {
  dir.set(spinField.directions[s * 3], spinField.directions[s * 3 + 1], spinField.directions[s * 3 + 2]);
  color.setRGB(spinField.colors[s * 3], spinField.colors[s * 3 + 1], spinField.colors[s * 3 + 2]);
  const bx = geo.sitePositions[s * 3];
  const by = geo.sitePositions[s * 3 + 1];
  const bz = geo.sitePositions[s * 3 + 2];
  dummy.quaternion.setFromUnitVectors(up, dir);

  dummy.position.set(bx + dir.x * (dims.shaftLength / 2), by + dir.y * (dims.shaftLength / 2), bz + dir.z * (dims.shaftLength / 2));
  dummy.scale.set(dims.shaftRadius, dims.shaftLength, dims.shaftRadius);
  dummy.updateMatrix();
  shaftMesh.setMatrixAt(s, dummy.matrix);
  shaftMesh.setColorAt(s, color);

  const headCenter = dims.shaftLength + dims.headLength / 2;
  dummy.position.set(bx + dir.x * headCenter, by + dir.y * headCenter, bz + dir.z * headCenter);
  dummy.scale.set(dims.headRadius, dims.headLength, dims.headRadius);
  dummy.updateMatrix();
  headMesh.setMatrixAt(s, dummy.matrix);
  headMesh.setColorAt(s, color);
}

export default function LatticeGaugeWidget({ node, canvasZoom, onCommit, onSelect }: LatticeGaugeWidgetProps) {
  const n = clamp(node.latticeSize ?? DEFAULT_LATTICE_SIZE, MIN_LATTICE_SIZE, MAX_LATTICE_SIZE);
  const spacing = clamp(node.latticeSiteSpacing ?? DEFAULT_LATTICE_SITE_SPACING, MIN_LATTICE_SITE_SPACING, MAX_LATTICE_SITE_SPACING);
  const siteRadius = clamp(node.latticeSiteRadius ?? DEFAULT_LATTICE_SITE_RADIUS, MIN_LATTICE_SITE_RADIUS, MAX_LATTICE_SITE_RADIUS);
  const linkWidth = clamp(node.latticeLinkWidth ?? DEFAULT_LATTICE_LINK_WIDTH, MIN_LATTICE_LINK_WIDTH, MAX_LATTICE_LINK_WIDTH);
  const showQuarks = node.latticeShowQuarks ?? true;
  const showGluons = node.latticeShowGluons ?? true;
  const animateFlux = node.latticeAnimateFlux ?? true;
  const mode = node.latticeTeachingMode ?? "free";
  const showSpins = node.latticeShowSpins ?? false;
  const spinArrowSize = clamp(node.latticeSpinArrowSize ?? DEFAULT_LATTICE_SPIN_ARROW_SIZE, MIN_LATTICE_SPIN_ARROW_SIZE, MAX_LATTICE_SPIN_ARROW_SIZE);
  const spinModel: SpinModel = node.latticeSpinModel ?? "ising";
  const animateSpins = node.latticeAnimateSpins ?? false;
  // Every one of these lives on the node and is edited from WhiteboardStylePanel.tsx's own
  // "latticeGauge" Field block now (see its own doc comment there) - this widget only ever READS
  // them, plus owns the one thing that has to happen inside the live 3D view itself: picking a new
  // plaquette anchor by clicking a quark (see pickPlaquetteAnchor below).
  const plaquetteAnchor = clampPlaquetteAnchor(node.latticePlaquetteAnchor, n);

  // Re-rolled automatically the moment `mode` freshly becomes "gauge" (see the effect below) -
  // not persisted (a view/demo detail, not diagram content, same "ephemeral" reasoning camera
  // orbit state gets - see this file's own top comment). There's no button left inside this widget
  // to click for a fresh reroll (teaching mode is now a plain <select> in the style panel, which
  // doesn't fire onChange for reselecting its already-current option) - toggling away and back to
  // "Gauge transformation" is what gets a new one now.
  const [gaugeSeed, setGaugeSeed] = useState(() => Math.floor(Math.random() * 1e9) || 1);
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (mode === "gauge" && prevModeRef.current !== "gauge") setGaugeSeed(Math.floor(Math.random() * 1e9) || 1);
    prevModeRef.current = mode;
  }, [mode]);

  // Same "re-roll on fresh entry, not persisted" treatment as gaugeSeed above - turning "Show
  // spins" on gets a newly-randomized configuration each time rather than replaying whatever this
  // session's very first roll happened to be.
  const [spinSeed, setSpinSeed] = useState(() => Math.floor(Math.random() * 1e9) || 1);
  const prevShowSpinsRef = useRef(showSpins);
  useEffect(() => {
    if (showSpins && !prevShowSpinsRef.current) setSpinSeed(Math.floor(Math.random() * 1e9) || 1);
    prevShowSpinsRef.current = showSpins;
  }, [showSpins]);

  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const siteMeshRef = useRef<THREE.InstancedMesh | null>(null);
  // Gluon links - an InstancedMesh of unit cylinders now (see LINK_VERTEX_SHADER's own doc
  // comment), not a LineSegments. The three ...AttrRef refs point at that mesh's own instanced
  // attribute buffers so recolorLattice can be called without needing to re-look them up from the
  // geometry every time (both the "N/spacing/radius/width changed, full rebuild" effect and the
  // "just mode/seed/anchor changed, recolor only" effect call it).
  const linkMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const linkMaterialRef = useRef<THREE.ShaderMaterial | null>(null);
  const linkColorARef = useRef<THREE.InstancedBufferAttribute | null>(null);
  const linkColorBRef = useRef<THREE.InstancedBufferAttribute | null>(null);
  const linkHighlightRef = useRef<THREE.InstancedBufferAttribute | null>(null);
  // Spin arrows - a shaft + head InstancedMesh pair (one instance per site each), same "unit
  // geometry scaled/rotated per instance" trick the gluon links use (see LINK_VERTEX_SHADER's own
  // doc comment) rather than three's own ArrowHelper (a Group of non-instanced Line+Cone objects -
  // fine for a handful of arrows, not for up to 262,144 sites). spinFieldRef holds the current
  // per-site direction/color CPU-side (see SpinField) so the spin-animation effect below can
  // re-roll a handful of sites without recomputing the rest.
  const arrowShaftMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const arrowHeadMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const spinFieldRef = useRef<SpinField | null>(null);
  const latticeRef = useRef<LatticeGeometry | null>(null);
  const prevExtentRef = useRef<number>(0);
  // Which N the camera was last auto-refit for - see the geometry-rebuild effect's own comment on
  // why the refit only ever fires again once THIS changes, not on every rebuild (spacing alone
  // rebuilds the geometry too, just without touching the camera).
  const prevNRef = useRef<number>(0);
  const [webglError, setWebglError] = useState(false);
  // The thick amber loop overlay (see cylinderBetween's own doc comment for why it's real 3D
  // geometry, not a wide line) - one shared Group/Material created once at mount, repopulated with
  // fresh cylinder meshes whenever the highlighted plaquette or the lattice's own size/spacing
  // changes (see rebuildPlaquetteOverlay), visibility toggled by teaching mode alone.
  const plaquetteGroupRef = useRef<THREE.Group | null>(null);
  const plaquetteMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null);

  // Orbit/pan/zoom camera state - a view preference, never written to the document (see this
  // file's own top comment). Spherical coordinates around `target`; the animation loop below
  // reads this every frame and positions the camera from it.
  const orbitRef = useRef({ azimuth: Math.PI / 4, polar: Math.PI * 0.36, radius: 10, target: new THREE.Vector3(0, 0, 0) });
  const dragRef = useRef<{ mode: "orbit" | "pan"; lastX: number; lastY: number; distance: number } | null>(null);
  const basisRightRef = useRef(new THREE.Vector3());
  const basisUpRef = useRef(new THREE.Vector3());
  const basisForwardRef = useRef(new THREE.Vector3());

  // ---- Mount: renderer/scene/camera/lights, the rAF loop, and resize tracking - runs exactly
  // once per mounted widget instance (empty deps), never re-run by prop changes. ------------------
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      // preserveDrawingBuffer: true - without it, WebGL is free to discard the drawing buffer
      // right after compositing each frame, so a canvas.drawImage/toDataURL call made well after
      // the animation loop's last render() (e.g. from an "Export PNG" click, seconds later) can
      // read back blank. See whiteboardHandlers.ts's renderNode "latticeGauge" branch, which is
      // exactly that kind of later, unrelated read - it's what makes the exported PNG show this
      // node's actual live 3D view instead of just its shapeOutlineFor placeholder glyph.
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power", preserveDrawingBuffer: true });
    } catch {
      setWebglError(true);
      return;
    }
    // Fully transparent clear (alpha 0) - this widget has no backdrop of its own any more; the
    // scene sits directly on the whiteboard canvas's own background, same as any other shape's
    // body would show the canvas through wherever it has no fill.
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // display:block - a bare <canvas> defaults to inline, which leaves a few px of baseline
    // whitespace below it inside this flex child and can trip a stray scrollbar.
    renderer.domElement.style.display = "block";
    // The exact lookup key whiteboardHandlers.ts's renderNode uses to find this live canvas at
    // export time (see its own "latticeGauge" branch) - see this effect's own preserveDrawingBuffer
    // comment for why that read is even reliable. node.id is stable for this widget instance's
    // whole lifetime (WhiteboardCanvas.tsx keys the node div by it, so an id change remounts this
    // component entirely rather than re-running this effect), so setting it once at mount here
    // never needs to be kept in sync afterward.
    renderer.domElement.setAttribute("data-lattice-node-id", node.id);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    // Ambient-dominant (rather than a realistic key+fill balance) so every site sphere reads close
    // to its true color from any orbit angle - this is a diagram, not a physically lit render, and
    // a sphere that goes near-black on its unlit side just because the user rotated away from the
    // one directional light would read as a rendering bug, not a shading choice.
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(5, 7, 6);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
    fillLight.position.set(-6, -3, -4);
    scene.add(fillLight);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    cameraRef.current = camera;

    // Unlit (MeshBasicMaterial) so the highlight reads as a flat, unmistakable annotation color
    // rather than something the scene's own lights could dim - see cylinderBetween's own doc
    // comment for why this is real geometry instead of a wide line.
    const plaquetteMaterial = new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true });
    plaquetteMaterialRef.current = plaquetteMaterial;
    const plaquetteGroup = new THREE.Group();
    plaquetteGroup.visible = false;
    scene.add(plaquetteGroup);
    plaquetteGroupRef.current = plaquetteGroup;

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w <= 0 || h <= 0) return;
      // updateStyle defaults to true here (deliberately NOT passing false) - it sets the canvas'
      // own CSS width/height to (w, h) while the drawing BUFFER is separately sized by pixelRatio,
      // which is what makes the canvas's on-page layout box actually match its flex container
      // instead of ballooning to its (pixelRatio-scaled) drawing-buffer pixel count.
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let raf = 0;
    const animate = () => {
      const orbit = orbitRef.current;
      const x = orbit.target.x + orbit.radius * Math.sin(orbit.polar) * Math.cos(orbit.azimuth);
      const y = orbit.target.y + orbit.radius * Math.cos(orbit.polar);
      const z = orbit.target.z + orbit.radius * Math.sin(orbit.polar) * Math.sin(orbit.azimuth);
      camera.position.set(x, y, z);
      camera.up.set(0, 1, 0);
      camera.lookAt(orbit.target);
      const t = performance.now() / 1000;
      if (linkMaterialRef.current) linkMaterialRef.current.uniforms.uTime.value = t;
      // Pulses regardless of the group's own visibility - cheap (one float), and simpler than
      // gating it on teaching mode for no real benefit.
      plaquetteMaterial.opacity = 0.75 + 0.25 * Math.sin(t * 3.0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      siteMeshRef.current?.geometry.dispose();
      (siteMeshRef.current?.material as THREE.Material | undefined)?.dispose();
      linkMeshRef.current?.geometry.dispose();
      linkMaterialRef.current?.dispose();
      arrowShaftMeshRef.current?.geometry.dispose();
      (arrowShaftMeshRef.current?.material as THREE.Material | undefined)?.dispose();
      arrowHeadMeshRef.current?.geometry.dispose();
      (arrowHeadMeshRef.current?.material as THREE.Material | undefined)?.dispose();
      plaquetteGroupRef.current?.children.forEach((child) => (child as THREE.Mesh).geometry.dispose());
      plaquetteMaterialRef.current?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      siteMeshRef.current = null;
      linkMeshRef.current = null;
      linkMaterialRef.current = null;
      linkColorARef.current = null;
      linkColorBRef.current = null;
      linkHighlightRef.current = null;
      arrowShaftMeshRef.current = null;
      arrowHeadMeshRef.current = null;
      spinFieldRef.current = null;
      plaquetteGroupRef.current = null;
      plaquetteMaterialRef.current = null;
    };
  }, []);

  // Clears and repopulates the plaquette overlay group with 4 fresh cylinder meshes for the
  // CURRENT highlighted loop - called both when the lattice itself is rebuilt (corner positions
  // moved) and whenever just the anchor/mode changes (no rebuild needed, just new geometry for the
  // same 4 segments) - see the two call sites below.
  const rebuildPlaquetteOverlay = useCallback((rebuildN: number, rebuildSpacing: number, anchor: { i: number; j: number; k: number }) => {
    const group = plaquetteGroupRef.current;
    const material = plaquetteMaterialRef.current;
    if (!group || !material) return;
    while (group.children.length > 0) {
      const child = group.children.pop() as THREE.Mesh;
      child.geometry.dispose();
    }
    const radius = rebuildSpacing * 0.045;
    for (const [a, b] of plaquetteLoopSegments(anchor, rebuildN, rebuildSpacing)) {
      group.add(cylinderBetween(a, b, radius, material));
    }
  }, []);

  // ---- Rebuild geometry whenever N, spacing, quark size, or gluon width changes --------------------
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (siteMeshRef.current) {
      scene.remove(siteMeshRef.current);
      siteMeshRef.current.geometry.dispose();
      (siteMeshRef.current.material as THREE.Material).dispose();
    }
    if (linkMeshRef.current) {
      scene.remove(linkMeshRef.current);
      linkMeshRef.current.geometry.dispose();
      linkMaterialRef.current?.dispose();
    }
    if (arrowShaftMeshRef.current) {
      scene.remove(arrowShaftMeshRef.current);
      arrowShaftMeshRef.current.geometry.dispose();
      (arrowShaftMeshRef.current.material as THREE.Material).dispose();
    }
    if (arrowHeadMeshRef.current) {
      scene.remove(arrowHeadMeshRef.current);
      arrowHeadMeshRef.current.geometry.dispose();
      (arrowHeadMeshRef.current.material as THREE.Material).dispose();
    }

    const geo = buildLatticeGeometry(n, spacing);
    latticeRef.current = geo;

    const sphereGeo = new THREE.SphereGeometry(siteRadius, 16, 12);
    // An InstancedMesh with a per-instance color (siteMesh.setColorAt below) forces three.js's
    // USE_COLOR shader define on REGARDLESS of the material's own vertexColors setting - it's
    // tied to instanceColor being non-null, not to this flag (see WebGLProgram's own instancingColor
    // param) - and once USE_COLOR is on, the vertex shader unconditionally declares and multiplies
    // by a per-VERTEX `color` attribute too, on top of the per-instance one. SphereGeometry has no
    // such attribute of its own, so that reference would silently read WebGL's default disabled-
    // attribute value (0,0,0) and multiply every site black regardless of its instance color - an
    // all-white per-vertex color here makes that extra multiply a no-op, leaving instanceColor as
    // the only thing actually tinting each sphere.
    sphereGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(sphereGeo.attributes.position.count * 3).fill(1), 3));
    const siteMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
    const siteMesh = new THREE.InstancedMesh(sphereGeo, siteMaterial, geo.numSites);
    const dummy = new THREE.Object3D();
    for (let s = 0; s < geo.numSites; s++) {
      dummy.position.set(geo.sitePositions[s * 3], geo.sitePositions[s * 3 + 1], geo.sitePositions[s * 3 + 2]);
      dummy.updateMatrix();
      siteMesh.setMatrixAt(s, dummy.matrix);
    }
    siteMesh.instanceMatrix.needsUpdate = true;
    siteMesh.visible = showQuarks;
    scene.add(siteMesh);
    siteMeshRef.current = siteMesh;

    // Gluon links - one InstancedMesh of unit cylinders (radius 1, height 1, local +Y axis), each
    // instance transformed to span exactly one link (position = midpoint, scale.y = its actual
    // length, scale.x/z = linkWidth, rotation aligns local +Y to the link's own direction) - see
    // LINK_VERTEX_SHADER's own doc comment for why one shared unit geometry is enough (no per-link
    // geometry needed) and cylinderBetween's for why cylinders instead of GPU lines at all.
    const linkUnitGeo = new THREE.CylinderGeometry(1, 1, 1, LINK_RADIAL_SEGMENTS, 1);
    const linkColorA = new THREE.InstancedBufferAttribute(new Float32Array(geo.numLinks * 3), 3);
    const linkColorB = new THREE.InstancedBufferAttribute(new Float32Array(geo.numLinks * 3), 3);
    const linkHighlight = new THREE.InstancedBufferAttribute(new Float32Array(geo.numLinks), 1);
    linkUnitGeo.setAttribute("aColorA", linkColorA);
    linkUnitGeo.setAttribute("aColorB", linkColorB);
    linkUnitGeo.setAttribute("aHighlight", linkHighlight);
    linkColorARef.current = linkColorA;
    linkColorBRef.current = linkColorB;
    linkHighlightRef.current = linkHighlight;

    const linkMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFlow: { value: animateFlux ? 1 : 0 } },
      vertexShader: LINK_VERTEX_SHADER,
      fragmentShader: LINK_FRAGMENT_SHADER,
    });
    const linkMesh = new THREE.InstancedMesh(linkUnitGeo, linkMaterial, geo.numLinks);
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    for (let li = 0; li < geo.numLinks; li++) {
      const siteA = geo.linkSites[li * 2];
      const siteB = geo.linkSites[li * 2 + 1];
      const ax = geo.sitePositions[siteA * 3];
      const ay = geo.sitePositions[siteA * 3 + 1];
      const az = geo.sitePositions[siteA * 3 + 2];
      const bx = geo.sitePositions[siteB * 3];
      const by = geo.sitePositions[siteB * 3 + 1];
      const bz = geo.sitePositions[siteB * 3 + 2];
      dir.set(bx - ax, by - ay, bz - az);
      const length = Math.max(dir.length(), 0.0001);
      dir.normalize();
      dummy.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      dummy.scale.set(linkWidth, length, linkWidth);
      dummy.quaternion.setFromUnitVectors(up, dir);
      dummy.updateMatrix();
      linkMesh.setMatrixAt(li, dummy.matrix);
    }
    linkMesh.instanceMatrix.needsUpdate = true;
    linkMesh.visible = showGluons;
    scene.add(linkMesh);
    linkMeshRef.current = linkMesh;
    linkMaterialRef.current = linkMaterial;

    // Spin arrows - see this file's own "Spin arrows" section above. Freshly rolled here (rather
    // than reusing spinFieldRef.current) since this effect also runs whenever N changes, which
    // changes numSites itself and would otherwise leave a stale-length SpinField behind.
    const spinField = buildSpinField(geo.numSites, spinModel, spinSeed);
    spinFieldRef.current = spinField;
    const dims = spinArrowDims(spinArrowSize);
    const arrowShaftGeo = new THREE.CylinderGeometry(1, 1, 1, ARROW_RADIAL_SEGMENTS, 1);
    arrowShaftGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(arrowShaftGeo.attributes.position.count * 3).fill(1), 3));
    const arrowHeadGeo = new THREE.ConeGeometry(1, 1, ARROW_RADIAL_SEGMENTS);
    arrowHeadGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(arrowHeadGeo.attributes.position.count * 3).fill(1), 3));
    const arrowShaftMesh = new THREE.InstancedMesh(arrowShaftGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 }), geo.numSites);
    const arrowHeadMesh = new THREE.InstancedMesh(arrowHeadGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 }), geo.numSites);
    const arrowDir = new THREE.Vector3();
    const arrowColor = new THREE.Color();
    for (let s = 0; s < geo.numSites; s++) {
      applySpinInstance(s, geo, spinField, dims, arrowShaftMesh, arrowHeadMesh, dummy, up, arrowDir, arrowColor);
    }
    arrowShaftMesh.instanceMatrix.needsUpdate = true;
    arrowHeadMesh.instanceMatrix.needsUpdate = true;
    if (arrowShaftMesh.instanceColor) arrowShaftMesh.instanceColor.needsUpdate = true;
    if (arrowHeadMesh.instanceColor) arrowHeadMesh.instanceColor.needsUpdate = true;
    arrowShaftMesh.visible = showSpins;
    arrowHeadMesh.visible = showSpins;
    scene.add(arrowShaftMesh);
    scene.add(arrowHeadMesh);
    arrowShaftMeshRef.current = arrowShaftMesh;
    arrowHeadMeshRef.current = arrowHeadMesh;

    recolorLattice(geo, siteMesh, linkColorA, linkColorB, linkHighlight, mode, gaugeSeed, plaquetteAnchor);
    rebuildPlaquetteOverlay(n, spacing, plaquetteAnchor);
    if (plaquetteGroupRef.current) plaquetteGroupRef.current.visible = mode === "plaquette";

    // Re-fit the camera's distance ONLY when N itself changed (including the very first build) -
    // a bigger lattice genuinely needs the camera further back to still fit in frame. Deliberately
    // does NOT run for a spacing-only change: spacing is supposed to visibly spread the sites out
    // or pull them in, and scaling the camera distance by that same factor - which an earlier
    // version of this effect did unconditionally - exactly cancels that out on screen (the lattice
    // gets physically bigger/smaller in world units, but the camera backs away/closes in by the
    // identical ratio, so the projected size never visibly changes at all). Letting a spacing
    // change actually resize the lattice on screen, and leaving the user to scroll-zoom afterward
    // if they want, is what makes the slider do anything perceptible. Quark size/gluon width never
    // touch it either - those change how thick things look, not how far apart they are.
    const extent = Math.max(1, (n - 1) * spacing);
    const orbit = orbitRef.current;
    if (prevNRef.current !== n) {
      if (prevExtentRef.current <= 0) {
        orbit.radius = extent * 1.7 + 2;
      } else {
        orbit.radius = clamp(orbit.radius * (extent / prevExtentRef.current), 1, 400);
      }
      prevNRef.current = n;
    }
    prevExtentRef.current = extent;

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, spacing, siteRadius, linkWidth, spinArrowSize]);

  // ---- Instant (no rebuild) updates: visibility + mode/seed recolor + flux uniform ---------------
  useEffect(() => {
    if (siteMeshRef.current) siteMeshRef.current.visible = showQuarks;
  }, [showQuarks]);
  useEffect(() => {
    if (linkMeshRef.current) linkMeshRef.current.visible = showGluons;
  }, [showGluons]);
  useEffect(() => {
    if (linkMaterialRef.current) linkMaterialRef.current.uniforms.uFlow.value = animateFlux ? 1 : 0;
  }, [animateFlux]);
  useEffect(() => {
    if (arrowShaftMeshRef.current) arrowShaftMeshRef.current.visible = showSpins;
    if (arrowHeadMeshRef.current) arrowHeadMeshRef.current.visible = showSpins;
  }, [showSpins]);

  // Re-rolls every site's spin (not just a rebuild - the geometry/instance COUNT doesn't change,
  // just each one's own direction/color) whenever the spin model or its seed changes, without
  // paying for a full site/link mesh rebuild (see the geometry-rebuild effect above for why THAT one
  // also has to do this once on its own, for the N-changed case).
  useEffect(() => {
    const geo = latticeRef.current;
    const shaftMesh = arrowShaftMeshRef.current;
    const headMesh = arrowHeadMeshRef.current;
    if (!geo || !shaftMesh || !headMesh) return;
    const spinField = buildSpinField(geo.numSites, spinModel, spinSeed);
    spinFieldRef.current = spinField;
    const dims = spinArrowDims(spinArrowSize);
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const color = new THREE.Color();
    for (let s = 0; s < geo.numSites; s++) applySpinInstance(s, geo, spinField, dims, shaftMesh, headMesh, dummy, up, dir, color);
    shaftMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    if (shaftMesh.instanceColor) shaftMesh.instanceColor.needsUpdate = true;
    if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;
  }, [spinModel, spinSeed, spinArrowSize]);

  // "Animate spins" - a cheap, purely illustrative suggestion of live flip dynamics, NOT an actual
  // Metropolis/Monte-Carlo simulation (no coupling, no temperature, no energy is computed - see
  // WhiteboardNode.latticeAnimateSpins's own doc comment). On an interval, re-rolls a small, fixed-
  // size batch of random sites (bounded regardless of lattice size, so this stays cheap even at
  // MAX_LATTICE_SIZE) with plain Math.random() - deliberately NOT the seeded rng spinSeed drives,
  // since reproducibility would defeat the point of looking alive - and only touches THOSE
  // instances' own matrix/color rather than looping over every site each tick.
  useEffect(() => {
    if (!animateSpins) return;
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const color = new THREE.Color();
    const rng = Math.random;
    const interval = window.setInterval(() => {
      // Read every ref fresh each tick (not captured at effect-setup time) - the geometry-rebuild
      // effect can swap latticeRef.current/arrowShaftMeshRef.current/arrowHeadMeshRef.current out
      // for brand-new objects at any point while this interval is running (e.g. dragging the "Site
      // spacing" slider), and this effect's own deps (below) deliberately don't include n/spacing/
      // spinArrowSize - tearing the whole interval down and recreating it on every slider tick
      // during a drag would be wasteful. Reading refs fresh instead means a rebuild elsewhere is
      // picked up on this interval's very next tick for free. Capturing `geo` (or the mesh refs)
      // ONCE here instead, the way an earlier version of this effect did, silently kept animating
      // sites against the OLD, no-longer-rendered lattice's site positions after a spacing change -
      // each tick would re-plant a handful of arrows back at their pre-change world coordinates,
      // and after enough ticks nearly every arrow had been dragged back out of place even though
      // the quark/gluon meshes (rebuilt fresh, untouched by this loop) tracked the new spacing fine.
      const geo = latticeRef.current;
      const shaftMesh = arrowShaftMeshRef.current;
      const headMesh = arrowHeadMeshRef.current;
      const spinField = spinFieldRef.current;
      if (!geo || !shaftMesh || !headMesh || !spinField) return;
      const dims = spinArrowDims(spinArrowSize);
      const flipsPerTick = Math.min(24, geo.numSites);
      for (let f = 0; f < flipsPerTick; f++) {
        const s = Math.floor(rng() * geo.numSites);
        rollSpin(rng, spinModel, s, spinField.directions, spinField.colors);
        applySpinInstance(s, geo, spinField, dims, shaftMesh, headMesh, dummy, up, dir, color);
      }
      shaftMesh.instanceMatrix.needsUpdate = true;
      headMesh.instanceMatrix.needsUpdate = true;
      if (shaftMesh.instanceColor) shaftMesh.instanceColor.needsUpdate = true;
      if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;
    }, 180);
    return () => window.clearInterval(interval);
  }, [animateSpins, spinModel, spinArrowSize]);

  useEffect(() => {
    const geo = latticeRef.current;
    const siteMesh = siteMeshRef.current;
    const colorA = linkColorARef.current;
    const colorB = linkColorBRef.current;
    const highlight = linkHighlightRef.current;
    if (!geo || !siteMesh || !colorA || !colorB || !highlight) return;
    recolorLattice(geo, siteMesh, colorA, colorB, highlight, mode, gaugeSeed, plaquetteAnchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, gaugeSeed, plaquetteAnchor.i, plaquetteAnchor.j, plaquetteAnchor.k]);

  // Moving/re-entering the plaquette highlight never needs a full lattice rebuild - just fresh
  // cylinder geometry for the loop's own 4 segments (rebuildPlaquetteOverlay) and a visibility
  // flip. Separate from the geometry-rebuild effect above (which ALSO calls
  // rebuildPlaquetteOverlay, for the case where N/spacing themselves just changed) so picking a
  // new anchor while N is untouched doesn't pay for rebuilding the whole site/link mesh pair.
  useEffect(() => {
    rebuildPlaquetteOverlay(n, spacing, plaquetteAnchor);
    if (plaquetteGroupRef.current) plaquetteGroupRef.current.visible = mode === "plaquette";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, plaquetteAnchor.i, plaquetteAnchor.j, plaquetteAnchor.k]);

  // ---- Viewport pointer/wheel handling: hand-rolled orbit/pan/zoom (not three's OrbitControls
  // addon) so this file keeps full control over stopPropagation - every one of these must stop the
  // gesture from reaching WhiteboardCanvas.tsx's own container handlers, or dragging to orbit would
  // also pan the whole diagram / marquee-select underneath this node. ------------------------------
  const handleViewportPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { mode: e.button === 2 ? "pan" : "orbit", lastX: e.clientX, lastY: e.clientY, distance: 0 };
  }, []);

  const handleViewportPointerMove = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      const drag = dragRef.current;
      if (!drag) return;
      const rawDx = e.clientX - drag.lastX;
      const rawDy = e.clientY - drag.lastY;
      drag.distance += Math.hypot(rawDx, rawDy);
      const dx = rawDx / canvasZoom;
      const dy = rawDy / canvasZoom;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      const orbit = orbitRef.current;
      if (drag.mode === "orbit") {
        orbit.azimuth -= dx * 0.008;
        orbit.polar = clamp(orbit.polar - dy * 0.008, 0.08, Math.PI - 0.08);
      } else {
        const camera = cameraRef.current;
        if (!camera) return;
        camera.matrixWorld.extractBasis(basisRightRef.current, basisUpRef.current, basisForwardRef.current);
        const panScale = orbit.radius * 0.0016;
        orbit.target.addScaledVector(basisRightRef.current, -dx * panScale);
        orbit.target.addScaledVector(basisUpRef.current, dy * panScale);
      }
    },
    [canvasZoom]
  );

  // Raycasts a click against the site InstancedMesh and, if it hit a quark, moves the plaquette
  // highlight to the xy-plane loop anchored there - "clicking the lattice" is how a user actually
  // walks the Wilson-loop explanation across different faces instead of being stuck with a single
  // fixed corner. Only reachable in "plaquette" mode (see handleViewportPointerUp) - a click in
  // "free"/"gauge" mode does nothing beyond what it already does (orbit-drag).
  const pickPlaquetteAnchor = useCallback(
    (clientX: number, clientY: number) => {
      const camera = cameraRef.current;
      const siteMesh = siteMeshRef.current;
      const container = mountRef.current;
      const geo = latticeRef.current;
      if (!camera || !siteMesh || !container || !geo || !siteMesh.visible) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(siteMesh)[0];
      if (!hit || hit.instanceId === undefined) return;
      const id = hit.instanceId;
      const gn = geo.n;
      const i = id % gn;
      const j = Math.floor(id / gn) % gn;
      const k = Math.floor(id / (gn * gn));
      // Clamped the same way clampPlaquetteAnchor reads it back - clicking a quark on the lattice's
      // own far edge (i or j === n-1) anchors the loop at the last VALID corner short of it, rather
      // than silently picking a different, unrelated site the click didn't land on.
      onCommit({ latticePlaquetteAnchor: { i: Math.min(i, gn - 2), j: Math.min(j, gn - 2), k } });
    },
    [onCommit]
  );

  const handleViewportPointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      const drag = dragRef.current;
      const wasClick = !drag || drag.distance <= 4;
      dragRef.current = null;
      if (!wasClick || e.button === 2) return;
      // A plain click always selects this node first (there's no separate drag-handle chrome left
      // to click on - see this file's own top comment on why every control, including position,
      // is edited from WhiteboardStylePanel.tsx now) - orbiting/panning never reaches here (that's
      // a real drag, caught by the `!wasClick` return above), so this can't fight with them.
      onSelect();
      if (mode === "plaquette") pickPlaquetteAnchor(e.clientX, e.clientY);
    },
    [mode, onSelect, pickPlaquetteAnchor]
  );

  const handleViewportWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    e.preventDefault();
    orbitRef.current.radius = clamp(orbitRef.current.radius * Math.exp(e.deltaY * 0.0012), 1, 400);
  }, []);

  const totalSites = n * n * n;

  return (
    // No fill/border of its own any more (see this file's own top comment) - the 3D scene sits
    // directly on the whiteboard canvas's own background via the renderer's transparent clear
    // color (see the mount effect's own comment on that), and every control that used to live in
    // an embedded side panel here now lives in WhiteboardStylePanel.tsx's "latticeGauge" Field
    // block instead, reached the same way any other shape's fields are: select this node.
    <div className="w-full h-full relative select-none">
      <div
        ref={mountRef}
        className="absolute inset-0 overflow-hidden"
        style={{ cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" }}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        onWheel={handleViewportWheel}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          // Right-drag pans (see handleViewportPointerDown) - suppress the OS context menu that
          // would otherwise pop up on release, same as WhiteboardCanvas.tsx's own space-drag/
          // alt-drag pan tool never triggering one either. Selection still happens for a real
          // right-click (see WhiteboardCanvas.tsx's own onContextMenu on the outer node div, which
          // this bubbles up to since it's not stopped here).
          e.preventDefault();
        }}
      >
        {webglError && (
          <div className="absolute inset-0 flex items-center justify-center text-center text-[11px] text-gray-500 dark:text-neutral-400 px-4">
            WebGL is unavailable in this window - the lattice can't be rendered here.
          </div>
        )}
      </div>

      {/* Every bit of text this widget displays lives in this one bottom-left readout - a small
          translucent, theme-aware backing (not a solid box) just behind the text for legibility
          over whatever's rendered behind it, not a container for the whole shape. pointer-events
          none so it never steals a click/drag meant for the 3D view underneath - including the
          click-to-move-plaquette gesture the last block's own hint describes. */}
      <div className="absolute left-2 bottom-2 max-w-[80%] pointer-events-none">
        <div className="inline-block rounded px-2 py-1.5 bg-white/80 dark:bg-neutral-900/75 backdrop-blur-[2px] font-mono text-[9.5px] leading-relaxed text-gray-600 dark:text-neutral-400">
          <div className="text-[10px] font-semibold" style={{ color: "#0d9488" }}>
            LATTICE::GAUGE <span className="font-normal text-gray-500 dark:text-neutral-500">· {n}×{n}×{n} · {totalSites} sites</span>
          </div>
          <div className="mt-0.5">drag to orbit · scroll to zoom · right-drag to pan</div>
          {mode === "plaquette" && (
            <div className="mt-1.5 pt-1.5 border-t border-gray-300/70 dark:border-neutral-700/70 max-w-[280px]">
              <div className="font-semibold" style={{ color: "#b45309" }}>
                Plaquette U□ — plane (x,y) at site ({plaquetteAnchor.i}, {plaquetteAnchor.j}, {plaquetteAnchor.k})
              </div>
              <div className="mt-0.5">Loop: Ux(n) · Uy(n+x̂) · Ux†(n+ŷ) · Uy†(n)</div>
              <div className="mt-1">
                This ordered product of 4 link matrices is the smallest closed Wilson loop. Tr[U□] is gauge-invariant — the lattice stand-in for the field strength F_μν; 1 −
                Re Tr[U□]/3 is (up to constants) the Wilson gauge action on this face.
              </div>
              <div className="mt-1 text-gray-500 dark:text-neutral-500">Click any quark above to move this plaquette.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
