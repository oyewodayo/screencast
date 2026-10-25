node driver.mjs eval "(()=>{window.__fr=[];let l=performance.now();const f=t=>{window.__fr.push(t-l);l=t;if(window.__fr.length<200)requestAnimationFrame(f)};requestAnimationFrame(f);return 1})()" >/dev/null
sleep 4
node driver.mjs eval "(()=>{const a=window.__fr.slice(5).sort((x,y)=>x-y);const avg=a.reduce((s,x)=>s+x,0)/a.length;return {n:a.length,avg:+avg.toFixed(1),p50:+a[Math.floor(a.length*0.5)].toFixed(1),p95:+a[Math.floor(a.length*0.95)].toFixed(1)}})()"
