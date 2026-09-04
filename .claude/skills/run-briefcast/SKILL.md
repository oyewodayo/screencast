---
name: run-briefcast
description: Build, launch, screenshot, and drive Briefcast (the Tauri v1 desktop screen-recording/video-editor app in this repo) end-to-end via a real WebDriver session against its WebView2 window. Use when asked to run, start, test, or screenshot Briefcast, or to verify a UI change actually renders/works.
---

Briefcast is a Tauri v1 app: a Rust backend (`src-tauri/`) hosting a WebView2 window that
renders the React/Vite frontend (`src/`). It is NOT Electron - Playwright's `_electron` does not
work here. It's driven instead through Tauri's own WebDriver bridge: `tauri-driver` proxies the
W3C WebDriver protocol to `msedgedriver.exe` (Microsoft Edge WebDriver, version-matched to the
installed WebView2 runtime), which launches `Briefcast.exe` itself as if it were "the browser".

**Primary agent path: `.claude/skills/run-briefcast/driver.mjs`** - a stateless Node CLI, one
process per command (`launch`, `ss`, `eval`, `click`, `type`, `quit`), state persisted to a JSON
file next to it. It is NOT a REPL under tmux (the shape other run-skills use) - this box has no
tmux (Git-Bash/MSYS2, not WSL), and the harness's Bash tool gives no persistent stdin channel
across calls anyway. All paths below are relative to the repo root.

## Prerequisites

Rust/cargo and Node were already installed on this machine; nothing else needed installing at the
OS level. Two tools had to be fetched, both already sitting in `.claude/skills/run-briefcast/tools/`
(gitignored - regenerate with the commands below on a fresh machine):

1. **msedgedriver**, version-matched to the installed WebView2 runtime:
   ```
   powershell -NoProfile -Command "Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' | Select-Object pv"
   # -> e.g. 152.0.4191.62
   curl -L -o tools/edgedriver.zip "https://msedgedriver.microsoft.com/<that version>/edgedriver_win64.zip"
   unzip -o tools/edgedriver.zip -d tools/   # -> tools/msedgedriver.exe
   rm tools/edgedriver.zip
   ```
2. **tauri-driver** (compiles from crates.io, ~2-3 min):
   ```
   cargo install tauri-driver --root .claude/skills/run-briefcast/tools/cargo-tauri-driver
   # -> tools/cargo-tauri-driver/bin/tauri-driver.exe
   ```

Both curl calls need `dangerouslyDisableSandbox: true` on the Bash tool - the default sandbox
resolves neither `msedgedriver.microsoft.com` nor `static.crates.io`.

## Build

The app must be built with the `custom-protocol` Cargo feature so it bundles the frontend from
`dist/` instead of expecting a live `vite` dev server on `:1420` - that's what makes the binary
launchable standalone by `tauri-driver`/`msedgedriver` instead of needing `cargo tauri dev`'s
two-process dance.

```
npm run build                              # tsc && vite build -> dist/   (~45s-2min)
npx tauri build --debug --bundles none     # NOT --no-bundle, that flag doesn't exist
```

The second command recompiles the whole `tauri`/`tauri-macros` crate graph the first time this
feature gets enabled (~4-5 min even though it's a debug build - most of that is `tauri` itself,
not this project's own crate). Output: `src-tauri/target/debug/Briefcast.exe`. Re-run both after
any frontend or Rust change under test; skip them if the binary is already newer than your changes.

## Run (agent path)

```
node .claude/skills/run-briefcast/driver.mjs launch
node .claude/skills/run-briefcast/driver.mjs ss shot.png            # saves under cwd
node .claude/skills/run-briefcast/driver.mjs eval "document.title"  # JS in the page, JSON result
node .claude/skills/run-briefcast/driver.mjs click "button.foo"     # CSS selector, native click()
node .claude/skills/run-briefcast/driver.mjs type "input.bar" "hi"
node .claude/skills/run-briefcast/driver.mjs quit                   # ALWAYS run this last
```

Every command prints one JSON line (`{"ok":true,...}` or `{"ok":false,"error":"..."}`). `launch`
also swaps `~/.briefcast/config.json` to point the app at an isolated fixtures library
(`.claude/skills/run-briefcast/fixtures/library/`) and backs up whatever was really there;
`quit` restores it - see Gotchas below for why this matters and why `quit` must never be skipped.

For anything `click`/`type` can't reach (drag handles, the timeline's clip blocks, window
resizing), drop to raw WebDriver calls using the session file directly:
```js
const state = JSON.parse(require('fs').readFileSync('.claude/skills/run-briefcast/tools/session.json','utf-8'));
const base = `http://localhost:${state.port}/session/${state.sessionId}`;
// POST base+'/actions' for pointer gestures, POST base+'/window/rect' to resize, etc.
```

### A worked example (opening a clip and reaching the timeline editor)

```
node driver.mjs launch
node driver.mjs eval "(() => { document.querySelectorAll('button').forEach(...) })()"   # see Gotchas: home screen vs tools-panel selectors differ
node driver.mjs eval "(() => { Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='<file>.mp4').click() })()"
node driver.mjs eval "(() => { document.querySelector('button[title=\"Toggle file list\"]').click() })()"
node driver.mjs eval "(() => { document.querySelector('button[title=\"Show tools for this file\"]').click() })()"
node driver.mjs ss opened.png
node driver.mjs quit
```

## Run (human path)

`npm run tauri dev` opens a real window (needs the vite dev server, which it starts itself) - fine
for a person, useless for scripted screenshots since nothing but a human can see or click it.

## Gotchas

- **Single-instance guard.** `src-tauri/src/main.rs` binds `127.0.0.1:47813` before doing anything
  else; a second launch just pops a native "already running" `MessageBoxW` and exits 0 - no error,
  no window, nothing WebDriver can see. `driver.mjs launch` checks this port first and fails loudly
  instead. If it's the user's own real instance holding it, ask before closing it (that's their
  live session, not a stale test run) - see this skill's own commit history for that exact
  conversation.
- **The real library is not disposable.** `list_briefcast_files` scans whatever `~/.briefcast/config.json`
  names as `custom_briefcast_dir` (or `~/Videos/Briefcast` if that file doesn't exist) and shows it
  wholesale in the sidebar - there's no per-test sandboxing built into the app itself. `driver.mjs`
  handles this (backs up the real config, points at `fixtures/library/` instead, restores on
  `quit`) so you never need to touch it by hand, but if you ever bypass the driver and edit that
  config yourself, restore it before you're done, and never delete anything under a
  `custom_briefcast_dir` you didn't create.
- **Main window starts invisible.** `tauri.conf.json`'s main window has `"visible": false` (avoids
  a flash of unstyled content); `src/pages/Dashboard.tsx`'s mount effect calls `appWindow.show()`
  once React has actually rendered. `driver.mjs launch` sleeps 1.5s after session creation for
  exactly this reason - a screenshot taken right after `launch` without that beat can land on a
  window that technically exists but was never shown.
- **Default window is 900x600 - too small to show the video timeline docker at all.** At the
  default size, opening a video shows only the player; the whole bottom timeline/toolbar panel
  (needed for anything clip-related: crop, speed, effects, split...) needs the sidebar's wrench
  icon, which itself needs the sidebar open, which itself is collapsed by default once a file is
  open. Resize first: `POST /session/:id/window/rect` with `{x:0,y:0,width:1600,height:1000}`
  (there's no CLI command for this yet - do it via a raw fetch against `tools/session.json`, see
  the worked example's spirit above).
- **Two different sidebar views use two different DOM shapes for "the same" file row.** The home
  screen's "FROM YOUR LIBRARY" list renders plain `<button>`s with exact text content (`el.textContent.trim() === "<file>.mp4"`
  works). Once you're in the file-tools tree (after "Toggle file list" + the wrench "Show tools for
  this file" button), the same file is a `<span>` several levels deep inside an `<li>` that carries
  the actual `cursor-pointer`/onClick behavior - text-equality search on `<button>` finds nothing
  there. Search leaf text nodes and climb to the nearest `li.className.includes('cursor-pointer')`
  instead.
- **`onClick` handlers respond fine to `el.click()`; `onPointerDown` handlers (drag/select on the
  timeline) do not.** The clip blocks, resize handles, and every draggable overlay chip in
  `VideoTimelineDocker.tsx` are wired to `onPointerDown`, not `onClick` - a scripted `.click()`
  never fires them. Use a real WebDriver Actions pointer gesture (`pointerMove` origin `viewport`
  at the element's `getBoundingClientRect()` center, `pointerDown`, `pointerUp`) instead; that
  dispatches genuine trusted PointerEvents the same way a real mouse would.
- **Rapid scripted clicks inside one `eval` call don't accumulate like real clicks do.** Calling
  `.click()` on the same stepper button 5 times in a single synchronous script reads the same
  stale React-prop closure for all 5 (React only re-renders after the whole task finishes) - you'll
  see one increment's worth of change, not five. A real user's mouse clicks are always separate
  browser tasks with a render in between, so this is purely a test-authoring trap, not a product
  bug: space out clicks across separate `driver.mjs eval` invocations if you need to verify
  accumulation.
- **The custom `asset://` protocol caches aggressively across the whole app's lifetime - even
  across a full relaunch.** Overwriting a fixture video file on disk and reopening "the same" file
  by name inside the app can still serve the old bytes (old duration, old frames) because WebView2's
  disk cache is keyed by URL, not content, and survives the app process exiting. If a fixture's
  actual content needs to change between test runs, give it a new filename rather than trusting a
  reopen (or even a full `quit`+`launch`) to see the new bytes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `unexpected argument '--no-bundle'` from `tauri build` | The flag is `--bundles none`, not `--no-bundle`. |
| `launch` fails with "port 47813 is already held" | A Briefcast instance (real or a leaked prior test run) is running. Confirm which with `Get-Process Briefcast`, close it, retry. |
| `tauri-driver did not come up on :4444` | `tools/msedgedriver.exe` missing/wrong path, or its version doesn't match the installed WebView2 runtime (re-check the registry version and re-download). |
| A `click`/`eval` call errors "Cannot read properties of undefined (reading 'click')" | The selector found nothing - usually the home-screen-vs-tools-tree DOM-shape gotcha above. Re-probe with a broader `querySelectorAll` first. |
| Screenshot shows a blank/empty player after `launch` | Too early - add a short sleep, or confirm `appWindow.show()` gotcha isn't in play. |
