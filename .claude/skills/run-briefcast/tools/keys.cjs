// node keys.cjs <key> [ctrl|shift] [times] - real WebDriver key presses (e.g. "z" ctrl, "ArrowRight" shift 3).
const { post } = require("./raw.cjs");
const named = { ArrowLeft: "", ArrowUp: "", ArrowRight: "", ArrowDown: "", Delete: "", Backspace: "", Escape: "", Enter: "" };
const mods = { ctrl: "", shift: "" };
(async () => {
  const [, , key, mod, times = "1"] = process.argv;
  const k = named[key] ?? key;
  const acts = [];
  for (let i = 0; i < +times; i++) {
    if (mods[mod]) acts.push({ type: "keyDown", value: mods[mod] });
    acts.push({ type: "keyDown", value: k }, { type: "keyUp", value: k });
    if (mods[mod]) acts.push({ type: "keyUp", value: mods[mod] });
    acts.push({ type: "pause", duration: 120 });
  }
  await post("/actions", { actions: [{ type: "key", id: "k", actions: acts }] });
  console.log(JSON.stringify({ ok: true }));
})();
