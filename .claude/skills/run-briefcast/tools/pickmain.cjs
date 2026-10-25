const fs=require('fs');const s=JSON.parse(fs.readFileSync(__dirname+'/session.json','utf-8'));const base=`http://localhost:${s.port}/session/${s.sessionId}`;
(async()=>{const h=(await (await fetch(base+'/window/handles')).json()).value;
for(const x of h){await fetch(base+'/window',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:x})});
const u=(await (await fetch(base+'/execute/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({script:'return location.href',args:[]})})).json()).value;
if(/tauri\.localhost\/?$/.test(u)){console.log('main',x);break;}}
await fetch(base+'/window/rect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x:0,y:0,width:1700,height:1050})});})();
