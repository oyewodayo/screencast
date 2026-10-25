const s=JSON.parse(require("fs").readFileSync(__dirname+"/session.json","utf-8"));
const base=`http://localhost:${s.port}/session/${s.sessionId}`;
module.exports.post=(p,b)=>fetch(base+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(r=>r.json());
module.exports.base=base;
