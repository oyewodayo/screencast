// The phone app's studio tabs - Remote, Voice-over, Prompter and Beam - served by phone_transfer.rs
// as /studio.js next to phone_transfer_page.html, which hands it a small bridge (window.BC: send,
// on, toast, queue, haptic) over the same socket and uploads as everything else.
//
// One house style runs through all four: the three "cast arcs" of Briefcast's logo. They pulse as
// the on-air tally, fill one by one for a count-in, ripple with a voice, and radiate when something
// is beamed. Everything animates with CSS or requestAnimationFrame, and the microphone is only open
// while a take is rolling or VoicePace is listening.
(() => {
  const BC = window.BC;
  if (!BC) return;
  const $ = (id) => document.getElementById(id);
  const fmtClock = (secs) => {
    const s = Math.max(0, Math.floor(secs));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`;
  };

  // ---- The cast arcs: a dot and three quarter-arcs, as in the logo. Each arc can be lit on its own.
  const ARCS = `<svg class="arcs" viewBox="0 0 48 48" aria-hidden="true"><circle cx="11" cy="37" r="4.2"/>` +
    [11, 20, 29].map((r, i) => `<path class="a${i + 1}" d="M11 ${37 - r} A${r} ${r} 0 0 1 ${11 + r} 37"/>`).join("") + `</svg>`;
  document.querySelectorAll("[data-arcs]").forEach((el) => (el.innerHTML = ARCS));
  const lightArcs = (el, n) => el && el.querySelectorAll("path").forEach((p, i) => p.classList.toggle("lit", i < n));

  // ---- Keep the screen awake while a studio tab is in use (a remote that dims mid-take is no remote).
  let wakeLock = null;
  let prompterOpen = false; // the Prompter's full-screen view (below)
  const wantAwake = () => ["remote", "voice", "prompter"].includes(BC.tab()) || prompterOpen || !!cam;
  async function syncWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (wantAwake() && document.visibilityState === "visible") {
      if (!wakeLock) try { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } catch (_) {}
    } else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", syncWakeLock);
  BC.on("tab", syncWakeLock);

  // ---- The desktop's state, mirrored (Dashboard sends it as "remote_state").
  let pc = { recording: false, paused: false, elapsedMs: 0, canSwitchView: false, view: "screen", editing: null, playing: false, time: 0, duration: 0, canUndo: false, canRedo: false, mode: "sva", cameraSource: "none", phoneCam: "waiting" };
  let pcAt = performance.now();
  const recElapsed = () => (pc.elapsedMs + (pc.recording && !pc.paused ? performance.now() - pcAt : 0)) / 1000;
  const playTime = () => Math.min(pc.duration, pc.time + (pc.playing ? (performance.now() - pcAt) / 1000 : 0));

  BC.on("remote_state", (m) => {
    const was = pc;
    pc = { ...pc, ...(m.state || {}) };
    pcAt = performance.now();
    if (was.recording !== pc.recording) {
      BC.haptic(pc.recording ? [40, 60, 40] : [80]);
      if (pc.recording) prompterAutoStart(); else prompterAutoStop();
    }
    paintRemote();
    paintVoice();
  });
  BC.on("disconnected", () => { pc = { ...pc, recording: false, editing: null, playing: false, phoneCam: "waiting" }; paintRemote(); paintVoice(); });

  // ---- Tally: while the computer records, the whole phone says so - on every tab.
  function paintTally() {
    const on = pc.recording && BC.connected();
    document.body.classList.toggle("onair", on && !pc.paused);
    document.body.classList.toggle("onair-paused", on && pc.paused);
    $("onair").hidden = !on;
    if (on) $("onair-time").textContent = fmtClock(recElapsed());
  }
  setInterval(() => { paintTally(); if (pc.recording && BC.tab() === "remote") $("rec-time").textContent = fmtClock(recElapsed()); if (pc.playing && BC.tab() === "remote") paintPadTime(); }, 250);

  // ---- Count-in: three arcs fill, one per second, each with a tap of the haptic engine. Tap to cancel.
  function countIn(label) {
    return new Promise((resolve) => {
      const el = $("countin");
      $("countin-label").textContent = label;
      el.hidden = false;
      const arcs = el.querySelector(".arcs");
      let n = 3, timer = 0;
      const step = () => {
        if (n === 0) { finish(true); return; }
        $("countin-num").textContent = n;
        lightArcs(arcs, 4 - n);
        BC.haptic(n === 1 ? 60 : 30);
        n--; timer = setTimeout(step, 1000);
      };
      const finish = (go) => { clearTimeout(timer); el.hidden = true; el.onclick = null; lightArcs(arcs, 0); resolve(go); };
      el.onclick = () => finish(false);
      step();
    });
  }

  // =============================== Remote ===============================
  const MODE_WORDS = { sva: "screen + camera", sa: "screen + mic", s: "the screen", va: "camera + mic", v: "the camera", a: "audio" };
  const recMain = $("rec-main");
  function paintRemote() {
    paintTally();
    const connected = BC.connected();
    recMain.classList.toggle("live", pc.recording);
    recMain.disabled = !connected;
    $("rec-label").textContent = pc.recording ? (pc.paused ? "Paused" : "Recording") : "Ready";
    $("rec-time").textContent = pc.recording ? fmtClock(recElapsed()) : "0:00";
    $("rec-hint").textContent = !connected ? "Connect to your computer to use the remote."
      : pc.recording ? "Hold to stop" : `Tap to record ${MODE_WORDS[pc.mode] || "on " + BC.host()}${cam && CAMERA_MODES.includes(pc.mode) ? " from this phone" : ""}`;
    $("rec-pause").hidden = !pc.recording;
    $("rec-pause").classList.toggle("on", pc.paused);
    $("rec-pause").setAttribute("aria-label", pc.paused ? "Resume" : "Pause");
    $("rec-view").hidden = !pc.canSwitchView;
    $("rec-view-label").textContent = pc.view === "camera" ? "Camera" : "Screen";
    paintModes();
    $("pad-card").hidden = !pc.editing;
    $("pad-empty").hidden = !!pc.editing || !connected;
    if (pc.editing) {
      $("pad-name").textContent = pc.editing;
      $("pad").classList.toggle("playing", pc.playing);
      $("undo").disabled = !pc.canUndo; $("redo").disabled = !pc.canRedo;
      paintPadTime();
    }
  }
  function paintPadTime() {
    const t = playTime();
    $("pad-time").textContent = `${fmtClock(t)} / ${fmtClock(pc.duration)}`;
    $("pad-progress").style.width = pc.duration ? `${(t / pc.duration) * 100}%` : "0";
  }

  // Start: a count-in first, so you're ready when it rolls. Stop: hold - a pocket tap never ends a take.
  let holdTimer = 0;
  recMain.addEventListener("pointerdown", (e) => {
    if (!pc.recording || recMain.disabled) return;
    e.preventDefault();
    recMain.classList.add("holding");
    holdTimer = setTimeout(() => {
      recMain.classList.remove("holding");
      BC.send({ type: "remote", action: "record.toggle" });
      BC.haptic([30, 40, 90]);
    }, 750);
  });
  const cancelHold = () => { clearTimeout(holdTimer); recMain.classList.remove("holding"); };
  recMain.addEventListener("pointerup", cancelHold);
  recMain.addEventListener("pointerleave", cancelHold);
  recMain.addEventListener("pointercancel", cancelHold);
  recMain.addEventListener("click", async () => {
    if (pc.recording || recMain.disabled) return;
    if (await countIn("Recording starts")) BC.send({ type: "remote", action: "record.toggle" });
  });
  $("rec-pause").addEventListener("click", () => { BC.haptic(20); BC.send({ type: "remote", action: "record.pause" }); });
  $("rec-view").addEventListener("click", () => { BC.haptic(20); BC.send({ type: "remote", action: "view.toggle" }); });
  $("undo").addEventListener("click", () => { BC.haptic(12); BC.send({ type: "remote", action: "undo" }); });
  $("redo").addEventListener("click", () => { BC.haptic(12); BC.send({ type: "remote", action: "redo" }); });

  // The touch pad: tap plays or pauses, a swipe scrubs - each 70px is another 5 seconds.
  const pad = $("pad");
  let padStart = null;
  pad.addEventListener("pointerdown", (e) => { padStart = { x: e.clientX, t: performance.now() }; pad.setPointerCapture(e.pointerId); });
  pad.addEventListener("pointermove", (e) => {
    if (!padStart) return;
    const steps = Math.max(-8, Math.min(8, Math.trunc((e.clientX - padStart.x) / 70)));
    $("pad-ghost").textContent = steps ? `${steps > 0 ? "+" : "−"}${Math.abs(steps) * 5}s` : "";
  });
  pad.addEventListener("pointerup", (e) => {
    if (!padStart) return;
    const dx = e.clientX - padStart.x;
    padStart = null;
    $("pad-ghost").textContent = "";
    const steps = Math.max(-8, Math.min(8, Math.trunc(dx / 70)));
    if (Math.abs(dx) < 12) { BC.haptic(15); BC.send({ type: "remote", action: "play.toggle" }); return; }
    for (let i = 0; i < Math.abs(steps); i++) BC.send({ type: "remote", action: "seek", value: Math.sign(steps) * 5 });
    if (steps) BC.haptic(10);
  });
  pad.addEventListener("pointercancel", () => { padStart = null; $("pad-ghost").textContent = ""; });

  // ---- What to record, and with which camera - mirrored both ways with the computer's own picker.
  const CAMERA_MODES = ["sva", "va", "v"];
  document.querySelectorAll("#rec-modes .mode").forEach((b) => b.addEventListener("click", () => {
    if (pc.recording || b.disabled) return;
    pc.mode = b.dataset.mode; // shown at once; the computer's next state confirms it
    BC.haptic(10);
    BC.send({ type: "remote", action: "record.mode", value: b.dataset.mode });
    // A mode with no camera doesn't need this phone's camera on - and the computer gets its own back.
    if (cam && !CAMERA_MODES.includes(pc.mode)) stopPhoneCam(true);
    paintRemote();
  }));
  document.querySelectorAll("#cam-src button").forEach((b) => b.addEventListener("click", () => {
    if (pc.recording || b.disabled) return;
    BC.haptic(10);
    if (b.dataset.src === "phone") startPhoneCam(); else stopPhoneCam(true);
  }));
  // The mode changed on the computer to one with no camera: same as picking it here.
  BC.on("remote_state", () => { if (cam && !pc.recording && !CAMERA_MODES.includes(pc.mode)) stopPhoneCam(true); });
  function paintModes() {
    const connected = BC.connected();
    document.querySelectorAll("#rec-modes .mode").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === pc.mode);
      b.setAttribute("aria-checked", String(b.dataset.mode === pc.mode));
      b.disabled = !connected || pc.recording;
    });
    const wantsCamera = CAMERA_MODES.includes(pc.mode);
    $("cam-src").hidden = !connected || !wantsCamera;
    const usingPhone = !!cam || pc.cameraSource === "phone";
    document.querySelectorAll("#cam-src button").forEach((b) => {
      b.classList.toggle("on", (b.dataset.src === "phone") === usingPhone);
      b.disabled = pc.recording;
    });
    $("vf").hidden = !cam;
    $("vf-controls").hidden = !cam;
    if (cam) {
      const live = pc.phoneCam === "live";
      $("vf-badge").classList.toggle("live", live);
      $("vf-status").textContent = live ? (pc.recording ? "ON AIR" : `Live on ${BC.host()}`) : "Connecting…";
      $("vf-quality").disabled = pc.recording; // a new resolution mid-take would break the file
    }
  }

  // ---- This phone as the camera. Its video goes over WebRTC straight to the computer (the same
  // path Briefcast's phone camera has always used - phone_camera.rs relays only the handshake), and
  // the computer records it like any camera. The viewfinder keeps the take honest: what you see is
  // what it gets, with a rule-of-thirds grid and the tally ring while recording - and the camera's
  // own controls (zoom, light, brightness, focus) for whatever this particular phone supports.
  const CAM_KEY = "briefcast-camera";
  let camPrefs = { quality: "hd", grid: true };
  try { camPrefs = { ...camPrefs, ...JSON.parse(localStorage.getItem(CAM_KEY) || "{}") }; } catch (_) {}
  const saveCamPrefs = () => { try { localStorage.setItem(CAM_KEY, JSON.stringify(camPrefs)); } catch (_) {} };
  const QUALITY = { hd: [1280, 720, "HD"], fhd: [1920, 1080, "Full HD"] };
  let cam = null; // { stream, peer, facing, caps, zoom, torch }

  async function openCamera(facing) {
    const [w, h] = QUALITY[camPrefs.quality] || QUALITY.hd;
    const base = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
    // "exact" first so a flip really flips; phones that report facing loosely get the plain hint.
    try { return await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { exact: facing } }, audio: false }); }
    catch (_) { return await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: facing }, audio: false }); }
  }

  async function startPhoneCam() {
    if (cam) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) { BC.toast("This browser can't share its camera"); return; }
    if (!window.isSecureContext) { BC.toast("The camera needs the encrypted connection - open Briefcast from its secure address"); return; }
    let stream;
    try { stream = await openCamera("user"); }
    catch (_) { BC.toast("Allow the camera to use this phone as Briefcast's camera"); return; }
    cam = { stream, peer: null, facing: "user", caps: {}, zoom: 1, torch: false };
    showStream(stream, "user");
    BC.send({ type: "remote", action: "camera.source", value: "phone" });
    paintModes();
    syncWakeLock();
    // The computer starts listening for a phone camera as it switches over - give it a moment.
    const t0 = performance.now();
    while (cam && pc.cameraSource !== "phone" && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 60));
    if (cam) offerCamera();
  }
  async function offerCamera() {
    if (!cam) return;
    if (cam.peer) try { cam.peer.close(); } catch (_) {}
    BC.send({ type: "cam.hello" });
    // Both ends are on the same network by construction: host candidates connect directly, and
    // it works with no internet at all.
    const peer = new RTCPeerConnection({ iceServers: [] });
    cam.peer = peer;
    cam.stream.getTracks().forEach((t) => peer.addTrack(t, cam.stream));
    peer.onicecandidate = (e) => { if (e.candidate) BC.send({ type: "cam.signal", data: JSON.stringify({ type: "ice", candidate: e.candidate.toJSON() }) }); };
    try {
      // A steady picture over a sharp one that stutters: room for detail, never more than Wi-Fi gives.
      const sender = peer.getSenders().find((s) => s.track && s.track.kind === "video");
      const params = sender.getParameters();
      if (params.encodings && params.encodings.length) {
        params.encodings[0].maxBitrate = camPrefs.quality === "fhd" ? 8_000_000 : 4_000_000;
        params.encodings[0].maxFramerate = 30;
      }
      params.degradationPreference = "maintain-framerate";
      await sender.setParameters(params).catch(() => {});
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      BC.send({ type: "cam.signal", data: JSON.stringify({ type: "offer", sdp: offer.sdp }) });
    } catch (_) { BC.toast("Couldn't start the camera link"); }
  }
  function stopPhoneCam(backToComputer) {
    if (cam) {
      BC.send({ type: "cam.signal", data: JSON.stringify({ type: "bye" }) });
      BC.send({ type: "cam.bye" });
      try { cam.peer && cam.peer.close(); } catch (_) {}
      cam.stream.getTracks().forEach((t) => t.stop());
      $("vf-video").srcObject = null;
      cam = null;
    }
    if (backToComputer) BC.send({ type: "remote", action: "camera.source", value: "pc" });
    paintModes();
    syncWakeLock();
  }
  BC.on("cam.signal", async (m) => {
    if (!cam || !cam.peer) return;
    let msg; try { msg = JSON.parse(m.data); } catch (_) { return; }
    try {
      if (msg.type === "answer") await cam.peer.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      else if (msg.type === "ice" && msg.candidate) await cam.peer.addIceCandidate(msg.candidate);
    } catch (_) {}
  });
  // Back after a dropped connection: the computer forgot the old link, so offer a fresh one.
  BC.on("connected", () => { if (cam) offerCamera(); });

  // A new stream into the viewfinder (and onto the live link, with no renegotiation - the computer
  // never sees a gap), then the controls this camera actually has.
  async function showStream(stream, facing) {
    const v = $("vf-video");
    v.srcObject = stream;
    v.classList.toggle("selfie", facing === "user");
    const track = stream.getVideoTracks()[0];
    const sender = cam.peer && cam.peer.getSenders().find((s) => s.kind === "video" || (s.track && s.track.kind === "video"));
    if (sender) await sender.replaceTrack(track).catch(() => {});
    cam.stream = stream; cam.facing = facing; cam.torch = false;
    cam.zoom = (track.getSettings && track.getSettings().zoom) || 1;
    cam.caps = (track.getCapabilities && track.getCapabilities()) || {};
    paintCamControls();
  }
  // Reopens the camera - flip, or a new resolution. Many phones can run only one camera at a time,
  // so the current one is released first; if the other won't open, the one that worked comes back.
  async function reopenCamera(facing) {
    if (!cam || cam.busy) return;
    cam.busy = true;
    const vf = $("vf");
    vf.classList.add("flipping");
    const was = cam.facing;
    cam.stream.getTracks().forEach((t) => t.stop());
    try {
      showStream(await openCamera(facing), facing);
      BC.haptic(12);
    } catch (_) {
      try { showStream(await openCamera(was), was); BC.toast(facing !== was ? "This phone has only one camera available here" : "Couldn't change the camera"); }
      catch (_) { cam.busy = false; vf.classList.remove("flipping"); stopPhoneCam(true); BC.toast("The camera stopped - tap This phone to start it again"); return; }
    }
    setTimeout(() => vf.classList.remove("flipping"), 220);
    cam.busy = false;
  }
  $("vf-flip").addEventListener("click", () => cam && reopenCamera(cam.facing === "user" ? "environment" : "user"));
  $("vf-quality").addEventListener("click", () => {
    if (!cam || pc.recording) return;
    camPrefs.quality = camPrefs.quality === "hd" ? "fhd" : "hd";
    saveCamPrefs();
    reopenCamera(cam.facing).then(() => { if (cam) offerCamera(); }); // a new bitrate ceiling to match
  });
  $("vf-grid").addEventListener("click", () => { camPrefs.grid = !camPrefs.grid; saveCamPrefs(); paintCamControls(); BC.haptic(8); });
  $("vf-torch").addEventListener("click", async () => {
    if (!cam || !cam.caps.torch) return;
    const on = !cam.torch;
    try { await cam.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }); cam.torch = on; BC.haptic(10); }
    catch (_) { BC.toast("The light isn't available on this camera"); }
    paintCamControls();
  });
  $("vf-exp").addEventListener("input", (e) => {
    if (!cam || !cam.caps.exposureCompensation) return;
    cam.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ exposureCompensation: Number(e.target.value) }] }).catch(() => {});
  });

  // Zoom: lens chips like a camera app (0.5× when the phone has an ultra-wide), plus pinch, with a
  // haptic detent as it passes 1× and 2×.
  let zoomRaf = 0, zoomWanted = 1;
  function setZoom(z, fromPinch) {
    const c = cam && cam.caps.zoom;
    if (!c) return;
    z = Math.max(c.min, Math.min(c.max, z));
    for (const stop of [1, 2]) if ((cam.zoom - stop) * (z - stop) < 0 && fromPinch) BC.haptic(8);
    cam.zoom = z; zoomWanted = z;
    $("vf-zoomtip").textContent = `${z < 10 ? z.toFixed(1) : Math.round(z)}×`;
    $("vf-zoomtip").classList.add("show");
    clearTimeout(setZoom.tip); setZoom.tip = setTimeout(() => $("vf-zoomtip").classList.remove("show"), 900);
    paintZoomChips();
    if (!zoomRaf) zoomRaf = requestAnimationFrame(() => {
      zoomRaf = 0;
      if (cam) cam.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: zoomWanted }] }).catch(() => {});
    });
  }
  function paintZoomChips() {
    const box = $("vf-zoom"), c = cam && cam.caps.zoom;
    box.hidden = !c || c.max <= 1;
    if (box.hidden) return;
    const stops = [c.min < 0.95 ? Math.max(c.min, 0.5) : null, 1, c.max >= 2 ? 2 : null, c.max >= 5 ? 5 : null].filter((x) => x != null);
    if (box.dataset.stops !== stops.join()) {
      box.dataset.stops = stops.join();
      box.innerHTML = "";
      for (const s of stops) {
        const b = document.createElement("button"); b.type = "button"; b.dataset.z = s;
        b.textContent = (s < 1 ? ".5" : s) + "×";
        b.addEventListener("click", () => { setZoom(s); BC.haptic(10); });
        box.appendChild(b);
      }
    }
    const nearest = stops.reduce((a, b) => (Math.abs(b - cam.zoom) < Math.abs(a - cam.zoom) ? b : a), stops[0]);
    box.querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.z) === nearest));
  }
  function paintCamControls() {
    if (!cam) return;
    const c = cam.caps;
    $("vf").classList.toggle("nogrid", !camPrefs.grid);
    $("vf-grid").classList.toggle("on", camPrefs.grid);
    $("vf-torch").hidden = !c.torch;
    $("vf-torch").classList.toggle("on", cam.torch);
    $("vf-quality").textContent = (QUALITY[camPrefs.quality] || QUALITY.hd)[2];
    const exp = c.exposureCompensation;
    $("vf-exp-row").hidden = !exp;
    if (exp) {
      const el = $("vf-exp");
      el.min = exp.min; el.max = exp.max; el.step = exp.step || 0.1;
      const cur = cam.stream.getVideoTracks()[0].getSettings().exposureCompensation;
      el.value = cur != null ? cur : 0;
    }
    paintZoomChips();
  }

  // Pinch to zoom, tap to focus (where the camera can) - on the viewfinder itself.
  const vfEl = $("vf"), touches = new Map();
  let pinch = null;
  vfEl.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input")) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: false });
    vfEl.setPointerCapture(e.pointerId);
    if (touches.size === 2 && cam) {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: cam.zoom };
    }
  });
  vfEl.addEventListener("pointermove", (e) => {
    const p = touches.get(e.pointerId);
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) p.moved = true;
    p.x = e.clientX; p.y = e.clientY;
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d)), true);
    }
  });
  const endTouch = async (e) => {
    const p = touches.get(e.pointerId);
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (!p || p.moved || !cam || performance.now() - p.t > 400 || touches.size) return;
    const c = cam.caps;
    if (!c.pointsOfInterest && !(c.focusMode && c.focusMode.length > 1)) return;
    const r = vfEl.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (cam.facing === "user") x = 1 - x; // the preview is mirrored; the sensor isn't
    const focus = $("vf-focus");
    focus.style.left = `${e.clientX - r.left}px`; focus.style.top = `${e.clientY - r.top}px`;
    focus.classList.remove("on"); void focus.offsetWidth; focus.classList.add("on");
    BC.haptic(8);
    const advanced = {};
    if (c.pointsOfInterest) advanced.pointsOfInterest = [{ x, y }];
    if (c.focusMode && c.focusMode.includes("single-shot")) advanced.focusMode = "single-shot";
    if (c.exposureMode && c.exposureMode.includes("single-shot")) advanced.exposureMode = "single-shot";
    await cam.stream.getVideoTracks()[0].applyConstraints({ advanced: [advanced] }).catch(() => {});
  };
  vfEl.addEventListener("pointerup", endTouch);
  vfEl.addEventListener("pointercancel", (e) => { touches.delete(e.pointerId); pinch = null; });

  // =============================== Voice-over ===============================
  // Studio Silence: the computer mutes itself while a take rolls, so the mic hears only you.
  const takes = []; // { n, at, dur, upload, state: "recording"|"sending"|"placed"|"kept"|"failed", note }
  let take = null; // the one rolling
  let mic = null;  // { stream, ctx, analyser, data }
  let rolling = null; // { at } from the computer

  async function openMic(constraints) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Safari starts an AudioContext suspended unless told otherwise, even inside a tap.
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    return { stream, ctx, analyser, data: new Uint8Array(analyser.fftSize) };
  }
  function closeMic(m) {
    if (!m) return;
    m.stream.getTracks().forEach((t) => t.stop());
    m.ctx.close().catch(() => {});
  }
  // 0..1 loudness of the latest audio frame.
  function level(m) {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (let i = 0; i < m.data.length; i += 4) { const v = (m.data[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / (m.data.length / 4)) * 3.2);
  }

  function paintVoice() {
    const ready = BC.connected() && !!pc.editing;
    $("vo-where").textContent = !BC.connected() ? "Connect to your computer to record a voice-over."
      : !pc.editing ? "Open a video in Briefcast's editor - your voice-over lands on it."
      : take ? `Recording onto ${pc.editing}` : `Starts at ${fmtClock(pc.time)} in ${pc.editing}`;
    $("vo-mic").disabled = !ready && !take;
    $("vo-mic").classList.toggle("live", !!take);
    $("vo-mic-label").textContent = take ? "Stop" : "Record";
    const list = $("vo-takes");
    list.innerHTML = "";
    for (const t of takes.slice().reverse()) {
      const row = document.createElement("div"); row.className = "take";
      const info = document.createElement("div");
      const title = document.createElement("div"); title.className = "take-title";
      title.textContent = `Take ${t.n} · ${fmtClock(t.dur)} at ${fmtClock(t.at)}`;
      const st = document.createElement("div"); st.className = "take-state " + t.state;
      st.textContent = { recording: "Recording…", sending: "Sending…", placed: "✓ On the timeline", kept: t.note || "Saved to library", failed: t.note || "Didn't send" }[t.state];
      info.append(title, st);
      row.appendChild(info);
      if (t.state === "placed" && t === takes[takes.length - 1]) {
        const retake = document.createElement("button"); retake.className = "chip"; retake.textContent = "Retake";
        retake.disabled = !ready || !!take;
        retake.addEventListener("click", () => startTake(t));
        row.appendChild(retake);
      }
      list.appendChild(row);
    }
  }

  // The live waveform: a scrolling ribbon of bars, and the arcs around the button ripple with the voice.
  const wave = $("vo-wave"), wctx = wave.getContext("2d");
  const bars = [];
  let waveRaf = 0;
  function drawWave() {
    const dpr = window.devicePixelRatio || 1;
    const w = wave.clientWidth, h = wave.clientHeight;
    if (wave.width !== w * dpr) { wave.width = w * dpr; wave.height = h * dpr; }
    const l = mic ? level(mic) : 0;
    bars.push(l); if (bars.length > Math.ceil(w / 5)) bars.shift();
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wctx.clearRect(0, 0, w, h);
    const grad = wctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#f58529"); grad.addColorStop(0.5, "#dd2a7b"); grad.addColorStop(1, "#515bd4");
    wctx.fillStyle = grad;
    bars.forEach((v, i) => { const bh = Math.max(2, v * h * 0.9); wctx.fillRect(w - (bars.length - i) * 5, (h - bh) / 2, 3, bh); });
    lightArcs($("vo-arcs").querySelector(".arcs"), l > 0.55 ? 3 : l > 0.3 ? 2 : l > 0.08 ? 1 : 0);
    if (take) $("vo-time").textContent = fmtClock((performance.now() - take.started) / 1000);
    waveRaf = requestAnimationFrame(drawWave);
  }

  const pickType = () => ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";

  async function startTake(replacing) {
    if (take) return;
    try {
      mic = await openMic({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    } catch (_) { BC.toast("Allow the microphone to record a voice-over"); return; }
    if (!(await countIn(replacing ? `Retake ${replacing.n}` : "Voice-over starts"))) { closeMic(mic); mic = null; return; }
    rolling = null;
    BC.send({ type: "remote", action: "voiceover.start", value: replacing ? replacing.at : null });
    // Studio Silence engaged on the computer, playback rolling - only then does the mic record.
    const t0 = performance.now();
    while (!rolling && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 30));
    if (!rolling) { closeMic(mic); mic = null; BC.toast("Briefcast didn't start playback - is a video open?"); return; }
    const type = pickType();
    const rec = new MediaRecorder(mic.stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    take = { n: takes.length + 1, at: rolling.at, started: performance.now(), rec, chunks, replacing, state: "recording", dur: 0 };
    takes.push(take);
    rec.start(250);
    BC.haptic(50);
    bars.length = 0;
    cancelAnimationFrame(waveRaf); drawWave();
    paintVoice();
  }

  function stopTake() {
    const t = take;
    if (!t) return;
    take = null;
    t.dur = (performance.now() - t.started) / 1000;
    BC.send({ type: "remote", action: "voiceover.stop" });
    t.rec.onstop = () => {
      closeMic(mic); mic = null;
      cancelAnimationFrame(waveRaf); lightArcs($("vo-arcs").querySelector(".arcs"), 0);
      const type = t.rec.mimeType || "audio/webm";
      const ext = type.includes("mp4") ? "m4a" : "webm";
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "-");
      const file = new File(t.chunks, `Voice-over ${stamp}.${ext}`, { type: type.split(";")[0] });
      t.state = "sending";
      BC.queue([file], "voiceover", {
        at: t.at, dur: t.dur, replaces: t.replacing && t.replacing.upload && t.replacing.upload.id,
        onUpdate: (u) => {
          t.upload = u;
          if (u.state === "failed") { t.state = "failed"; t.note = u.error; }
          else if (u.placed === true) { t.state = "placed"; BC.toast(t.replacing ? `✓ Retake ${t.n} replaced take ${t.replacing.n}` : "✓ Voice-over on the timeline"); BC.haptic([18, 70, 18]); }
          else if (u.placed === false) { t.state = "kept"; t.note = u.note; }
          paintVoice();
        },
      });
      paintVoice();
    };
    t.rec.stop();
    BC.haptic([30, 40, 30]);
    paintVoice();
  }
  BC.on("voiceover", (m) => {
    const s = m.state || {};
    if (s.state === "rolling") rolling = { at: s.at };
    else if (s.state === "unavailable") BC.toast("Open a video in Briefcast first");
    else if (s.state === "idle" && take) stopTake(); // stopped on the computer
  });
  $("vo-mic").addEventListener("click", () => (take ? stopTake() : startTake(null)));

  // =============================== Prompter ===============================
  // VoicePace: the script moves while you speak and waits while you pause - no one at a speed dial.
  const SCRIPT_KEY = "briefcast-prompter";
  let prefs = { speed: 40, size: 34, mirror: false, voice: true, withRec: true };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(SCRIPT_KEY + "-prefs") || "{}") }; } catch (_) {}
  const savePrefs = () => { try { localStorage.setItem(SCRIPT_KEY + "-prefs", JSON.stringify(prefs)); } catch (_) {} };
  const script = $("pr-script");
  try { script.value = localStorage.getItem(SCRIPT_KEY) || ""; } catch (_) {}
  script.addEventListener("input", () => { try { localStorage.setItem(SCRIPT_KEY, script.value); } catch (_) {} });
  const bind = (id, key, fmt) => {
    const el = $(id);
    if (el.type === "checkbox") el.checked = prefs[key]; else el.value = prefs[key];
    const out = fmt && $(id + "-v");
    if (out) out.textContent = fmt(prefs[key]);
    el.addEventListener("input", () => { prefs[key] = el.type === "checkbox" ? el.checked : Number(el.value); if (out) out.textContent = fmt(prefs[key]); savePrefs(); applyPrompterLook(); });
  };
  bind("pr-speed", "speed", (v) => `${v}`); bind("pr-size", "size", (v) => `${v}px`);
  bind("pr-mirror", "mirror"); bind("pr-voice", "voice"); bind("pr-withrec", "withRec");

  let running = false, offset = 0, velocity = 0, lastFrame = 0, raf = 0;
  let voiceMic = null, floor = 0.02, lastVoice = 0;
  const view = $("prompter"), text = $("pr-text");
  function applyPrompterLook() {
    text.style.fontSize = `${prefs.size}px`;
    text.classList.toggle("mirror", prefs.mirror);
  }
  async function openPrompter() {
    if (!script.value.trim()) { BC.toast("Write or paste a script first"); script.focus(); return; }
    text.textContent = script.value;
    applyPrompterLook();
    offset = 0; velocity = 0;
    view.hidden = false; prompterOpen = true;
    syncWakeLock();
    if (prefs.voice) {
      try { voiceMic = await openMic({ echoCancellation: true, noiseSuppression: true, autoGainControl: false }); }
      catch (_) { BC.toast("No microphone - scrolling at a steady speed instead"); }
    }
    const armed = prefs.withRec && BC.connected() && !pc.recording;
    setRunning(!armed);
    $("pr-status").textContent = armed ? "Starts when recording starts" : "";
    lastFrame = performance.now();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
  }
  function closePrompter() {
    view.hidden = true; prompterOpen = false; running = false;
    cancelAnimationFrame(raf);
    closeMic(voiceMic); voiceMic = null;
    syncWakeLock();
  }
  function setRunning(on) {
    running = on;
    view.classList.toggle("paused", !on);
    if (on) $("pr-status").textContent = "";
  }
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    let target = running ? prefs.speed : 0;
    if (running && voiceMic) {
      const l = level(voiceMic);
      // The room's own noise is learned slowly; speech is whatever clearly rises above it.
      floor = l < floor ? l : floor + (l - floor) * 0.002;
      if (l > floor * 2.2 + 0.03) lastVoice = now;
      const speaking = now - lastVoice < 450;
      target = speaking ? prefs.speed : 0;
      lightArcs($("pr-arcs").querySelector(".arcs"), speaking ? Math.min(3, 1 + Math.floor(l * 4)) : 0);
    }
    velocity += (target - velocity) * Math.min(1, dt * 6); // eases in and out - never a jolt
    offset += velocity * dt;
    const max = Math.max(0, text.scrollHeight - view.clientHeight * 0.3);
    if (offset >= max) { offset = max; if (running) { setRunning(false); $("pr-status").textContent = "The end"; } }
    text.style.transform = `translate3d(0, ${-offset}px, 0)${prefs.mirror ? " scaleX(-1)" : ""}`;
    raf = requestAnimationFrame(frame);
  }
  // Drag to nudge, tap to pause or carry on.
  let drag = null;
  view.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; drag = { y: e.clientY, o: offset, moved: false }; });
  view.addEventListener("pointermove", (e) => { if (!drag) return; const dy = e.clientY - drag.y; if (Math.abs(dy) > 6) drag.moved = true; if (drag.moved) offset = Math.max(0, drag.o - dy); });
  view.addEventListener("pointerup", () => { if (drag && !drag.moved) setRunning(!running); drag = null; });
  $("pr-start").addEventListener("click", openPrompter);
  $("pr-close").addEventListener("click", closePrompter);
  $("pr-slower").addEventListener("click", () => { prefs.speed = Math.max(10, prefs.speed - 10); $("pr-speed").value = prefs.speed; $("pr-speed-v").textContent = prefs.speed; savePrefs(); });
  $("pr-faster").addEventListener("click", () => { prefs.speed = Math.min(200, prefs.speed + 10); $("pr-speed").value = prefs.speed; $("pr-speed-v").textContent = prefs.speed; savePrefs(); });
  function prompterAutoStart() { if (prompterOpen && prefs.withRec && !running) { setRunning(true); BC.toast("Recording - go"); } }
  function prompterAutoStop() { if (prompterOpen && prefs.withRec && running) { setRunning(false); $("pr-status").textContent = "Recording stopped"; } }
  $("pr-from-pc").addEventListener("click", async () => {
    const t = await pullClip();
    if (t) { script.value = t; script.dispatchEvent(new Event("input")); BC.toast("Script pasted from your computer"); }
  });

  // =============================== Beam ===============================
  // Text and links between the two clipboards. A link can open on the computer straight away.
  const HISTORY_KEY = "briefcast-beam-history";
  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (_) {}
  const remember = (dir, txt) => {
    history = [{ dir, text: txt.slice(0, 4000), at: Date.now() }, ...history.filter((h) => h.text !== txt)].slice(0, 12);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (_) {}
    paintHistory();
  };
  const isLink = (t) => /^https?:\/\/\S+$/i.test(t.trim());
  const pending = new Map();
  let seq = 0;
  const request = (msg, reply) => new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 6000);
    pending.set(id, (m) => { clearTimeout(timer); pending.delete(id); resolve(m); });
    BC.send({ ...msg, id });
  });
  ["clip.pushed", "clip.pulled"].forEach((type) => BC.on(type, (m) => { const f = pending.get(m.id); if (f) f(m); }));

  async function beam(txt, open) {
    txt = (txt || "").trim();
    if (!txt) { BC.toast("Nothing to beam"); return false; }
    if (!BC.connected()) { BC.toast("Connect to your computer first"); return false; }
    const card = $("beam-card");
    card.classList.remove("beaming"); void card.offsetWidth; card.classList.add("beaming");
    BC.haptic(25);
    const r = await request({ type: "clip.push", text: txt, open: !!open });
    if (!r || !r.ok) { BC.toast((r && r.error) || "Couldn't reach your computer"); return false; }
    remember("out", txt);
    BC.toast(r.opened ? `✓ Opened on ${BC.host()}` : `✓ On ${BC.host()}'s clipboard`);
    BC.haptic([15, 50, 15]);
    return true;
  }
  async function pullClip() {
    if (!BC.connected()) { BC.toast("Connect to your computer first"); return null; }
    const r = await request({ type: "clip.pull" });
    const txt = r && r.text;
    if (!txt) { BC.toast(`${BC.host()}'s clipboard has no text`); return null; }
    remember("in", txt);
    return txt;
  }
  window.BCBeam = beam; // the share card's "Beam to computer" for shared links and text

  const beamText = $("beam-text");
  const paintBeamButtons = () => {
    const t = beamText.value.trim();
    $("beam-open").hidden = !isLink(t);
    $("beam-send").className = isLink(t) ? "btn" : "btn primary";
    $("beam-send").disabled = $("beam-open").disabled = !t;
  };
  beamText.addEventListener("input", paintBeamButtons);
  $("beam-paste").addEventListener("click", async () => {
    try { beamText.value = await navigator.clipboard.readText(); paintBeamButtons(); }
    catch (_) { BC.toast("Long-press the box and choose Paste"); beamText.focus(); }
  });
  $("beam-send").addEventListener("click", async () => { if (await beam(beamText.value, false)) { beamText.value = ""; paintBeamButtons(); } });
  $("beam-open").addEventListener("click", async () => { if (await beam(beamText.value, true)) { beamText.value = ""; paintBeamButtons(); } });
  $("beam-pull").addEventListener("click", async () => {
    const txt = await pullClip();
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); BC.toast("✓ Copied from your computer"); }
    catch (_) { BC.toast("Got it - tap it below to copy"); }
    BC.haptic([15, 50, 15]);
  });
  function paintHistory() {
    const list = $("beam-history");
    list.innerHTML = "";
    $("beam-history-title").hidden = !history.length;
    for (const h of history) {
      const row = document.createElement("button"); row.type = "button"; row.className = "clip";
      const dir = document.createElement("span"); dir.className = "clip-dir " + h.dir; dir.textContent = h.dir === "out" ? "↗" : "↙";
      const body = document.createElement("span"); body.className = "clip-text"; body.textContent = h.text;
      row.append(dir, body);
      row.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(h.text); BC.toast("✓ Copied"); BC.haptic(12); } catch (_) { BC.toast("Couldn't copy"); }
      });
      list.appendChild(row);
    }
  }
  paintBeamButtons();
  paintHistory();

  BC.on("connected", () => { paintRemote(); paintVoice(); });
  paintRemote();
  paintVoice();
  if (BC.ready) BC.ready();
})();
