// node fill.cjs "<js expression returning an input/textarea/select>" "<text>" [noenter]
// Replaces a field's contents the way a person would: click into it, select all, type, press Enter
// (unless "noenter"). For a <select>, picks the option whose label or value matches <text>.
const { post } = require("./raw.cjs");
(async () => {
  const [, , expr, text, flag] = process.argv;
  const r = await post("/execute/sync", {
    script: `const el=(${expr}); if(!el) return null; if(el.tagName==='SELECT'){const o=[...el.options].find(o=>o.textContent.trim()===arguments[0]||o.value===arguments[0]); if(!o) return 'no option'; const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(el,o.value); el.dispatchEvent(new Event('change',{bubbles:true})); return 'selected'} el.scrollIntoView({block:'center'}); const b=el.getBoundingClientRect(); return [Math.round(b.left+Math.min(20,b.width/2)),Math.round(b.top+b.height/2)]`,
    args: [text],
  });
  if (r.value === null) return console.log(JSON.stringify({ ok: false, error: "not found" }));
  if (typeof r.value === "string") return console.log(JSON.stringify({ ok: r.value === "selected", result: r.value }));
  const [x, y] = r.value;
  const keys = [{ type: "keyDown", value: "" }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: "" }];
  for (const ch of text) keys.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch });
  if (flag !== "noenter") keys.push({ type: "keyDown", value: "" }, { type: "keyUp", value: "" });
  await post("/actions", {
    actions: [
      { type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 0, origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] },
    ],
  });
  await post("/actions", { actions: [{ type: "key", id: "k", actions: keys }] });
  console.log(JSON.stringify({ ok: true }));
})();
