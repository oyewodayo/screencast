// node draghold.cjs down "<js expr returning an element>" <dx> [fx fy]   - press on the element and move
//                                                                        by dx in steps, WITHOUT releasing
// node draghold.cjs up                                                  - release
// For screenshotting a drag mid-move (the pointer stays down between the two calls).
const { post } = require("./raw.cjs");
(async () => {
  const [, , mode, expr, dxs, fxs, fys] = process.argv;
  if (mode === "up") {
    await post("/actions", { actions: [{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerUp", button: 0 }] }] });
    return console.log(JSON.stringify({ ok: true, released: true }));
  }
  const fx = fxs === undefined ? 0.5 : Number(fxs);
  const fy = fys === undefined ? 0.5 : Number(fys);
  const r = await post("/execute/sync", { script: `const el=(${expr}); if(!el) return null; const b=el.getBoundingClientRect(); return [Math.round(b.left+b.width*${fx}),Math.round(b.top+b.height*${fy})]`, args: [] });
  if (!r.value) return console.log(JSON.stringify({ ok: false, error: "not found" }));
  const [x, y] = r.value;
  const dx = Number(dxs);
  const acts = [{ type: "pointerMove", duration: 0, origin: "viewport", x, y }, { type: "pointerDown", button: 0 }];
  for (let i = 1; i <= 16; i++) acts.push({ type: "pointerMove", duration: 25, origin: "viewport", x: Math.round(x + (dx * i) / 16), y });
  await post("/actions", { actions: [{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: acts }] });
  console.log(JSON.stringify({ ok: true, from: [x, y], to: [x + dx, y] }));
})();
