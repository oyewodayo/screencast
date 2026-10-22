// node stagecap.cjs <outdir> <frames> <intervalMs> - saves the dialog stage canvas N times.
const fs=require('fs');const path=require('path');
const s=JSON.parse(fs.readFileSync(__dirname+'/session.json','utf-8'));const base=`http://localhost:${s.port}/session/${s.sessionId}`;
const [out,n='8',iv='400']=process.argv.slice(2);fs.mkdirSync(out,{recursive:true});
(async()=>{for(let i=0;i<+n;i++){const r=await (await fetch(base+'/execute/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({script:"const c=document.querySelector('[role=dialog] aside canvas');return c?c.toDataURL('image/jpeg',0.85):null",args:[]})})).json();
if(r.value)fs.writeFileSync(path.join(out,`f${String(i).padStart(2,'0')}.jpg`),Buffer.from(r.value.split(',')[1],'base64'));await new Promise(z=>setTimeout(z,+iv));}})();
