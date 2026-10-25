#!/bin/sh
# Launch, select main window, open Create video dialog, pick N photos.
cd "$(dirname "$0")/.."
node driver.mjs launch >/dev/null
node tools/pickmain.cjs >/dev/null
sleep 1
node driver.mjs eval "(()=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Edit a video').click();return 1})()" >/dev/null
sleep 2
node driver.mjs eval "(()=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Create video from images').click();return 1})()" >/dev/null
sleep 2
node driver.mjs eval "(()=>{const tiles=Array.from(document.querySelectorAll('[role=dialog] button[title\$=\".jpg\"]'));tiles.slice(0,${1:-9}).forEach((b,i)=>setTimeout(()=>b.click(),i*120));return tiles.length})()"
