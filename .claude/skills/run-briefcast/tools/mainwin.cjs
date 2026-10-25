// Switches the WebDriver session to Briefcast's main window and sizes it (default 1600x1000).
const { post, base } = require("./raw.cjs");
(async () => {
  const handles = (await (await fetch(base + "/window/handles")).json()).value;
  for (const h of handles) {
    await post("/window", { handle: h });
    const href = (await post("/execute/sync", { script: "return location.href", args: [] })).value;
    if (/^https?:\/\/tauri\.localhost\/?$/.test(href)) {
      const [w, hgt] = (process.argv[2] ?? "1600x1000").split("x").map(Number);
      await post("/window/rect", { x: 0, y: 0, width: w, height: hgt });
      console.log(JSON.stringify({ ok: true, handle: h, href }));
      return;
    }
  }
  console.log(JSON.stringify({ ok: false, error: "main window not found" }));
})();
