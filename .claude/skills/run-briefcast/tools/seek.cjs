// node seek.cjs <seconds> - clicks the timeline ruler at that time. Scale and offset come from any two
// ruler labels on screen (m:ss), so it works scrolled or zoomed; the time must be visible on the ruler.
const { post } = require("./raw.cjs");
(async () => {
  const t = Number(process.argv[2]);
  const r = await post("/execute/sync", {
    script: `const ls=[...document.querySelectorAll('span,div')].filter(e=>e.children.length===0&&/^\\d+:\\d\\d$/.test(e.textContent.trim())).map(e=>{const b=e.getBoundingClientRect();const [m,s]=e.textContent.trim().split(':').map(Number);return {t:m*60+s,x:b.left,y:b.top+b.height/2,w:b.width}}).filter(l=>l.x>40);
      // The ruler row: the y most labels share.
      const ys={};for(const l of ls){const k=Math.round(l.y);ys[k]=(ys[k]||0)+1}
      const y=Number(Object.entries(ys).sort((a,b)=>b[1]-a[1])[0]?.[0]);
      const row=ls.filter(l=>Math.abs(l.y-y)<2).sort((a,b)=>a.t-b.t);
      if(row.length<2)return null;
      const a=row[0],b=row[row.length-1];return [a.x,(b.x-a.x)/(b.t-a.t),a.t,y]`,
    args: [],
  });
  if (!r.value) return console.log("ruler not found");
  const [x0, perSec, t0, y] = r.value;
  const x = Math.round(x0 + perSec * (t - t0));
  await post("/actions", { actions: [{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 0, origin: "viewport", x, y: Math.round(y) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
  await new Promise((z) => setTimeout(z, 400));
  const now = (await post("/execute/sync", { script: "return document.querySelector('video')?.currentTime ?? null", args: [] })).value;
  console.log("seeked", t, "->", now);
})();
