// node realclick.cjs "<js expression returning an element>" [double]
const {post}=require("./raw.cjs");
(async()=>{
  const r=await post("/execute/sync",{script:`const el=(${process.argv[2]}); if(!el) return null; el.scrollIntoView({block:"center"}); const b=el.getBoundingClientRect(); return [Math.round(b.left+b.width/2),Math.round(b.top+b.height/2)]`,args:[]});
  if(!r.value){console.log("not found");return;}
  const [x,y]=r.value; const n=process.argv[3]==="double"?2:1; const acts=[{type:"pointerMove",duration:0,origin:"viewport",x,y}];
  for(let i=0;i<n;i++) acts.push({type:"pointerDown",button:0},{type:"pointerUp",button:0});
  await post("/actions",{actions:[{type:"pointer",id:"m",parameters:{pointerType:"mouse"},actions:acts}]});
  console.log("clicked",x,y);
})();
