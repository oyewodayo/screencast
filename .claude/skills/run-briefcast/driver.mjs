#!/usr/bin/env node
// .claude/skills/run-briefcast/driver.mjs
//
// A stateless CLI driver for Briefcast (a Tauri v1 desktop app: Rust backend + a WebView2 window),
// one invocation per command. Deliberately NOT a stdin-fed REPL under tmux (the shape the Electron
// run-skill pattern uses) - this box is Git-Bash/MSYS2 with no tmux, and the harness's Bash tool
// gives no persistent stdin channel across calls anyway, so a REPL here just reads EOF immediately
// and exits. Instead, cross-invocation state (the WebDriver session id + tauri-driver's port +
// its PID) is a small JSON file next to this script; `launch` writes it, every other command reads
// it, `quit` deletes it. The two real long-lived processes (tauri-driver, and Briefcast.exe which
// msedgedriver spawns as its "browser") are launched detached so they keep running after this
// short-lived Node process exits.
//
// Usage: node driver.mjs <command> [args...]
//   launch                    - swap in the fixtures library, start msedgedriver+tauri-driver,
//                                create a WebDriver session against Briefcast.exe. Run first.
//   ss <path>                  - save a PNG screenshot to <path> (relative to cwd).
//   eval <jsExpr>               - execute `return (<jsExpr>)` in the page, print the JSON result.
//   click <cssSelector>         - find the first element matching <cssSelector>, click it.
//   type <cssSelector> <text>    - find the first element matching <cssSelector>, send it <text>.
//   quit                        - close the session, kill tauri-driver's whole process tree
//                                (which takes msedgedriver + the app down with it), restore the
//                                real ~/.briefcast/config.json. ALWAYS run this last, even after
//                                an error - see SKILL.md's Gotchas for why.
//
// Every command prints exactly one JSON line: {"ok":true,...} or {"ok":false,"error":"..."}.
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SKILL_DIR, "..", "..", "..");
const APP_BINARY = path.join(PROJECT_ROOT, "src-tauri", "target", "debug", "Briefcast.exe");
const MSEDGEDRIVER = path.join(SKILL_DIR, "tools", "msedgedriver.exe");
const TAURI_DRIVER = path.join(SKILL_DIR, "tools", "cargo-tauri-driver", "bin", "tauri-driver.exe");
const FIXTURES_LIBRARY = path.join(SKILL_DIR, "fixtures", "library");
const CONFIG_PATH = path.join(os.homedir(), ".briefcast", "config.json");
const CONFIG_BACKUP_PATH = path.join(SKILL_DIR, "tools", "config.json.real-backup");
const STATE_PATH = path.join(SKILL_DIR, "tools", "session.json");
// Single-instance guard's own port (see src-tauri/src/main.rs's `_single_instance_guard`) - checked
// so a stray running Briefcast fails fast with a clear message instead of silently no-op'ing into
// a native "already running" MessageBoxW the driver has no way to see or click through.
const SINGLE_INSTANCE_PORT = 47813;
const TAURI_DRIVER_PORT = 4444;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portInUse(port) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

async function loadState() {
  if (!existsSync(STATE_PATH)) throw new Error("not launched - run `launch` first");
  return JSON.parse(await readFile(STATE_PATH, "utf-8"));
}

async function wdFetch(baseUrl, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WebDriver ${method} ${urlPath} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json.value;
}

async function cmdLaunch() {
  if (existsSync(STATE_PATH)) throw new Error("already launched (session.json exists) - run `quit` first");
  if (!existsSync(APP_BINARY)) {
    throw new Error(`app binary not built yet: ${APP_BINARY} - see SKILL.md's Build section`);
  }
  if (await portInUse(SINGLE_INSTANCE_PORT)) {
    throw new Error(
      `port ${SINGLE_INSTANCE_PORT} is already held - a Briefcast instance (the user's real one, or a ` +
      `stale test run) is running. Close it first: this app refuses a second instance (single-instance ` +
      `guard, main.rs) rather than erroring cleanly.`
    );
  }

  // Swap in an isolated test library so the app never touches the real ~/.briefcast/config.json
  // target directory (which may be the user's actual recordings) - restored in cmdQuit. Backing up
  // to a file (not just an in-memory variable, which a crash would lose) means a crash between
  // launch and quit still leaves a recoverable trail instead of silently discarding the user's
  // real config.
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  if (existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_BACKUP_PATH, await readFile(CONFIG_PATH));
  } else if (existsSync(CONFIG_BACKUP_PATH)) {
    await rm(CONFIG_BACKUP_PATH);
  }
  await mkdir(FIXTURES_LIBRARY, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify({ custom_briefcast_dir: FIXTURES_LIBRARY }));

  // detached + unref + ignored stdio: this Node process is about to exit (it's a one-shot CLI
  // invocation, not a REPL), but tauri-driver (and the msedgedriver/Briefcast.exe it spawns under
  // it) needs to keep running until `quit` tears it down explicitly.
  const tauriDriverProc = spawn(TAURI_DRIVER, ["--port", String(TAURI_DRIVER_PORT), "--native-driver", MSEDGEDRIVER], {
    detached: true,
    stdio: "ignore",
  });
  tauriDriverProc.unref();

  const up = await waitForHttp(`http://localhost:${TAURI_DRIVER_PORT}/status`, 10_000);
  if (!up) throw new Error("tauri-driver did not come up on :4444 within 10s");

  const newSession = await wdFetch(`http://localhost:${TAURI_DRIVER_PORT}`, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": { application: APP_BINARY },
      },
    },
  });
  const sessionId = newSession.sessionId;

  await writeFile(STATE_PATH, JSON.stringify({ sessionId, port: TAURI_DRIVER_PORT, tauriDriverPid: tauriDriverProc.pid }));

  // The main window starts with "visible": false in tauri.conf.json (avoids a flash-of-unstyled-
  // content) and only calls appWindow.show() once Dashboard.tsx's own mount effect runs - a
  // screenshot taken immediately after session creation can land before that, so give it a beat.
  await sleep(1500);
  return { sessionId };
}

async function cmdScreenshot(relPath) {
  const { sessionId, port } = await loadState();
  const b64 = await wdFetch(`http://localhost:${port}/session/${sessionId}`, "GET", "/screenshot");
  const dest = path.resolve(process.cwd(), relPath);
  await writeFile(dest, Buffer.from(b64, "base64"));
  return { saved: dest };
}

async function cmdEval(expr) {
  const { sessionId, port } = await loadState();
  const value = await wdFetch(`http://localhost:${port}/session/${sessionId}`, "POST", "/execute/sync", { script: `return (${expr});`, args: [] });
  return { value };
}

async function findEl(baseUrl, selector) {
  const el = await wdFetch(baseUrl, "POST", "/element", { using: "css selector", value: selector });
  const key = Object.keys(el).find((k) => k.includes("element"));
  return el[key];
}

async function cmdClick(selector) {
  const { sessionId, port } = await loadState();
  const baseUrl = `http://localhost:${port}/session/${sessionId}`;
  const id = await findEl(baseUrl, selector);
  await wdFetch(baseUrl, "POST", `/element/${id}/click`, {});
  return { clicked: selector };
}

async function cmdType(selector, text) {
  const { sessionId, port } = await loadState();
  const baseUrl = `http://localhost:${port}/session/${sessionId}`;
  const id = await findEl(baseUrl, selector);
  await wdFetch(baseUrl, "POST", `/element/${id}/value`, { text });
  return { typed: selector };
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

async function cmdQuit() {
  const errors = [];
  if (existsSync(STATE_PATH)) {
    const { sessionId, port, tauriDriverPid } = JSON.parse(await readFile(STATE_PATH, "utf-8"));
    try {
      await wdFetch(`http://localhost:${port}/session/${sessionId}`, "DELETE", "");
    } catch (e) {
      errors.push(String(e));
    }
    if (tauriDriverPid) await killTree(tauriDriverPid);
    await rm(STATE_PATH, { force: true });
  }
  // Best-effort: the app itself may still be exiting (DELETE /session and the taskkill /T above
  // both already ask for it) - give it a moment before restoring config, so a slow shutdown can't
  // race a restored config.json out from under it while it's still reading briefcast_dir().
  await sleep(500);
  if (existsSync(CONFIG_BACKUP_PATH)) {
    await writeFile(CONFIG_PATH, await readFile(CONFIG_BACKUP_PATH));
    await rm(CONFIG_BACKUP_PATH);
  } else {
    await rm(CONFIG_PATH, { force: true });
  }
  return { quit: true, errors };
}

const [, , cmd, ...rest] = process.argv;
try {
  let result;
  if (cmd === "launch") result = await cmdLaunch();
  else if (cmd === "ss") result = await cmdScreenshot(rest.join(" "));
  else if (cmd === "eval") result = await cmdEval(rest.join(" "));
  else if (cmd === "click") result = await cmdClick(rest.join(" "));
  else if (cmd === "type") result = await cmdType(rest[0], rest.slice(1).join(" "));
  else if (cmd === "quit") result = await cmdQuit();
  else throw new Error(`unknown command: ${cmd} (expected: launch | ss | eval | click | type | quit)`);
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
}
