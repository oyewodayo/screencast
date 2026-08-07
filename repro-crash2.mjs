import { chromium } from "playwright-core";
import path from "node:path";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const shotDir = "C:\\Users\\DELL\\AppData\\Local\\Temp\\claude\\c--Users-DELL-Desktop-screencast\\156cd651-d17e-400b-abe3-5f5df98e65db\\scratchpad";

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message + "\n" + (e.stack || ""));
  console.log("[PAGEERROR]", e.message, e.stack);
});

await page.goto("http://localhost:5183/test-harness.html", { waitUntil: "networkidle" });
await page.waitForSelector("text=test-harness.png", { timeout: 15000 });

const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();

async function isBlank() {
  const bodyHtmlLen = await page.evaluate(() => document.getElementById("root")?.innerHTML.length ?? -1);
  return bodyHtmlLen;
}

await page.locator('button:has-text("TextT")').click();
await page.waitForTimeout(100);
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
await page.waitForTimeout(150);
await page.keyboard.type("Del");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);

// Scenario A: double-click directly on the delete "x" button (top-left corner overlap).
const deleteBtn = page.locator('button[title="Delete text"]').first();
const dbox = await deleteBtn.boundingBox();
console.log("DELETE_BTN_BOX", JSON.stringify(dbox));
await page.mouse.dblclick(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2);
await page.waitForTimeout(200);
console.log("after dblclick delete button, htmlLen:", await isBlank());
await page.screenshot({ path: path.join(shotDir, "crash-A-after-delete-dblclick.png") });

// Recreate for scenario B.
await page.locator('button:has-text("TextT")').click();
await page.waitForTimeout(100);
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
await page.waitForTimeout(150);
await page.keyboard.type("Rapid");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);

// Scenario B: rapid multi-click (4 clicks in quick succession) on the move handle.
const moveHandle = page.locator('[title^="Drag to move"]').first();
const mbox = await moveHandle.boundingBox();
const mx = mbox.x + mbox.width / 2;
const my = mbox.y + mbox.height / 2;
for (let i = 0; i < 4; i++) {
  await page.mouse.click(mx, my, { clickCount: 1, delay: 10 });
}
await page.waitForTimeout(200);
console.log("after rapid 4-click, htmlLen:", await isBlank());
await page.screenshot({ path: path.join(shotDir, "crash-B-after-rapid-click.png") });

// Scenario C: double-click, type, then IMMEDIATELY double-click again without waiting (no delay).
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(100);
const mh2 = await page.locator('[title^="Drag to move"]').first().boundingBox();
if (mh2) {
  await page.mouse.dblclick(mh2.x + mh2.width / 2, mh2.y + mh2.height / 2);
  await page.keyboard.type("X");
  // No wait - immediately try to double click again on where the (now-editing) input roughly is.
  await page.mouse.dblclick(mh2.x + mh2.width / 2, mh2.y + mh2.height / 2);
  await page.waitForTimeout(200);
}
console.log("after immediate re-dblclick during edit, htmlLen:", await isBlank());
await page.screenshot({ path: path.join(shotDir, "crash-C-immediate-redblclick.png") });

console.log("TOTAL_ERRORS", errors.length);
await browser.close();
