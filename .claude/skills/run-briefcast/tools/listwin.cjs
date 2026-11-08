const fs=require('fs');const s=JSON.parse(fs.readFileSync(__dirname+'/session.json','utf-8'));const base=`http://localhost:${s.port}/session/${s.sessionId}`;
const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
(async()=>{const h=(await (await fetch(base+'/window/handles')).json()).value;const out=[];
for(const x of h){await post('/window',{handle:x});const u=(await post('/execute/sync',{script:'return [location.href, document.visibilityState, document.body ? document.body.innerText.slice(0,60) : ""]',args:[]})).value;out.push({x,u});}
console.log(JSON.stringify(out,null,1));})();
