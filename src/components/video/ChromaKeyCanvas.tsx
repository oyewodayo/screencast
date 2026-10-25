// components/video/ChromaKeyCanvas.tsx
//
// A keyed video-track layer in the preview: draws its <video> through a WebGL shader that makes the
// green (or blue) screen transparent - the same chroma-distance key and spill removal export runs
// with ffmpeg's chromakey + despill (chroma_key_filters, conversion.rs). The maths is chromaKey.ts's,
// line for line, and that is tested against ffmpeg itself, so the edge the preview shows is the
// export's.
//
// The canvas is the video's own size (keying happens per source pixel, as export keys before
// scaling) and is laid out by the parent exactly where the <video> would be; the <video> keeps
// playing underneath (sound, timing) with its opacity at 0. No WebGL -> the plain video shows.
import React, { useEffect, useRef } from "react";
import { clampKey, keyUV, spillType, type ChromaKey } from "../../utils/chromaKey";

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// chromaKey.ts in GLSL: pixelUV (full-range BT.601 chroma, rounded to 8 bits as swscale does),
// keyAlpha over the 3x3 neighbourhood (texels clamped at the edge), despill on the centre pixel.
// Output premultiplied, as the canvas composites.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uTexel;
uniform vec2 uKey;
uniform float uSimilarity;
uniform float uBlend;
uniform float uSpill;
uniform int uBlue;
out vec4 outColor;
vec2 chroma(vec3 c) {
  c *= 255.0;
  float u = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b + 128.0;
  float v = 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b + 128.0;
  return clamp(floor(vec2(u, v) + 0.5), 0.0, 255.0);
}
void main() {
  float diff = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 d = chroma(texture(uFrame, vUv + vec2(float(i), float(j)) * uTexel).rgb) - uKey;
      diff += sqrt((d.x * d.x + d.y * d.y) / (255.0 * 255.0 * 2.0));
    }
  }
  diff /= 9.0;
  float a = uBlend > 0.0001 ? clamp((diff - uSimilarity) / uBlend, 0.0, 1.0) : (diff > uSimilarity ? 1.0 : 0.0);
  vec3 c = texture(uFrame, vUv).rgb;
  if (uSpill > 0.0) {
    if (uBlue == 1) {
      float m = max(c.b - (c.r * 0.5 + c.g * 0.5), 0.0);
      c.b = max(c.b - m * uSpill, 0.0);
    } else {
      float m = max(c.g - (c.r * 0.5 + c.b * 0.5), 0.0);
      c.g = max(c.g - m * uSpill, 0.0);
    }
  }
  outColor = vec4(c * a, a);
}`;

interface GlState {
  gl: WebGL2RenderingContext;
  tex: WebGLTexture;
  u: Record<"uTexel" | "uKey" | "uSimilarity" | "uBlend" | "uSpill" | "uBlue", WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  return shader;
}

function initGl(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Exact texels - the key reads each source pixel and its neighbours, as ffmpeg does.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "uFrame"), 0);
  const loc = (n: string) => gl.getUniformLocation(program, n);
  return { gl, tex, u: { uTexel: loc("uTexel"), uKey: loc("uKey"), uSimilarity: loc("uSimilarity"), uBlend: loc("uBlend"), uSpill: loc("uSpill"), uBlue: loc("uBlue") } };
}

interface ChromaKeyCanvasProps {
  video: HTMLVideoElement | null;
  chromaKey: ChromaKey;
  className?: string;
  style?: React.CSSProperties;
  // Called if WebGL can't run - the caller shows the plain video instead.
  onUnavailable?: () => void;
}

const ChromaKeyCanvas: React.FC<ChromaKeyCanvasProps> = ({ video, chromaKey, className, style, onUnavailable }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<GlState | null>(null);
  const keyRef = useRef(chromaKey);
  keyRef.current = chromaKey;
  // Redraw the paused frame when the key changes (playback redraws on its own).
  const redrawRef = useRef<() => void>(() => {});
  useEffect(() => redrawRef.current(), [chromaKey.color, chromaKey.similarity, chromaKey.blend, chromaKey.spill]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !video) return;
    try {
      glRef.current = glRef.current ?? initGl(canvas);
    } catch (err) {
      console.error("Green-screen preview unavailable (WebGL setup failed):", err);
      glRef.current = null;
    }
    const state = glRef.current;
    if (!state) {
      onUnavailable?.();
      return;
    }
    const previousOpacity = video.style.opacity;
    video.style.opacity = "0";
    let stopped = false;
    const draw = () => {
      if (stopped || video.readyState < 2 || video.videoWidth === 0) return;
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const { gl, tex, u } = state;
      const k = clampKey(keyRef.current);
      const [ku, kv] = keyUV(keyRef.current.color);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (err) {
        console.error("Green-screen preview couldn't read the video frame:", err);
        stopped = true;
        video.style.opacity = previousOpacity;
        onUnavailable?.();
        return;
      }
      gl.uniform2f(u.uTexel, 1 / canvas.width, 1 / canvas.height);
      gl.uniform2f(u.uKey, ku, kv);
      gl.uniform1f(u.uSimilarity, k.similarity);
      gl.uniform1f(u.uBlend, k.blend);
      gl.uniform1f(u.uSpill, k.spill);
      gl.uniform1i(u.uBlue, spillType(keyRef.current.color) === "blue" ? 1 : 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    redrawRef.current = draw;
    // Every new video frame (requestVideoFrameCallback), or every animation frame without it.
    let handle = 0;
    const hasRvfc = "requestVideoFrameCallback" in video;
    const onFrame = () => {
      draw();
      if (stopped) return;
      handle = hasRvfc ? video.requestVideoFrameCallback(onFrame) : requestAnimationFrame(onFrame);
    };
    onFrame();
    video.addEventListener("seeked", draw);
    video.addEventListener("loadeddata", draw);
    return () => {
      stopped = true;
      if (hasRvfc) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("loadeddata", draw);
      video.style.opacity = previousOpacity;
      redrawRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  return <canvas ref={canvasRef} aria-hidden className={className} style={style} />;
};

export default ChromaKeyCanvas;
