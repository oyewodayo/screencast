import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    rollupOptions: {
      // The recording-completed popup is a second HTML entry point, not part of the main SPA -
      // it's opened as its own Tauri window (see the create_webview_window call in
      // commands/recording.rs, which points at this exact path).
      //
      // Without listing it here it is simply never built: `vite build` only follows index.html,
      // so dist/ shipped without the page and the popup opened as a blank window in any packaged
      // or `tauri build` binary. It looked fine in `tauri dev` only because the dev server serves
      // arbitrary files straight from the project root, which production has no equivalent of.
      //
      // The HTML lives at the project root, beside index.html, rather than next to its own .tsx
      // under src-tauri/. Vite emits extra HTML inputs at their path relative to the root, and
      // Tauri flatly refuses a frontendDist containing a `src-tauri` folder ("Please isolate your
      // web assets on a separate folder"), so keeping the page there made the build fail outright.
      // The component itself stays in src-tauri/src/views/ - only the entry HTML moved.
      input: {
        main: resolve(__dirname, "index.html"),
        completed_recording: resolve(__dirname, "completed_recording.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching rust source/build output under src-tauri - but NOT
      // src-tauri/src/views, which holds genuine frontend code (the recording-completed
      // popup's HTML/TSX entry point) that needs to be served and hot-reloaded like any
      // other page in the app. A blanket "**/src-tauri/**" ignore silently stales out edits
      // to that directory until the dev server is restarted.
      ignored: [
        "**/src-tauri/target/**",
        "**/src-tauri/binaries/**",
        "**/src-tauri/icons/**",
        "**/src-tauri/src/commands/**",
        "**/src-tauri/src/services/**",
        "**/src-tauri/src/main.rs",
        "**/src-tauri/Cargo.*",
        "**/src-tauri/tauri.conf.json",
        "**/src-tauri/build.rs",
      ],
    },
  },
}));
