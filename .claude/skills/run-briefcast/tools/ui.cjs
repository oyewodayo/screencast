// node ui.cjs '<steps as JSON>' [pauseMs] - drives the app's own controls step by step, paced so a
// person can watch: real pointer clicks and real typing (WebDriver Actions), never state injection.
// Steps (arrays): ["btn", text] exact button text · ["title", prefix] button whose title starts so ·
// ["aria", label] · ["field", label, value] ScrubField (X/Y/W/H/Turn/Scale) · ["slider", label, value]
// a SliderRow's number · ["ph", placeholder, value] input/textarea by placeholder · ["hex", afterText,
// value] the custom colour field after a heading · ["select", afterText, optionText] · ["switch",
// label] a toggle · ["row", text] an element row in the list · ["wait", ms] · ["key", key].
const { post } = require("./raw.cjs");
const steps = JSON.parse(process.argv[2].startsWith("@") ? require("fs").readFileSync(process.argv[2].slice(1), "utf8") : process.argv[2]);
const pause = Number(process.argv[3] ?? 350);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = async (script, args = []) => (await post("/execute/sync", { script, args })).value;

const FIND = {
  btn: `return [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===arguments[0]&&b.offsetParent)`,
  title: `const [t,nth]=arguments[0].split('#');return [...document.querySelectorAll('button,[role=switch]')].filter(b=>(b.title||'').startsWith(t)&&b.offsetParent)[Number(nth||0)]`,
  aria: `return [...document.querySelectorAll('button')].reverse().find(b=>b.getAttribute('aria-label')===arguments[0]&&b.offsetParent)`,
  field: `const l=[...document.querySelectorAll('label')].find(x=>x.firstElementChild&&x.firstElementChild.textContent.trim()===arguments[0]&&x.offsetParent);return l&&l.querySelector('input')`,
  // "Label" or "Label#n" for the n-th (from 0) slider with that label.
  slider: `const [lab,nth]=arguments[0].split('#');const ss=[...document.querySelectorAll('span')].filter(x=>x.className.includes('w-[58px]')&&x.childNodes[0]&&x.childNodes[0].textContent.trim()===lab&&x.offsetParent);const s=ss[Number(nth||0)];return s&&s.parentElement.querySelector('input')`,
  ph: `return [...document.querySelectorAll('input,textarea')].find(x=>(x.placeholder||'').startsWith(arguments[0])&&x.offsetParent)`,
  hex: `const all=[...document.querySelectorAll('*')];const h=all.find(x=>x.children.length===0&&x.textContent.trim()===arguments[0]&&x.offsetParent);if(!h)return null;const ins=[...document.querySelectorAll('input')].filter(i=>i.offsetParent&&(h.compareDocumentPosition(i)&4)&&/^[0-9A-Fa-f]{0,8}$/.test(i.value)&&i.value.length>=3);return ins[0]`,
  select: `const all=[...document.querySelectorAll('*')];const h=all.find(x=>x.children.length===0&&x.textContent.trim()===arguments[0]&&x.offsetParent);if(!h)return null;return [...document.querySelectorAll('select')].find(s=>s.offsetParent&&(h.compareDocumentPosition(s)&4))`,
  switch: `return [...document.querySelectorAll('[role=switch]')].find(b=>(b.textContent.trim()===arguments[0]||b.getAttribute('aria-label')===arguments[0])&&b.offsetParent)`,
  ti: `return [...document.querySelectorAll('input,select,textarea')].find(x=>(x.title||'').startsWith(arguments[0])&&x.offsetParent)`,
  // ["sfx", "Name#n"]: the add (+) button on the n-th library row titled exactly Name.
  sfx: `const [nm,nth]=arguments[0].split('#');const t=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent.trim()===nm&&e.offsetParent)[Number(nth||0)];if(!t)return null;let r=t;for(let i=0;i<6;i++){r=r.parentElement;const bs=[...r.querySelectorAll('button')];if(bs.length>=2)return bs[bs.length-1]}return null`,
  val: `return [...document.querySelectorAll('input')].find(x=>x.value===arguments[0]&&x.offsetParent)`,
  btns: `return [...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(arguments[0])&&b.offsetParent)`,
  row: `return [...document.querySelectorAll('[role=button]')].find(b=>b.textContent.trim().startsWith(arguments[0])&&b.offsetParent)`,
};

async function point(find, arg) {
  // Never act while a dialog is up (a stray click there once started a screen recording), and check
  // that what's actually under the pointer is the element meant - nothing else gets clicked.
  const r = await exec(
    `if(document.querySelector('[role=dialog]')) return 'dialog'; const el=(()=>{${find}})(); if(!el) return null; el.scrollIntoView({block:'center'}); const b=el.getBoundingClientRect(); const x=Math.round(b.left+Math.min(b.width/2, 24)), y=Math.round(b.top+b.height/2); const hit=document.elementFromPoint(x,y); if(!hit||!(el===hit||el.contains(hit)||hit.contains(el))) return 'covered'; const hb=hit.closest('button'); if(hb&&(/record|stop/i.test(hb.title||'')||/^(Stop|Start Recording)$/.test(hb.textContent.trim()))) return 'record'; return [x,y]`,
    [arg]
  );
  if (!r) throw new Error(`not found: ${arg}`);
  if (typeof r === "string") throw new Error(`refused (${r}): ${arg}`);
  return r;
}
async function click(x, y) {
  await post("/actions", { actions: [{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 120, origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
}
async function type(text, enter = true) {
  const keys = [{ type: "keyDown", value: "" }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: "" }];
  for (const ch of text) keys.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch });
  if (enter) keys.push({ type: "keyDown", value: "" }, { type: "keyUp", value: "" });
  await post("/actions", { actions: [{ type: "key", id: "k", actions: keys }] });
}

(async () => {
  for (const [op, a, b] of steps) {
    if (op === "wait") {
      await sleep(a);
      continue;
    }
    if (op === "key") {
      await post("/actions", { actions: [{ type: "key", id: "k", actions: [{ type: "keyDown", value: a }, { type: "keyUp", value: a }] }] });
      await sleep(pause);
      continue;
    }
    // ["nth", text, n]: the n-th element row (from 0) with this text - selected unless it already is.
    if (op === "nth") {
      const r = await exec(`const rows=[...document.querySelectorAll('[role=button]')].filter(r=>r.textContent.trim()===arguments[0]&&r.offsetParent); const r=rows[arguments[1]]; if(!r) return 'none'; if(r.className.includes('bg-teal')) return 'ok'; r.scrollIntoView({block:'center'}); r.click(); return 'ok'`, [a, b]);
      if (r !== "ok") throw new Error(`nth ${a} ${b}: ${r}`);
      await sleep(pause);
      continue;
    }
    if (op === "seltitle") {
      const r = await exec(`const s=[...document.querySelectorAll('select')].find(x=>(x.title||'').startsWith(arguments[0])&&x.offsetParent); if(!s) return 'no select'; const o=[...s.options].find(o=>o.textContent.trim().startsWith(arguments[1])); if(!o) return 'no option'; s.scrollIntoView({block:'center'}); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,o.value); s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'`, [a, b]);
      if (r !== "ok") throw new Error(`seltitle ${a} ${b}: ${r}`);
      await sleep(pause);
      continue;
    }
    if (op === "select") {
      const r = await exec(`const s=(()=>{${FIND.select}})(); if(!s) return 'no select'; const o=[...s.options].find(o=>o.textContent.trim().startsWith(arguments[1])); if(!o) return 'no option'; s.scrollIntoView({block:'center'}); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,o.value); s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'`, [a, b]);
      if (r !== "ok") throw new Error(`select ${a} ${b}: ${r}`);
      await sleep(pause);
      continue;
    }
    // A row already selected stays so - clicking it again would let it go.
    if (op === "row" && (await exec(`const r=(()=>{${FIND.row}})(); return !!r && r.className.includes('bg-teal')`, [a]))) {
      await sleep(pause);
      continue;
    }
    const [x, y] = await point(FIND[op], a);
    await click(x, y);
    if (b !== undefined) {
      await sleep(120);
      await type(String(b), op !== "ph" || !String(b).includes("\n"));
    }
    await sleep(pause);
  }
  console.log(JSON.stringify({ ok: true, steps: steps.length }));
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
  process.exit(1);
});
