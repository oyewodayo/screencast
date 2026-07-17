import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

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
