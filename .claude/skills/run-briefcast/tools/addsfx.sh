#!/bin/sh
# addsfx.sh <seconds> "<search>" - puts the first sound effect matching the search at that time.
cd "$(dirname "$0")/.."
node driver.mjs eval "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.title==='Close'&&b.offsetParent&&b.parentElement.textContent.includes('Sound effects'));if(b)b.click();return 1})()" >/dev/null
sleep 0.4
node tools/seek.cjs "$1" >/dev/null
node tools/ui.cjs "[[\"title\",\"Add music & sound effects\"],[\"wait\",900],[\"btn\",\"Sound effects\"],[\"wait\",500],[\"ph\",\"Search sound effects\",\"$2\"],[\"wait\",700],[\"title\",\"Add at the playhead\"],[\"wait\",900]]" 300
