import { chromium } from "playwright-core";
import path from "node:path";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const shotDir = "C:\\Users\\DELL\\AppData\\Local\\Temp\\claude\\c--Users-DELL-Desktop-screencast\\156cd651-d17e-400b-abe3-5f5df98e65db\\scratchpad";

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message + "\n" + (e.stack || ""));
  console.log("[PAGEERROR]", e.message);
  console.log(e.stack);
});

await page.goto("http://localhost:5183/test-harness.html", { waitUntil: "networkidle" });
await page.waitForSelector("text=test-harness.png", { timeout: 15000 });

const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();

async function htmlLen() {
  return page.evaluate(() => document.getElementById("root")?.innerHTML.length ?? -1);
}

await page.locator('button:has-text("TextT")').click();
await page.waitForTimeout(100);
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
await page.waitForTimeout(150);
await page.keyboard.type("Rapid");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
console.log("after create, htmlLen:", await htmlLen());

// Auto-selected now (Select tool, chrome showing). Double-click twice in a row, minimal delay,
// same coordinates, simulating a "double double-click" / rapid repeated double-click.
const mh = page.locator('[title^="Drag to move"]').first();
const mbox = await mh.boundingBox();
const mx = mbox.x + mbox.width / 2;
const my = mbox.y + mbox.height / 2;

await page.mouse.dblclick(mx, my);
console.log("after 1st dblclick, htmlLen:", await htmlLen());
await page.mouse.dblclick(mx, my);
console.log("after 2nd dblclick (immediate), htmlLen:", await htmlLen());
await page.waitForTimeout(200);
console.log("after settle, htmlLen:", await htmlLen());
await page.screenshot({ path: path.join(shotDir, "crash-C2-double-double-click.png") });

// Also: click a THIRD time immediately (triple total in rapid succession).
await page.mouse.dblclick(mx, my);
await page.waitForTimeout(200);
console.log("after 3rd dblclick, htmlLen:", await htmlLen());
await page.screenshot({ path: path.join(shotDir, "crash-C3-triple-dblclick.png") });

console.log("TOTAL_ERRORS", errors.length);
await browser.close();
