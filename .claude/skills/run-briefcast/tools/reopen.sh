#!/bin/sh
# reopen.sh "<scene block label>" - relaunch Briefcast on the showcase project, maximised, with that scene selected.
cd "$(dirname "$0")/.."
sh tools/openproj.sh "Briefcas" >/dev/null
node -e "const {post}=require('./tools/raw.cjs');(async()=>{await post('/window/maximize',{})})()"
sleep 4
node tools/realclick.cjs "[...document.querySelectorAll('span')].find(e=>e.children.length===0&&e.textContent.trim().startsWith('$1')&&e.getBoundingClientRect().top>600)"
sleep 1.2
