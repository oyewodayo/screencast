// node elss.cjs "<css selector>" out.png  - screenshot of one element (WebDriver element screenshot)
const fs = require("fs");
const { post, base } = require("./raw.cjs");
(async () => {
  const [, , sel, out] = process.argv;
  const el = await post("/element", { using: "css selector", value: sel });
  const id = el.value && Object.values(el.value)[0];
  if (!id) return console.log(JSON.stringify({ ok: false, error: "not found", raw: el }));
  const shot = await (await fetch(`${base}/element/${id}/screenshot`)).json();
  fs.writeFileSync(out, Buffer.from(shot.value, "base64"));
  console.log(JSON.stringify({ ok: true, saved: out }));
})();
