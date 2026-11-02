// utils/gradeLuts.ts
//
// Turns a clip's grade (ClipGrade) into its baked LUT - for the live preview (useGradeLut, fed to
// VideoPlayer's WebGL layer) and for export (gradeCubeForClip, the .cube text export_trimmed_video
// hands to ffmpeg's lut3d). Both go through bakeGradeLut with the same inputs, which is the whole
// reason preview and export match. Imported .cube files are read from disk once and cached.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Lut3D, bakeGradeLut, hasGrade, lutToCube, parseCubeLut } from "./colorGrade";
import type { ClipGrade } from "./videoEditTypes";

const userLutCache = new Map<string, Promise<Lut3D>>();

export function loadUserLut(path: string): Promise<Lut3D> {
  let pending = userLutCache.get(path);
  if (!pending) {
    pending = invoke<ArrayBuffer>("read_file_bytes", { path }).then((bytes) => parseCubeLut(new TextDecoder("utf-8").decode(new Uint8Array(bytes))));
    pending.catch(() => userLutCache.delete(path));
    userLutCache.set(path, pending);
  }
  return pending;
}

export async function bakedLutForGrade(grade: ClipGrade | undefined): Promise<Lut3D | null> {
  if (!hasGrade(grade)) return null;
  const userLut = grade.lut && grade.lut.intensity > 0 ? await loadUserLut(grade.lut.path) : null;
  return bakeGradeLut(grade, userLut);
}

// The .cube text a clip exports with, or null when it has no grade.
export async function gradeCubeForClip(grade: ClipGrade | undefined): Promise<string | null> {
  const lut = await bakedLutForGrade(grade);
  return lut ? lutToCube(lut) : null;
}

// The live-preview LUT for whichever grade is on screen; null when there's nothing to grade.
// Re-bakes on every change (a few ms for the 33^3 table), so sliders preview as you drag.
export function useGradeLut(grade: ClipGrade | undefined): Lut3D | null {
  const lutPath = grade?.lut && grade.lut.intensity > 0 ? grade.lut.path : null;
  const [userLut, setUserLut] = useState<{ path: string; lut: Lut3D } | null>(null);
  useEffect(() => {
    if (!lutPath) return;
    let cancelled = false;
    loadUserLut(lutPath)
      .then((lut) => !cancelled && setUserLut({ path: lutPath, lut }))
      .catch((err) => console.error("Couldn't load LUT", lutPath, err));
    return () => {
      cancelled = true;
    };
  }, [lutPath]);
  const key = JSON.stringify(grade ?? null);
  return useMemo(() => {
    if (!hasGrade(grade)) return null;
    const lut = lutPath ? (userLut?.path === lutPath ? userLut.lut : null) : null;
    // Waiting on the LUT file: preview the rest of the grade meanwhile.
    return bakeGradeLut(lutPath && !lut ? { ...grade, lut: undefined } : grade, lut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, userLut]);
}
