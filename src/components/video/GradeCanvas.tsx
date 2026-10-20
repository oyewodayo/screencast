// components/video/GradeCanvas.tsx
//
// The preview's WebGL rendering layer. While the clip on screen has a color grade (colorGrade.ts),
// this canvas takes the <video>'s place: every new video frame is uploaded as a texture and drawn
// through a fragment shader that looks each pixel up in the grade's baked 3D LUT - the exact table
// export hands to ffmpeg's lut3d, sampled with the same trilinear interpolation. The <video> keeps
// playing (sound, timing, every existing control) but is made transparent underneath.
//
// Geometry stays the <video>'s own: crop, Ken Burns and mirror are CSS transforms VideoPlayer
// writes onto the video element every frame, and this layer copies that transform, its origin and
// clip-path (and the color preset's CSS filter) each animation frame, so the canvas lines up pixel
// for pixel.
//
// No grade on screen -> no canvas, no GL context, and the video is shown directly as before.
import React, { useEffect, useRef, useState } from "react";
import { GRADE_BYPASS_EVENT } from "../docker/ColorGradeControls";
import type { Lut3D } from "../../utils/colorGrade";

interface GradeCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  lut: Lut3D | null;
}

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// lutScale/lutOffset map 0..1 onto texel centers, so 0 and 1 hit the first and last grid points
// exactly - the same addressing lut3d uses.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D uFrame;
uniform sampler3D uLut;
uniform float uLutScale;
uniform float uLutOffset;
out vec4 outColor;
void main() {
  vec3 c = clamp(texture(uFrame, vUv).rgb, 0.0, 1.0);
  outColor = vec4(texture(uLut, c * uLutScale + uLutOffset).rgb, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  return shader;
}

interface GlState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  frameTex: WebGLTexture;
  lutTex: WebGLTexture;
  uLutScale: WebGLUniformLocation | null;
  uLutOffset: WebGLUniformLocation | null;
}

function initGl(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: false, antialias: false });
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

  const frameTex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frameTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "uFrame"), 0);

  const lutTex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTex);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "uLut"), 1);

  return { gl, program, frameTex, lutTex, uLutScale: gl.getUniformLocation(program, "uLutScale"), uLutOffset: gl.getUniformLocation(program, "uLutOffset") };
}

const GradeCanvas: React.FC<GradeCanvasProps> = ({ videoRef, lut }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<GlState | null>(null);
  const failedRef = useRef(false);
  // "Hold to compare" (ColorGradeControls) - the ungraded video while held.
  const [bypass, setBypass] = useState(false);
  useEffect(() => {
    const onBypass = (e: Event) => setBypass(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(GRADE_BYPASS_EVENT, onBypass);
    return () => window.removeEventListener(GRADE_BYPASS_EVENT, onBypass);
  }, []);
  const active = !!lut && !bypass;

  // Upload the LUT whenever the grade changes (a 33^3 table - cheap enough per slider move).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!lut || !canvas || failedRef.current) return;
    try {
      if (!glRef.current) glRef.current = initGl(canvas);
    } catch (err) {
      console.error("Color grade preview unavailable (WebGL setup failed):", err);
      failedRef.current = true;
      return;
    }
    const state = glRef.current;
    if (!state) return;
    const { gl } = state;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, state.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
    gl.uniform1f(state.uLutScale, (lut.size - 1) / lut.size);
    gl.uniform1f(state.uLutOffset, 0.5 / lut.size);
  }, [lut]);

  // While graded: hide the video underneath, and redraw on every animation frame - re-uploading the
  // video frame only when it's actually a new one, and mirroring the video's own transform/filter.
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!active || !video || !canvas || failedRef.current) return;
    const previousOpacity = video.style.opacity;
    video.style.opacity = "0";
    let raf = 0;
    let lastTime = -1;
    let lastLut: Lut3D | null = null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const state = glRef.current;
      if (!state) return;
      canvas.style.transform = video.style.transform;
      canvas.style.transformOrigin = video.style.transformOrigin;
      canvas.style.clipPath = video.style.clipPath;
      canvas.style.filter = video.style.filter;
      if (video.readyState < 2 || video.videoWidth === 0) return;
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        lastTime = -1;
      }
      // currentTime changes with every new frame (and seeks); a paused, unchanged frame needs no
      // redraw unless the grade itself changed.
      if (video.currentTime === lastTime && lastLut === lut) return;
      lastTime = video.currentTime;
      lastLut = lut;
      const { gl } = state;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.frameTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (err) {
        // A source the GPU can't read (shouldn't happen - every source is a same-app asset URL):
        // fall back to showing the ungraded video rather than a blank frame.
        console.error("Color grade preview couldn't read the video frame:", err);
        failedRef.current = true;
        video.style.opacity = previousOpacity;
        canvas.style.display = "none";
        cancelAnimationFrame(raf);
        return;
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      video.style.opacity = previousOpacity;
    };
  }, [active, lut, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ objectFit: "contain", display: active && !failedRef.current ? "block" : "none" }}
    />
  );
};

export default GradeCanvas;
