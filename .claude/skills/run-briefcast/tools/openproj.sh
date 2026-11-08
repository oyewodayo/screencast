#!/bin/sh
# openproj.sh "<project name prefix>" [WxH] - launch, pick the main window, open a video project
# from the home screen's recent list.
cd "$(dirname "$0")/.."
node driver.mjs launch >/dev/null
for i in 1 2 3 4 5; do sleep 2; node tools/mainwin.cjs "${2:-1500x1400}" | grep -q '"ok":true' && break; done
for i in 1 2 3 4 5 6; do
  r=$(node driver.mjs eval "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('$1'));if(!b)return 0;b.click();return 1})()")
  echo "$r" | grep -q '"value":1' && break; sleep 2
done
sleep 7
echo "$r"
