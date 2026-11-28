// Briefcast Transfer Pro — Direct Phone-to-Phone WebRTC P2P engine + Built-in QR Scanner.
// Served as /p2p.js by both the hosted PWA (https://transfer.briefcast.app) and Briefcast Desktop
// (phone_transfer.rs) so Phone-to-Phone works anywhere (via VPS signaling) AND on offline hotspots
// (via Briefcast Desktop's local /p2p/ws). Zero file bytes ever touch any server: all files and
// messages flow directly peer-to-peer over DTLS-encrypted WebRTC DataChannels.
(() => {
  const BC = window.BC;
  if (!BC) return;
  const $ = (id) => document.getElementById(id);

  const CHUNK_SIZE = 64 * 1024;
  const HIGH_WATER = 1024 * 1024;
  const LOW_WATER = 256 * 1024;
  const OPFS_THRESHOLD = 25 * 1024 * 1024;
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const ua = navigator.userAgent;
  const platform = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
    ? "iPad"
    : /Android/.test(ua)
    ? "Android"
    : /Windows/.test(ua)
    ? "Windows"
    : /Mac/.test(ua)
    ? "Mac"
    : "Device";

  const P2P_NAME_KEY = "briefcast-p2p-name";
  function getMyName() {
    const pcName = BC.deviceName && BC.deviceName();
    if (pcName) return pcName;
    try {
      const saved = localStorage.getItem(P2P_NAME_KEY);
      if (saved && saved.trim()) return saved.trim();
    } catch (_) {}
    return platform;
  }
  function setMyName(name) {
    const clean = (name || "").trim().slice(0, 40);
    if (!clean) return;
    try { localStorage.setItem(P2P_NAME_KEY, clean); } catch (_) {}
    if (sigWs && sigWs.readyState === 1) {
      sigWs.send(JSON.stringify({ type: "hello", name: clean, platform }));
    }
    paintHeader();
  }

  const fmtSize = (n) => {
    if (!n || n < 1024) return (n || 0) + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
  };
  const fmtEta = (secs) => {
    if (!isFinite(secs) || secs <= 0) return "";
    if (secs < 60) return `${Math.ceil(secs)}s left`;
    const m = Math.floor(secs / 60), s = Math.ceil(secs % 60);
    return `${m}m ${s}s left`;
  };

  // ---- Signaling WebSocket state ----
  let sigWs = null;
  let sigTimer = 0;
  let sigPing = 0;
  let sigAttempt = 0;
  let sigState = "connecting"; // "online" | "connecting" | "offline"
  let myPeerId = "";
  let myRoomCode = "";
  let pendingRoomJoin = "";
  let peers = []; // [{ id, name, platform, room }]

  // Active WebRTC session state (one peer transfer channel at a time for clean mobile reliability)
  let pc = null;
  let dc = null;
  let activePeer = null; // { id, name, platform }
  let pendingIce = [];
  let outgoingOffer = null; // { files: File[], text?: string, peer }
  let incomingOffer = null; // { from, files: [{ name, size, mime }], text?: string }
  let sendAbort = false;
  let activeTransfers = []; // UI progress items
  let receivedItems = []; // [{ id, name, size, mime, url, file, from, at }]
  let p2pWakeLock = null;

  async function setTransferWakeLock(active) {
    if (!("wakeLock" in navigator)) return;
    if (active && document.visibilityState === "visible") {
      if (!p2pWakeLock) {
        try {
          p2pWakeLock = await navigator.wakeLock.request("screen");
          p2pWakeLock.addEventListener("release", () => { p2pWakeLock = null; });
        } catch (_) {}
      }
    } else if (!active && p2pWakeLock) {
      p2pWakeLock.release().catch(() => {});
      p2pWakeLock = null;
    }
  }

  function signalingUrls() {
    const urls = [];
    const hosted = BC.pwaOrigin && BC.pwaOrigin();
    const isLocalHost =
      /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname) ||
      /^\d+-\d+-\d+-\d+\./.test(location.hostname);
    // When running from the hosted PWA (e.g. transfer.briefcast.app), use its own /p2p/ws first.
    if (!isLocalHost && location.protocol === "https:") {
      urls.push(`wss://${location.host}/p2p/ws`);
    } else {
      // On LAN, prefer hosted signaling (works across Wi-Fi/5G), then fall back to the local PC's /p2p/ws.
      if (hosted) {
        try {
          const u = new URL(hosted);
          urls.push(`${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/p2p/ws`);
        } catch (_) {}
      }
      urls.push(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/p2p/ws`);
    }
    const pcOrigin = BC.pcOrigin && BC.pcOrigin();
    if (pcOrigin) {
      try {
        const u = new URL(pcOrigin);
        const localWs = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/p2p/ws`;
        if (!urls.includes(localWs)) urls.push(localWs);
      } catch (_) {}
    }
    return urls;
  }

  function connectSignal() {
    if (sigWs && sigWs.readyState <= 1) return;
    clearTimeout(sigTimer);
    const urls = signalingUrls();
    if (!urls.length) return;
    const url = urls[sigAttempt % urls.length];
    sigState = "connecting";
    paintHeader();

    let opened = false;
    const ws = new WebSocket(url);
    sigWs = ws;

    ws.onopen = () => {
      if (sigWs !== ws) return;
      opened = true;
      sigAttempt = 0;
      sigState = "online";
      ws.send(JSON.stringify({ type: "hello", name: getMyName(), platform }));
      if (pendingRoomJoin) {
        ws.send(JSON.stringify({ type: "room.join", code: pendingRoomJoin }));
      }
      clearInterval(sigPing);
      sigPing = setInterval(() => {
        if (ws.readyState === 1) ws.send('{"type":"ping"}');
      }, 20000);
      paintHeader();
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.type === "welcome") {
        myPeerId = m.id || "";
        peers = Array.isArray(m.peers) ? m.peers : [];
        paintRadar();
      } else if (m.type === "peers") {
        peers = Array.isArray(m.peers) ? m.peers : [];
        paintRadar();
      } else if (m.type === "room.created") {
        myRoomCode = m.code || "";
        paintRoomCard();
        BC.haptic(15);
      } else if (m.type === "room.joined") {
        myRoomCode = m.code || "";
        pendingRoomJoin = "";
        paintRoomCard();
        BC.toast(`Joined room ${formatCode(myRoomCode)}`);
        BC.haptic([15, 40, 15]);
      } else if (m.type === "room.error") {
        pendingRoomJoin = "";
        BC.toast(m.error || "Room code not found");
      } else if (m.type === "signal") {
        handleSignal(m.from, m.fromName, m.fromPlatform, m.data);
      }
    };

    ws.onclose = () => {
      clearInterval(sigPing);
      if (sigWs !== ws) return;
      sigWs = null;
      sigState = "offline";
      peers = [];
      paintHeader();
      paintRadar();
      const delay = Math.min(1200 * Math.pow(1.5, sigAttempt++), 9000);
      sigTimer = setTimeout(connectSignal, opened ? 1500 : delay);
    };
  }

  function sigSend(obj) {
    if (sigWs && sigWs.readyState === 1) {
      sigWs.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function formatCode(code) {
    const clean = String(code || "").replace(/\D/g, "").slice(0, 6);
    return clean.length === 6 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean;
  }

  // ---- WebRTC Peer Connection + File/Text Streaming ----
  function teardownPeer() {
    sendAbort = true;
    setTransferWakeLock(false);
    try { if (dc) { dc.onopen = dc.onmessage = dc.onclose = null; dc.close(); } } catch (_) {}
    try { if (pc) { pc.onicecandidate = pc.ondatachannel = pc.onconnectionstatechange = null; pc.close(); } } catch (_) {}
    dc = null;
    pc = null;
    activePeer = null;
    pendingIce = [];
  }

  function createPeer(peer, initiator) {
    teardownPeer();
    sendAbort = false;
    activePeer = peer;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (e) => {
      if (e.candidate && activePeer) {
        sigSend({ type: "signal", to: activePeer.id, data: { kind: "ice", candidate: e.candidate } });
      }
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        if (activeTransfers.some((t) => t.state === "sending" || t.state === "receiving")) {
          BC.toast("Peer connection lost");
        }
        setTransferWakeLock(false);
      }
    };
    if (initiator) {
      const channel = pc.createDataChannel("briefcast-p2p", { ordered: true });
      attachDataChannel(channel, true);
    } else {
      pc.ondatachannel = (e) => attachDataChannel(e.channel, false);
    }
    return pc;
  }

  // Receiver state inside DataChannel
  let rx = null; // { name, size, mime, received, started, chunks, opfsWritable, opfsFileHandle, opfsName, row }

  function attachDataChannel(channel, initiator) {
    dc = channel;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = LOW_WATER;

    dc.onopen = () => {
      if (initiator && outgoingOffer) {
        sendOutgoingPayload(outgoingOffer);
        outgoingOffer = null;
      }
    };

    dc.onmessage = async (ev) => {
      if (typeof ev.data === "string") {
        let m;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.kind === "text") {
          addReceivedText(m.text, activePeer?.name || "Nearby device");
        } else if (m.kind === "file.start") {
          await beginReceiveFile(m);
        } else if (m.kind === "file.end") {
          await finishReceiveFile();
        } else if (m.kind === "batch.done") {
          setTransferWakeLock(false);
          BC.haptic([18, 60, 18]);
        }
      } else if (ev.data instanceof ArrayBuffer) {
        await writeReceiveChunk(ev.data);
      }
    };

    dc.onclose = () => {
      setTransferWakeLock(false);
    };
  }

  async function beginReceiveFile(meta) {
    await setTransferWakeLock(true);
    const row = {
      id: "rx-" + Math.random().toString(36).slice(2, 8),
      dir: "in",
      name: meta.name || "file",
      size: meta.size || 0,
      done: 0,
      speed: 0,
      eta: "",
      state: "receiving",
      peerName: activePeer?.name || "Phone",
    };
    activeTransfers.unshift(row);
    paintTransfers();

    let opfsWritable = null;
    let opfsFileHandle = null;
    let opfsName = "";
    if (meta.size >= OPFS_THRESHOLD && navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        opfsName = `p2p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bin`;
        opfsFileHandle = await root.getFileHandle(opfsName, { create: true });
        opfsWritable = await opfsFileHandle.createWritable();
      } catch (_) {
        opfsWritable = null;
        opfsFileHandle = null;
      }
    }
    rx = {
      name: row.name,
      size: row.size,
      mime: meta.mime || "application/octet-stream",
      received: 0,
      started: Date.now(),
      lastPaint: 0,
      chunks: opfsWritable ? null : [],
      opfsWritable,
      opfsFileHandle,
      opfsName,
      row,
    };
  }

  async function writeReceiveChunk(buf) {
    if (!rx) return;
    if (rx.opfsWritable) {
      await rx.opfsWritable.write(new Uint8Array(buf));
    } else {
      rx.chunks.push(buf);
    }
    rx.received += buf.byteLength;
    const now = Date.now();
    if (now - rx.lastPaint > 110 || rx.received >= rx.size) {
      rx.lastPaint = now;
      const secs = (now - rx.started) / 1000;
      const speed = secs > 0.25 ? rx.received / secs : 0;
      rx.row.done = rx.received;
      rx.row.speed = speed;
      rx.row.eta = speed > 0 ? fmtEta((rx.size - rx.received) / speed) : "";
      paintTransfers();
    }
  }

  async function finishReceiveFile() {
    if (!rx) return;
    const cur = rx;
    rx = null;
    let file;
    try {
      if (cur.opfsWritable && cur.opfsFileHandle) {
        await cur.opfsWritable.close();
        const raw = await cur.opfsFileHandle.getFile();
        file = new File([raw], cur.name, { type: cur.mime });
      } else {
        file = new File(cur.chunks || [], cur.name, { type: cur.mime });
      }
      const url = URL.createObjectURL(file);
      cur.row.done = cur.size || file.size;
      cur.row.state = "done";
      cur.row.eta = "";
      receivedItems.unshift({
        id: cur.row.id,
        name: cur.name,
        size: file.size,
        mime: cur.mime,
        url,
        file,
        from: cur.row.peerName,
        at: Date.now(),
      });
      paintTransfers();
      paintReceived();
      BC.toast(`✓ Received ${cur.name}`);
      // Auto-trigger download on non-iOS or single files for convenience
      const a = document.createElement("a");
      a.href = url;
      a.download = cur.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      cur.row.state = "failed";
      paintTransfers();
      BC.toast("Could not save received file");
    }
  }

  function addReceivedText(text, from) {
    receivedItems.unshift({
      id: "txt-" + Math.random().toString(36).slice(2, 8),
      isText: true,
      text,
      from,
      at: Date.now(),
    });
    paintReceived();
    BC.toast(`Message from ${from}`);
    BC.haptic(20);
  }

  function waitForDrain(channel) {
    return new Promise((resolve) => {
      if (!channel || channel.readyState !== "open" || channel.bufferedAmount <= LOW_WATER) {
        resolve();
        return;
      }
      const onLow = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
      setTimeout(() => {
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      }, 250);
    });
  }

  async function sendOutgoingPayload(payload) {
    if (!dc || dc.readyState !== "open") return;
    await setTransferWakeLock(true);
    try {
      if (payload.text) {
        dc.send(JSON.stringify({ kind: "text", text: payload.text }));
        BC.toast(`✓ Sent text to ${payload.peer.name}`);
        BC.haptic(18);
      }
      for (const file of payload.files || []) {
        if (sendAbort || !dc || dc.readyState !== "open") break;
        const row = {
          id: "tx-" + Math.random().toString(36).slice(2, 8),
          dir: "out",
          name: file.name,
          size: file.size,
          done: 0,
          speed: 0,
          eta: "",
          state: "sending",
          peerName: payload.peer.name,
        };
        activeTransfers.unshift(row);
        paintTransfers();

        dc.send(JSON.stringify({ kind: "file.start", name: file.name, size: file.size, mime: file.type || "application/octet-stream" }));
        const started = Date.now();
        let offset = 0;
        let lastPaint = 0;
        while (offset < file.size) {
          if (sendAbort || !dc || dc.readyState !== "open") break;
          if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const buf = await slice.arrayBuffer();
          dc.send(buf);
          offset += buf.byteLength;
          const now = Date.now();
          if (now - lastPaint > 110 || offset >= file.size) {
            lastPaint = now;
            const secs = (now - started) / 1000;
            const speed = secs > 0.25 ? offset / secs : 0;
            row.done = offset;
            row.speed = speed;
            row.eta = speed > 0 ? fmtEta((file.size - offset) / speed) : "";
            paintTransfers();
          }
        }
        if (!sendAbort && dc && dc.readyState === "open") {
          dc.send(JSON.stringify({ kind: "file.end" }));
          row.done = file.size;
          row.state = "done";
          row.eta = "";
          paintTransfers();
        } else {
          row.state = "failed";
          paintTransfers();
        }
      }
      if (!sendAbort && dc && dc.readyState === "open") {
        dc.send(JSON.stringify({ kind: "batch.done" }));
        if (payload.files && payload.files.length) {
          BC.toast(
            payload.files.length === 1
              ? `✓ Sent ${payload.files[0].name}`
              : `✓ Sent ${payload.files.length} files to ${payload.peer.name}`
          );
          BC.haptic([18, 60, 18]);
        }
      }
    } catch (_) {
      BC.toast("Transfer interrupted");
    } finally {
      await setTransferWakeLock(false);
    }
  }

  async function handleSignal(fromId, fromName, fromPlatform, data) {
    if (!data || !data.kind) return;
    const peer = { id: fromId, name: fromName || "Phone", platform: fromPlatform || "Device" };

    if (data.kind === "request") {
      incomingOffer = { from: peer, files: data.files || [], text: data.text || "" };
      paintIncomingRequest();
      BC.haptic([30, 50, 30]);
    } else if (data.kind === "accept") {
      if (!outgoingOffer || outgoingOffer.peer.id !== fromId) return;
      const conn = createPeer(peer, true);
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      sigSend({ type: "signal", to: fromId, data: { kind: "sdp", sdp: conn.localDescription } });
    } else if (data.kind === "decline") {
      if (outgoingOffer && outgoingOffer.peer.id === fromId) {
        outgoingOffer = null;
        BC.toast(`${peer.name} declined the transfer`);
        paintTransfers();
      }
    } else if (data.kind === "sdp") {
      if (data.sdp && data.sdp.type === "offer") {
        const conn = createPeer(peer, false);
        await conn.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const c of pendingIce) {
          try { await conn.addIceCandidate(c); } catch (_) {}
        }
        pendingIce = [];
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);
        sigSend({ type: "signal", to: fromId, data: { kind: "sdp", sdp: conn.localDescription } });
      } else if (data.sdp && data.sdp.type === "answer" && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const c of pendingIce) {
          try { await pc.addIceCandidate(c); } catch (_) {}
        }
        pendingIce = [];
      }
    } else if (data.kind === "ice" && data.candidate) {
      const cand = new RTCIceCandidate(data.candidate);
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(cand); } catch (_) {}
      } else {
        pendingIce.push(cand);
      }
    }
  }

  function requestSendToPeer(peer, files, text) {
    if (!sigWs || sigWs.readyState !== 1) {
      BC.toast("Connecting to Nearby service…");
      connectSignal();
      return;
    }
    outgoingOffer = { peer, files: files || [], text: text || "" };
    const meta = (files || []).map((f) => ({ name: f.name, size: f.size, mime: f.type || "application/octet-stream" }));
    sigSend({
      type: "signal",
      to: peer.id,
      data: { kind: "request", files: meta, text: text || "" },
    });
    BC.toast(`Waiting for ${peer.name} to accept…`);
    BC.haptic(15);
  }

  // ---- UI Rendering ----
  let targetPeerForPicker = null;

  function paintHeader() {
    const badge = $("p2p-badge");
    const status = $("p2p-status");
    const me = $("p2p-me");
    if (me) me.textContent = getMyName() + " ✎";
    if (status) {
      status.textContent =
        sigState === "online"
          ? peers.length
            ? `${peers.length} nearby device${peers.length === 1 ? "" : "s"} · Direct P2P`
            : "Ready · Open Briefcast Transfer on another phone"
          : sigState === "connecting"
          ? "Finding nearby phones…"
          : "Offline — tap Refresh or connect to Wi-Fi";
    }
    if (badge) {
      badge.textContent = peers.length ? String(peers.length) : "";
      badge.hidden = !peers.length;
    }
  }

  function paintRadar() {
    paintHeader();
    const list = $("p2p-peers");
    if (!list) return;
    list.innerHTML = "";
    if (!peers.length) {
      list.innerHTML = `<div class="p2p-empty">
        <div class="radar-ring"><span></span><span></span><i></i></div>
        <p><b>Looking for nearby phones…</b><br>Open <b>transfer.briefcast.app</b> on another phone on the same Wi-Fi, or pair anywhere with a 6-digit code below.</p>
      </div>`;
      return;
    }
    for (const peer of peers) {
      const card = document.createElement("div");
      card.className = "p2p-peer";
      const icon = peer.platform === "iPhone" || peer.platform === "iPad" || peer.platform === "Android" ? "📱" : "💻";
      card.innerHTML = `
        <div class="p2p-av">${icon}</div>
        <div class="p2p-pinfo">
          <div class="name"></div>
          <div class="meta"></div>
        </div>
        <div class="p2p-pacts">
          <button type="button" class="btn primary p2p-send-btn">Send files</button>
          <button type="button" class="btn p2p-txt-btn" title="Send text or link">Text</button>
        </div>`;
      card.querySelector(".name").textContent = peer.name;
      card.querySelector(".meta").textContent = `${peer.platform}${peer.room ? " · Room " + formatCode(peer.room) : " · Same Wi-Fi"} · 🔒 P2P`;
      card.querySelector(".p2p-send-btn").addEventListener("click", () => {
        targetPeerForPicker = peer;
        const inp = $("p2p-pick");
        if (inp) inp.click();
      });
      card.querySelector(".p2p-txt-btn").addEventListener("click", () => {
        const txt = prompt(`Send a link or message to ${peer.name}:`);
        if (txt && txt.trim()) requestSendToPeer(peer, [], txt.trim());
      });
      list.appendChild(card);
    }
  }

  function paintRoomCard() {
    const codeBox = $("p2p-room-active");
    if (!codeBox) return;
    if (!myRoomCode) {
      codeBox.hidden = true;
      return;
    }
    codeBox.hidden = false;
    $("p2p-room-code").textContent = formatCode(myRoomCode);
  }

  function paintIncomingRequest() {
    const box = $("p2p-incoming");
    if (!box) return;
    if (!incomingOffer) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const total = incomingOffer.files.reduce((s, f) => s + (f.size || 0), 0);
    const title = incomingOffer.files.length
      ? `${incomingOffer.from.name} wants to send ${incomingOffer.files.length} file${incomingOffer.files.length === 1 ? "" : "s"}`
      : `${incomingOffer.from.name} wants to send a message`;
    const sub = incomingOffer.files.length
      ? `${incomingOffer.files.slice(0, 3).map((f) => f.name).join(", ")}${incomingOffer.files.length > 3 ? ` +${incomingOffer.files.length - 3} more` : ""} · ${fmtSize(total)}`
      : (incomingOffer.text || "").slice(0, 140);
    $("p2p-inc-title").textContent = title;
    $("p2p-inc-sub").textContent = sub;
  }

  function paintTransfers() {
    const box = $("p2p-transfers");
    if (!box) return;
    box.innerHTML = "";
    for (const t of activeTransfers.slice(0, 6)) {
      const pct = t.size ? Math.min(100, Math.floor((t.done / t.size) * 100)) : t.state === "done" ? 100 : 0;
      const el = document.createElement("div");
      el.className = "p2p-xfer";
      el.innerHTML = `
        <div class="row">
          <span class="n"></span>
          <span class="st"></span>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>`;
      el.querySelector(".n").textContent = `${t.dir === "out" ? "↗ " : "↙ "}${t.name}`;
      const st = el.querySelector(".st");
      if (t.state === "done") {
        st.style.color = "var(--ok)";
        st.textContent = `✓ ${fmtSize(t.size)}`;
      } else if (t.state === "failed") {
        st.style.color = "var(--bad)";
        st.textContent = "Stopped";
      } else {
        st.textContent = `${pct}%${t.speed ? " · " + fmtSize(t.speed) + "/s" : ""}${t.eta ? " · " + t.eta : ""}`;
      }
      box.appendChild(el);
    }
  }

  function paintReceived() {
    const title = $("p2p-rx-title");
    const list = $("p2p-rx-list");
    if (!list) return;
    if (title) title.hidden = !receivedItems.length;
    list.innerHTML = "";
    for (const item of receivedItems) {
      const el = document.createElement("div");
      el.className = "item";
      if (item.isText) {
        el.innerHTML = `
          <div class="thumb">TXT</div>
          <div><div class="name"></div><div class="meta"></div></div>
          <div class="actions"><button type="button" class="btn primary">Copy</button></div>`;
        el.querySelector(".name").textContent = item.text;
        el.querySelector(".meta").textContent = `From ${item.from}`;
        el.querySelector("button").addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(item.text); BC.toast("✓ Copied"); } catch (_) { BC.toast("Couldn't copy"); }
        });
      } else {
        const isImg = /^image\//.test(item.mime) && !/heic|heif/i.test(item.mime);
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        if (isImg) {
          const img = document.createElement("img");
          img.src = item.url;
          img.alt = "";
          thumb.appendChild(img);
        } else {
          thumb.textContent = (item.name.split(".").pop() || "FILE").slice(0, 4).toUpperCase();
        }
        const info = document.createElement("div");
        const nm = document.createElement("div"); nm.className = "name"; nm.textContent = item.name;
        const mt = document.createElement("div"); mt.className = "meta"; mt.textContent = `${fmtSize(item.size)} · From ${item.from}`;
        info.append(nm, mt);
        const actions = document.createElement("div");
        actions.className = "actions";
        const dl = document.createElement("a");
        dl.className = "btn primary"; dl.href = item.url; dl.download = item.name; dl.innerHTML = "<span>Save</span>";
        actions.appendChild(dl);
        if (navigator.share && navigator.canShare) {
          try {
            if (navigator.canShare({ files: [item.file] })) {
              const sh = document.createElement("button");
              sh.type = "button"; sh.className = "btn sharebtn"; sh.innerHTML = "<span>Share</span>";
              sh.addEventListener("click", () => navigator.share({ files: [item.file], title: item.name }).catch(() => {}));
              actions.appendChild(sh);
            }
          } catch (_) {}
        }
        el.append(thumb, info, actions);
      }
      list.appendChild(el);
    }
  }

  // ---- Built-in Camera QR Scanner (BarcodeDetector + Manual Code/Link fallback) ----
  let scanStream = null;
  let scanRaf = 0;

  function closeQrScanner() {
    cancelAnimationFrame(scanRaf);
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
    const modal = $("qr-modal");
    if (modal) modal.hidden = true;
  }

  function handleScannedPayload(raw) {
    const val = (raw || "").trim();
    if (!val) return false;
    // 6-digit P2P room code directly
    const digits = val.replace(/\s+/g, "");
    if (/^\d{6}$/.test(digits)) {
      closeQrScanner();
      joinRoom(digits);
      return true;
    }
    // URL (either Briefcast Desktop pairing QR or P2P #join= code)
    try {
      const u = new URL(val);
      const hash = new URLSearchParams(u.hash.slice(1));
      const join = hash.get("join") || u.searchParams.get("join");
      if (join && /^\d{6}$/.test(join)) {
        closeQrScanner();
        joinRoom(join);
        return true;
      }
      const k = hash.get("k");
      const pcParam = hash.get("pc");
      if (k) {
        closeQrScanner();
        const origin = pcParam || u.origin;
        if (BC.pairWithPc) BC.pairWithPc(origin, k);
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function openQrScanner() {
    const modal = $("qr-modal");
    const video = $("qr-video");
    const note = $("qr-note");
    if (!modal || !video) return;
    modal.hidden = false;
    const supported = "BarcodeDetector" in window;
    if (!supported || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      video.hidden = true;
      note.textContent = "Point your phone's Camera app at any Briefcast QR code, or paste a 6-digit room code / pairing link below.";
      return;
    }
    video.hidden = false;
    note.textContent = "Point at a Briefcast Desktop QR code or another phone's room QR.";
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      video.srcObject = scanStream;
      await video.play();
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!scanStream) return;
        try {
          const codes = await detector.detect(video);
          for (const c of codes) {
            if (handleScannedPayload(c.rawValue)) return;
          }
        } catch (_) {}
        scanRaf = requestAnimationFrame(tick);
      };
      scanRaf = requestAnimationFrame(tick);
    } catch (_) {
      video.hidden = true;
      note.textContent = "Camera permission unavailable. Paste a 6-digit room code or pairing link below.";
    }
  }

  function joinRoom(code) {
    const clean = String(code || "").replace(/\D/g, "").slice(0, 6);
    if (clean.length !== 6) {
      BC.toast("Enter a 6-digit room code");
      return;
    }
    if (BC.setFilesMode) BC.setFilesMode("p2p");
    pendingRoomJoin = clean;
    if (!sigSend({ type: "room.join", code: clean })) {
      connectSignal();
    }
  }

  // ---- Wire DOM controls ----
  $("p2p-pick")?.addEventListener("change", (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length || !targetPeerForPicker) return;
    requestSendToPeer(targetPeerForPicker, files, "");
    targetPeerForPicker = null;
  });

  $("p2p-me")?.addEventListener("click", () => {
    const n = prompt("How this phone appears to nearby devices:", getMyName());
    if (n && n.trim()) setMyName(n.trim());
  });

  $("p2p-create-room")?.addEventListener("click", () => {
    if (!sigSend({ type: "room.create" })) {
      connectSignal();
      BC.toast("Connecting to create room…");
    }
  });

  $("p2p-copy-room")?.addEventListener("click", async () => {
    if (!myRoomCode) return;
    const link = `${location.origin}/#join=${myRoomCode}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Briefcast Transfer Room", text: `Join my Briefcast Transfer room: ${formatCode(myRoomCode)}`, url: link });
      } else {
        await navigator.clipboard.writeText(link);
        BC.toast("✓ Room link copied");
      }
    } catch (_) {}
  });

  $("p2p-leave-room")?.addEventListener("click", () => {
    myRoomCode = "";
    sigSend({ type: "room.leave" });
    paintRoomCard();
  });

  $("p2p-join-btn")?.addEventListener("click", () => {
    const inp = $("p2p-join-input");
    if (inp) {
      joinRoom(inp.value);
      inp.value = "";
    }
  });

  $("p2p-join-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("p2p-join-btn")?.click();
    }
  });

  $("p2p-inc-accept")?.addEventListener("click", () => {
    if (!incomingOffer) return;
    const from = incomingOffer.from;
    incomingOffer = null;
    paintIncomingRequest();
    sigSend({ type: "signal", to: from.id, data: { kind: "accept" } });
    BC.toast(`Connecting to ${from.name}…`);
  });

  $("p2p-inc-decline")?.addEventListener("click", () => {
    if (!incomingOffer) return;
    const from = incomingOffer.from;
    incomingOffer = null;
    paintIncomingRequest();
    sigSend({ type: "signal", to: from.id, data: { kind: "decline" } });
  });

  $("qr-close")?.addEventListener("click", closeQrScanner);
  $("qr-manual-go")?.addEventListener("click", () => {
    const val = $("qr-manual")?.value || "";
    if (!handleScannedPayload(val)) BC.toast("Enter a 6-digit code or Briefcast pairing link");
    else if ($("qr-manual")) $("qr-manual").value = "";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!sigWs || sigWs.readyState > 1)) {
      sigAttempt = 0;
      connectSignal();
    }
  });
  window.addEventListener("online", () => { sigAttempt = 0; connectSignal(); });

  window.BCP2P = {
    connect: connectSignal,
    joinRoom,
    openScanner: openQrScanner,
    sendFilesToFirstPeer: (files) => {
      if (peers.length === 1) requestSendToPeer(peers[0], files, "");
      else BC.toast("Select a nearby phone to send to");
    },
    peerCount: () => peers.length,
  };
  window.BCScanQR = openQrScanner;

  // Check if launched via #join=123456 deep link
  if (BC.initialJoinCode) {
    pendingRoomJoin = BC.initialJoinCode;
  }
  paintRadar();
  connectSignal();
})();
