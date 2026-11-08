const fs=require('fs');const s=JSON.parse(fs.readFileSync(__dirname+'/session.json','utf-8'));const base=`http://localhost:${s.port}/session/${s.sessionId}`;
const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
(async()=>{
const order=async()=> (await post('/execute/sync',{script:"return Array.from(document.querySelectorAll('[data-sequence-tile] img')).map(i=>i.src.split('/').pop().slice(-20))",args:[]})).value;
const rects=(await post('/execute/sync',{script:"return Array.from(document.querySelectorAll('[data-sequence-tile]')).map(e=>{const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})",args:[]})).value;
console.log('before',await order());
const [x0,y0]=rects[0],[x3]=rects[3];
const steps=[{type:'pointerMove',duration:0,origin:'viewport',x:Math.round(x0),y:Math.round(y0)},{type:'pointerDown',button:0}];
for(let k=1;k<=10;k++)steps.push({type:'pointerMove',duration:40,origin:'viewport',x:Math.round(x0+(x3+20-x0)*k/10),y:Math.round(y0)});
steps.push({type:'pointerUp',button:0});
console.log(JSON.stringify(await post('/actions',{actions:[{type:'pointer',id:'m',parameters:{pointerType:'mouse'},actions:steps}]})));
console.log('after',await order());})();
