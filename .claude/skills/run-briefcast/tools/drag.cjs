// node drag.cjs "<js expression returning an element>" <dx> <dy> [fx fy]
// A genuine WebDriver pointer drag from a point in the element (fractions fx, fy of its box; default
// the centre) by (dx, dy) CSS px, in steps, so onPointerMove handlers see a real drag.
const { post } = require("./raw.cjs");
(async () => {
  const [, , expr, dxs, dys, fxs, fys] = process.argv;
  const fx = fxs === undefined ? 0.5 : Number(fxs);
  const fy = fys === undefined ? 0.5 : Number(fys);
  const r = await post("/execute/sync", { script: `const el=(${expr}); if(!el) return null; const b=el.getBoundingClientRect(); return [Math.round(b.left+b.width*${fx}),Math.round(b.top+b.height*${fy})]`, args: [] });
  if (!r.value) return console.log(JSON.stringify({ ok: false, error: "not found" }));
  const [x, y] = r.value;
  const dx = Number(dxs);
  const dy = Number(dys);
  const acts = [{ type: "pointerMove", duration: 0, origin: "viewport", x, y }, { type: "pointerDown", button: 0 }];
  for (let i = 1; i <= 10; i++) acts.push({ type: "pointerMove", duration: 30, origin: "viewport", x: Math.round(x + (dx * i) / 10), y: Math.round(y + (dy * i) / 10) });
  acts.push({ type: "pointerUp", button: 0 });
  await post("/actions", { actions: [{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: acts }] });
  console.log(JSON.stringify({ ok: true, from: [x, y], to: [x + dx, y + dy] }));
})();
