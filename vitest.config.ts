import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts rather than adding a `test` field there - Vitest's
// `test` key isn't part of plain Vite's UserConfig type (that file imports `defineConfig` from
// "vite", not "vitest/config"), so adding it there would need changing that import just for
// test-only config. Kept minimal on purpose: the current test suite is pure TS logic (the
// "Pure functions only" handler files) with no DOM/React involved, so no jsdom environment or
// @vitejs/plugin-react is needed yet - add both here if/when component tests are introduced.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
