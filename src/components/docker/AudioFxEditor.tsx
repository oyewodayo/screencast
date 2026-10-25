// components/docker/AudioFxEditor.tsx
//
// One mixer channel's effects: a 3-band EQ (with its response curve), a compressor (with its
// transfer curve) and balance. The curves are drawn from the same maths the preview's worklet and
// the export's ffmpeg filters run (audioFx.ts), so what the picture shows is what is heard.
import React from "react";
import KnobSlider from "./KnobSlider";
import {
  AudioCompressor,
  AudioEq,
  AudioFx,
  COMPRESSOR_PRESETS,
  DEFAULT_COMPRESSOR,
  EQ_PRESETS,
  FLAT_EQ,
  compressorCurveDb,
  eqResponseDb,
  isFlatEq,
  presetMatching,
} from "../../utils/audioFx";

interface AudioFxEditorProps {
  fx: AudioFx | undefined;
  onChange: (fx: AudioFx) => void;
}

const Row: React.FC<{ label: string; value: string; children: React.ReactNode; title?: string }> = ({ label, value, children, title }) => (
  <label className="flex items-center gap-2 text-[11px]" title={title}>
    <span className="w-14 shrink-0 text-white/60">{label}</span>
    {children}
    <span className="w-14 shrink-0 text-right tabular-nums text-white/60">{value}</span>
  </label>
);

const dB = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);

// Log-spaced frequency axis 20 Hz..20 kHz.
const CURVE_W = 220;
const CURVE_H = 64;
const FREQS = Array.from({ length: 96 }, (_, i) => 20 * Math.pow(1000, i / 95));
const EQ_RANGE_DB = 15;

const EqCurve: React.FC<{ eq: AudioEq }> = ({ eq }) => {
  const resp = eqResponseDb(eq, FREQS);
  const y = (db: number) => CURVE_H / 2 - (Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, db)) / EQ_RANGE_DB) * (CURVE_H / 2 - 2);
  const d = resp.map((db, i) => `${i === 0 ? "M" : "L"}${((i / (FREQS.length - 1)) * CURVE_W).toFixed(1)},${y(db).toFixed(1)}`).join(" ");
  const gridX = [100, 1000, 10000].map((f) => (Math.log(f / 20) / Math.log(1000)) * CURVE_W);
  return (
    <svg viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} className="w-full h-16 rounded bg-black/30" role="img" aria-label="EQ response">
      {gridX.map((x) => (
        <line key={x} x1={x} x2={x} y1={0} y2={CURVE_H} stroke="rgba(255,255,255,0.08)" />
      ))}
      <line x1={0} x2={CURVE_W} y1={CURVE_H / 2} y2={CURVE_H / 2} stroke="rgba(255,255,255,0.15)" />
      <path d={`${d} L${CURVE_W},${CURVE_H / 2} L0,${CURVE_H / 2} Z`} fill="rgba(45,212,191,0.15)" />
      <path d={d} fill="none" stroke="rgb(45,212,191)" strokeWidth={1.5} />
    </svg>
  );
};

const CompCurve: React.FC<{ comp: AudioCompressor }> = ({ comp }) => {
  const S = 64;
  const toXY = (db: number) => S - ((db + 60) / 60) * S;
  const pts = Array.from({ length: 61 }, (_, i) => {
    const inDb = -60 + i;
    const out = Math.min(0, compressorCurveDb(comp, inDb));
    return `${i === 0 ? "M" : "L"}${(((inDb + 60) / 60) * S).toFixed(1)},${toXY(out).toFixed(1)}`;
  }).join(" ");
  const tx = ((comp.threshold + 60) / 60) * S;
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="w-16 h-16 shrink-0 rounded bg-black/30" role="img" aria-label="Compressor curve">
      <line x1={0} y1={S} x2={S} y2={0} stroke="rgba(255,255,255,0.12)" />
      <line x1={tx} x2={tx} y1={0} y2={S} stroke="rgba(251,191,36,0.35)" strokeDasharray="2 2" />
      <path d={pts} fill="none" stroke="rgb(251,191,36)" strokeWidth={1.5} />
    </svg>
  );
};

const PresetChips: React.FC<{ options: { id: string; label: string; hint: string }[]; active: string | null; onPick: (id: string) => void }> = ({ options, active, onPick }) => (
  <div className="flex flex-wrap gap-1">
    {options.map((p) => (
      <button
        key={p.id}
        type="button"
        title={p.hint}
        onClick={() => onPick(p.id)}
        className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${active === p.id ? "text-teal-300 bg-teal-500/15 ring-1 ring-teal-400/40" : "text-white/70 bg-white/5 hover:bg-white/10 hover:text-white"}`}
      >
        {p.label}
      </button>
    ))}
  </div>
);

const AudioFxEditor: React.FC<AudioFxEditorProps> = ({ fx, onChange }) => {
  const eq = fx?.eq ?? FLAT_EQ;
  const comp = fx?.compressor;
  const pan = fx?.pan ?? 0;
  const setEq = (patch: Partial<AudioEq>) => onChange({ ...fx, eq: { ...eq, ...patch } });
  const setComp = (patch: Partial<AudioCompressor>) => onChange({ ...fx, compressor: { ...(comp ?? DEFAULT_COMPRESSOR), ...patch } });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-white/40">EQ</span>
          {!isFlatEq(fx?.eq) && (
            <button type="button" onClick={() => onChange({ ...fx, eq: undefined })} className="text-[10px] text-white/45 hover:text-white/80">
              Reset
            </button>
          )}
        </div>
        <EqCurve eq={eq} />
        <PresetChips
          options={EQ_PRESETS}
          active={presetMatching(EQ_PRESETS, fx?.eq) ?? (isFlatEq(fx?.eq) ? "flat" : null)}
          onPick={(id) => onChange({ ...fx, eq: id === "flat" ? undefined : { ...EQ_PRESETS.find((p) => p.id === id)!.eq } })}
        />
        <Row label="Low" value={dB(eq.low)} title="Low shelf at 100 Hz - rumble, boom, warmth">
          <KnobSlider min={-12} max={12} step={0.5} value={eq.low} onChange={(v) => setEq({ low: v })} resetTo={0} />
        </Row>
        <Row label="Mid" value={dB(eq.mid)} title="A bell around the frequency below - presence, honk, mud">
          <KnobSlider min={-12} max={12} step={0.5} value={eq.mid} onChange={(v) => setEq({ mid: v })} resetTo={0} />
        </Row>
        <Row label="Mid at" value={hz(eq.midFreq)}>
          <KnobSlider min={0} max={1} step={0.001} value={Math.log(eq.midFreq / 150) / Math.log(8000 / 150)} onChange={(v) => setEq({ midFreq: Math.round(150 * Math.pow(8000 / 150, v)) })} />
        </Row>
        <Row label="Width" value={`Q ${eq.midQ.toFixed(1)}`} title="Lower = broader bell">
          <KnobSlider min={0.3} max={4} step={0.1} value={eq.midQ} onChange={(v) => setEq({ midQ: v })} />
        </Row>
        <Row label="High" value={dB(eq.high)} title="High shelf at 8 kHz - air, sibilance, hiss">
          <KnobSlider min={-12} max={12} step={0.5} value={eq.high} onChange={(v) => setEq({ high: v })} resetTo={0} />
        </Row>
      </div>

      <div className="flex flex-col gap-1.5 pt-2 border-t border-white/10">
        <label className="flex items-center justify-between gap-2 text-[11px] cursor-pointer" title="Evens out loud and quiet moments">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Compressor</span>
          <input type="checkbox" checked={!!comp} onChange={(e) => onChange({ ...fx, compressor: e.target.checked ? { ...DEFAULT_COMPRESSOR } : undefined })} className="accent-amber-400" />
        </label>
        {comp && (
          <>
            <PresetChips options={COMPRESSOR_PRESETS} active={presetMatching(COMPRESSOR_PRESETS, comp)} onPick={(id) => onChange({ ...fx, compressor: { ...COMPRESSOR_PRESETS.find((p) => p.id === id)!.comp } })} />
            <div className="flex items-start gap-2">
              <CompCurve comp={comp} />
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <Row label="Threshold" value={`${comp.threshold} dB`}>
                  <KnobSlider min={-60} max={0} step={1} value={comp.threshold} onChange={(v) => setComp({ threshold: v })} />
                </Row>
                <Row label="Ratio" value={`${comp.ratio}:1`}>
                  <KnobSlider min={1} max={20} step={0.5} value={comp.ratio} onChange={(v) => setComp({ ratio: v })} />
                </Row>
              </div>
            </div>
            <Row label="Attack" value={`${comp.attack} ms`}>
              <KnobSlider min={1} max={200} step={1} value={comp.attack} onChange={(v) => setComp({ attack: v })} />
            </Row>
            <Row label="Release" value={`${comp.release} ms`}>
              <KnobSlider min={20} max={1000} step={10} value={comp.release} onChange={(v) => setComp({ release: v })} />
            </Row>
            <Row label="Makeup" value={dB(comp.makeup)} title="Brings the level back up after compression">
              <KnobSlider min={0} max={24} step={0.5} value={comp.makeup} onChange={(v) => setComp({ makeup: v })} />
            </Row>
            <Row label="Knee" value={`${comp.knee} dB`} title="How gradually compression starts around the threshold">
              <KnobSlider min={0} max={18} step={1} value={comp.knee} onChange={(v) => setComp({ knee: v })} />
            </Row>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5 pt-2 border-t border-white/10">
        <Row label="Balance" value={Math.abs(pan) < 0.005 ? "Centre" : `${Math.round(Math.abs(pan) * 100)}% ${pan < 0 ? "L" : "R"}`} title="Double-click to centre">
          <KnobSlider min={-1} max={1} step={0.01} value={pan} onChange={(v) => onChange({ ...fx, pan: v })} resetTo={0} />
        </Row>
      </div>
    </div>
  );
};

export default AudioFxEditor;
