#!/bin/sh
# mkproject.sh "<regex of media titles>" "<style label or Custom>" "<extra js run in dialog>" - creates a project and exports it.
cd "$(dirname "$0")/.."
node driver.mjs eval "(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Back');b&&b.click();return 1})()" >/dev/null
sleep 2
node driver.mjs eval "(()=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Create video from images').click();return 1})()" >/dev/null
sleep 3
node driver.mjs eval "(()=>{const d=document.querySelector('[role=dialog]');const re=new RegExp('$1');const t=Array.from(d.querySelectorAll('button[data-thumb]')).filter(b=>re.test(b.title));t.forEach((b,i)=>setTimeout(()=>b.click(),i*120));return t.map(b=>b.title)})()"
sleep 3
node driver.mjs eval "(()=>{Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim().endsWith('$2')).click();return 1})()" >/dev/null
sleep 2
node driver.mjs eval "(()=>{$3;return 1})()" >/dev/null
sleep 3
node driver.mjs eval "(()=>{Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()==='Create video').click();return 1})()" >/dev/null
for i in $(seq 1 60); do n=$(node driver.mjs eval "document.querySelectorAll('[role=dialog]').length" | grep -o '"value":[0-9]*'); [ "$n" = '"value":0' ] && break; sleep 2; done
sleep 5
before=$(ls fixtures/library/*.mp4 | wc -l)
node driver.mjs eval "(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Save');b.click();return 1})()" >/dev/null
sleep 3
for i in $(seq 1 100); do t=$(node driver.mjs eval "Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>/Prepar|Render|%/.test(t)).join('|')" 2>/dev/null); case "$t" in *Prepar*|*%*|*Render*) sleep 3;; *) break;; esac; done
after=$(ls fixtures/library/*.mp4 | wc -l)
[ "$after" -gt "$before" ] && echo "EXPORTED $(ls -t fixtures/library/*.mp4 | head -1)" || echo FAILED
