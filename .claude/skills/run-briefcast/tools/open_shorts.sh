#!/usr/bin/env bash
# Launches Briefcast, opens shorts_talk_test.mp4 in the editor and opens the Shorts studio.
cd "$(dirname "$0")/../../../.." || exit 1
D=.claude/skills/run-briefcast/driver.mjs
RC=.claude/skills/run-briefcast/tools/realclick.cjs
waitfor() { for i in $(seq 1 60); do r=$(node $D eval "$1"); echo "$r" | grep -q '"value":true' && return 0; sleep 1; done; echo "timeout: $1"; return 1; }
node $D launch >/dev/null
node -e '
const {post,base}=require("./.claude/skills/run-briefcast/tools/raw.cjs");
(async()=>{ const hs=(await (await fetch(base+"/window/handles")).json()).value;
 for(const h of hs){ await post("/window",{handle:h}); const u=(await post("/execute/sync",{script:"return location.href",args:[]})).value; if(/^https?:\/\/tauri\.localhost\/$/.test(u)) break; }
 await post("/window/maximize",{});})()'
waitfor "(() => !!document.querySelector('button[title=\"Toggle file list\"]'))()" || exit 1
node $D eval "(() => { document.querySelector('button[title=\"Toggle file list\"]').click(); return 1 })()" >/dev/null; sleep 1
node $RC "Array.from(document.querySelectorAll('div')).find(e=>e.children.length===0 && e.textContent.trim()==='shorts_talk_test.mp4')" >/dev/null; sleep 3
waitfor "(() => !!document.querySelector('button[title=\"Show tools for this file\"]'))()" || exit 1
node $D eval "(() => { document.querySelector('button[title=\"Show tools for this file\"]').click(); return 1 })()" >/dev/null
waitfor "(() => !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Shorts' && !b.disabled))()" || exit 1
node $D eval "(() => { Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Shorts').click(); return 1 })()" >/dev/null
waitfor "(() => document.querySelectorAll('textarea[placeholder=\"Add a title\"]').length > 0)()" || exit 1
echo "studio open"
