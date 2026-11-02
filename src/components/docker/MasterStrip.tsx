// components/docker/MasterStrip.tsx
//
// The mixer's master strip - the whole mix, where a delivery is judged. It reads the preview's
// master bus (master-bus-processor.js via mixerGraph.readMaster) the way a loudness meter does:
//
//   - Momentary / short-term / integrated loudness (EBU R128, LUFS), the short-term one on a bar
//     against the delivery target, coloured by how close it sits to it.
//   - A scrolling history of the short-term loudness over the last minute with the target drawn
//     through it - the shape of the mix at a glance, the way a loudness radar reads.
//   - True peak per side (dBTP) with a hold, red past the ceiling.
//   - The limiter's gain reduction, live.
//
// and holds the controls that shape the mix as a whole: trim, the limiter (ceiling, release) and
// the delivery target - which is the export's loudness target (Save lands the file exactly on it,
// normalize_loudness), so setting it here and there is the same thing.
import React, { useEffect, useRef, useState } from "react";
import { readMaster, resetMasterLoudness } from "../../utils/mixerGraph";
import { DEFAULT_LIMITER, LOUDNESS_TARGETS, type MasterBus } from "../../utils/masterBus";
import { linearToDb } from "../../utils/audioFx";
import KnobSlider from "./KnobSlider";

interface MasterStripProps {
  master: MasterBus | undefined;
  onChange: (master: MasterBus | undefined) => void;
  // The export's loudness target (LUFS), null = as mixed.
  target: number | null;
  onTargetChange: (lufs: number | null) => void;
}

const HISTORY_SEC = 60;
const SCALE_MIN = -40; // LUFS at the left / bottom of the loudness displays
const SCALE_MAX = 0;
const scaleFraction = (lufs: number) => Math.max(0, Math.min(1, (lufs - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)));
const fmtLufs = (v: number) => (Number.isFinite(v) && v > -70 ? v.toFixed(1) : "–");
const fmtDb = (v: number) => (Number.isFinite(v) && v > -70 ? `${v > 0 ? "+" : ""}${v.toFixed(1)}` : "-∞");

// How close a reading sits to the target: on it (within 1 LU), near (within 3), or off.
const targetTone = (lufs: number, target: number | null) => {
  if (target === null || !Number.isFinite(lufs) || lufs < -70) return "rgb(45,212,191)";
  const off = Math.abs(lufs - target);
  return off <= 1 ? "rgb(52,211,153)" : off <= 3 ? "rgb(251,191,36)" : "rgb(248,113,113)";
};

const MasterStrip: React.FC<MasterStripProps> = ({ master, onChange, target, onTargetChange }) => {
  const limiter = master?.limiter;
  const ceiling = limiter?.ceilingDb ?? -1;
  // Readouts update a few times a second (numbers) - the bars and the history draw every frame.
  const [shown, setShown] = useState({ m: -Infinity, s: -Infinity, i: -Infinity, tpL: -Infinity, tpR: -Infinity, gr: 0 });
  const holdRef = useRef({ l: -Infinity, r: -Infinity });
  const barRef = useRef<HTMLDivElement>(null);
  const grRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLCanvasElement>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const history: { t: number; s: number }[] = [];
    let raf = 0;
    let lastText = 0;
    let lastSample = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const r = readMaster();
      const tpL = linearToDb(r.truePeakL);
      const tpR = linearToDb(r.truePeakR);
      holdRef.current = { l: Math.max(holdRef.current.l, tpL), r: Math.max(holdRef.current.r, tpR) };
      if (barRef.current) {
        barRef.current.style.width = `${(scaleFraction(r.shortTerm) * 100).toFixed(1)}%`;
        barRef.current.style.background = targetTone(r.shortTerm, targetRef.current);
      }
      if (grRef.current) grRef.current.style.width = `${Math.min(100, (Math.max(0, -r.gainReductionDb) / 12) * 100).toFixed(1)}%`;
      if (now - lastSample > 200) {
        lastSample = now;
        history.push({ t: now, s: r.shortTerm });
        while (history.length > 0 && now - history[0].t > HISTORY_SEC * 1000) history.shift();
        drawHistory(historyRef.current, history, now, targetRef.current);
      }
      if (now - lastText > 250) {
        lastText = now;
        setShown({ m: r.momentary, s: r.shortTerm, i: r.integrated, tpL: holdRef.current.l, tpR: holdRef.current.r, gr: r.gainReductionDb });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const update = (patch: Partial<MasterBus>) => onChange({ ...master, ...patch });
  const toTarget = target !== null && Number.isFinite(shown.i) && shown.i > -70 ? target - shown.i : null;
  const overCeiling = (v: number) => v > ceiling + 0.05;

  return (
    <div className="rounded-md ring-1 ring-amber-300/25 bg-gradient-to-b from-amber-300/[0.06] to-transparent px-2 py-2 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="px-1 rounded text-[9px] uppercase tracking-wide font-semibold text-amber-200 bg-amber-300/15">Master</span>
        <span className="text-[11px] text-white/70">The whole mix</span>
        <button
          type="button"
          onClick={() => {
            resetMasterLoudness();
            holdRef.current = { l: -Infinity, r: -Infinity };
          }}
          title="Start the integrated reading and the peak holds over"
          className="ml-auto px-1.5 py-0.5 rounded text-[10px] text-white/60 hover:text-white hover:bg-white/10"
        >
          Reset
        </button>
      </div>

      {/* Loudness: the three readings, the short-term bar against the target, the last minute. */}
      <div className="grid grid-cols-3 gap-1 text-center">
        {(
          [
            ["Momentary", shown.m, "Last 400 ms"],
            ["Short-term", shown.s, "Last 3 s"],
            ["Integrated", shown.i, "Since Reset - what the delivery spec measures"],
          ] as const
        ).map(([label, v, hint]) => (
          <div key={label} className="rounded bg-black/30 py-1" title={hint}>
            <div className="text-[9px] uppercase tracking-wide text-white/40">{label}</div>
            <div className="text-sm tabular-nums font-medium" style={{ color: label === "Integrated" ? targetTone(v, target) : undefined }}>
              {fmtLufs(v)}
            </div>
          </div>
        ))}
      </div>
      <div className="relative h-2 rounded-full bg-white/10 overflow-hidden" title="Short-term loudness, -40 to 0 LUFS">
        <div ref={barRef} className="h-full rounded-full transition-[background] duration-300" style={{ width: 0 }} />
        {target !== null && <div className="absolute inset-y-0 w-0.5 bg-white" style={{ left: `${scaleFraction(target) * 100}%` }} />}
      </div>
      <canvas ref={historyRef} className="w-full h-12 rounded bg-black/40" title="Short-term loudness over the last minute" />
      <div className="flex items-center justify-between text-[10px] text-white/50 -mt-1">
        <span>LUFS · last minute</span>
        {toTarget !== null && (
          <span className="tabular-nums" style={{ color: targetTone(shown.i, target) }}>
            {Math.abs(toTarget) <= 1 ? "On target" : `${toTarget > 0 ? "+" : ""}${toTarget.toFixed(1)} LU to target`} · Save lands it exactly
          </span>
        )}
      </div>

      {/* Delivery target - the export's loudness target. */}
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <span className="text-white/40 mr-0.5">Target</span>
        {[{ id: "off", label: "As mixed", lufs: null as number | null, hint: "No loudness change on Save" }, ...LOUDNESS_TARGETS].map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.lufs === null ? t.hint : `${t.lufs} LUFS integrated - ${t.hint}`}
            onClick={() => onTargetChange(t.lufs)}
            className={`px-1.5 py-0.5 rounded ${target === t.lufs ? "bg-amber-300/20 text-amber-100 ring-1 ring-amber-300/40" : "bg-white/5 text-white/65 hover:text-white hover:bg-white/10"}`}
          >
            {t.label}
            {t.lufs !== null && <span className="text-white/40"> {t.lufs}</span>}
          </button>
        ))}
      </div>

      {/* True peak per side, held. */}
      <div className="flex items-center gap-2 text-[10px]">
        <span className="text-white/40 w-14 shrink-0" title="Peaks between the samples too (4x oversampled) - what a player's DAC actually sees">
          True peak
        </span>
        {(["L", "R"] as const).map((side) => {
          const v = side === "L" ? shown.tpL : shown.tpR;
          return (
            <span key={side} className={`tabular-nums px-1.5 py-0.5 rounded ${overCeiling(v) ? "bg-red-500/25 text-red-200" : "bg-black/30 text-white/75"}`}>
              {side} {fmtDb(v)} dBTP
            </span>
          );
        })}
      </div>

      {/* Limiter. */}
      <div className="flex flex-col gap-1.5 pt-1.5 border-t border-white/10">
        <label className="flex items-center gap-2 text-[11px] cursor-pointer">
          <input type="checkbox" checked={!!limiter} onChange={(e) => update({ limiter: e.target.checked ? limiter ?? DEFAULT_LIMITER : undefined })} className="accent-amber-300" />
          <span className="text-white/80">Limiter</span>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-white/40" title="Gain reduction right now">
            GR
            <span className="relative w-16 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <span ref={grRef} className="absolute right-0 inset-y-0 bg-amber-300" style={{ width: 0 }} />
            </span>
            <span className="w-9 text-right tabular-nums">{shown.gr < -0.05 ? `${shown.gr.toFixed(1)}` : "0.0"}</span>
          </span>
        </label>
        {limiter && (
          <>
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-14 shrink-0 text-white/60">Ceiling</span>
              <KnobSlider tone="amber" min={-6} max={0} step={0.1} value={limiter.ceilingDb} onChange={(v) => update({ limiter: { ...limiter, ceilingDb: v } })} resetTo={-1} />
              <span className="w-14 shrink-0 text-right tabular-nums text-white/60">{limiter.ceilingDb.toFixed(1)} dBTP</span>
            </label>
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-14 shrink-0 text-white/60">Release</span>
              <KnobSlider tone="amber" min={10} max={500} step={5} value={limiter.releaseMs} onChange={(v) => update({ limiter: { ...limiter, releaseMs: v } })} resetTo={60} />
              <span className="w-14 shrink-0 text-right tabular-nums text-white/60">{limiter.releaseMs} ms</span>
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-[11px]">
          <span className="w-14 shrink-0 text-white/60">Trim</span>
          <KnobSlider tone="amber" min={-12} max={12} step={0.1} value={master?.trimDb ?? 0} onChange={(v) => update({ trimDb: v })} resetTo={0} title="The whole mix up or down - double-click for 0 dB" />
          <span className="w-14 shrink-0 text-right tabular-nums text-white/60">{fmtDb(master?.trimDb ?? 0)} dB</span>
        </label>
      </div>
    </div>
  );
};

// The last minute of short-term loudness, newest at the right, with the target through it.
function drawHistory(canvas: HTMLCanvasElement | null, history: { t: number; s: number }[], now: number, target: number | null) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const y = (lufs: number) => h - scaleFraction(lufs) * (h - 2) - 1;
  const x = (t: number) => w - ((now - t) / (HISTORY_SEC * 1000)) * w;
  // Guides every 10 LU.
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let l = -30; l < 0; l += 10) {
    ctx.beginPath();
    ctx.moveTo(0, y(l));
    ctx.lineTo(w, y(l));
    ctx.stroke();
  }
  // The trace, as a filled area so quiet stretches read as gaps.
  ctx.beginPath();
  let open = false;
  for (const p of history) {
    if (!Number.isFinite(p.s) || p.s < SCALE_MIN) {
      if (open) {
        ctx.lineTo(x(p.t), h);
        open = false;
      }
      continue;
    }
    if (!open) {
      ctx.moveTo(x(p.t), h);
      open = true;
    }
    ctx.lineTo(x(p.t), y(p.s));
  }
  if (open) ctx.lineTo(w, h);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, "rgba(251,191,36,0.55)");
  gradient.addColorStop(1, "rgba(251,191,36,0.05)");
  ctx.fillStyle = gradient;
  ctx.fill();
  if (target !== null) {
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(target));
    ctx.lineTo(w, y(target));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export default MasterStrip;
