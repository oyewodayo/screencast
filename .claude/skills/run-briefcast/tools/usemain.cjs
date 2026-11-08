// Waits for the main window (Rust builds it during startup), selects it and sizes it.
const { post, base } = require("./raw.cjs");
(async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const h = (await (await fetch(base + "/window/handles")).json()).value || [];
    for (const x of h) {
      await post("/window", { handle: x });
      const u = (await post("/execute/sync", { script: "return location.href", args: [] })).value;
      if (/tauri\.localhost\/$/.test(u)) {
        await post("/window/rect", { x: 0, y: 0, width: 1700, height: 1050 });
        return console.log(JSON.stringify({ ok: true, handle: x, attempt }));
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(JSON.stringify({ ok: false, error: "main window never appeared" }));
})();
