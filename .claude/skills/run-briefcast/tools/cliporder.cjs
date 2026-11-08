// Prints the clip lane's order, identifying each clip by the tail of its thumbnail URL (unique per photo).
const { post } = require("./raw.cjs");
(async () => {
  const r = await post("/execute/sync", { script: "return [...document.querySelectorAll('.tl-clip')].map(c=>{const i=c.querySelector('img');return i?decodeURIComponent(i.src).slice(-22,-4):'?'})", args: [] });
  console.log((r.value || []).map((s, i) => `${i}:${s}`).join("  "));
})();
