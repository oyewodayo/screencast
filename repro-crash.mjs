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
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text());
});

await page.goto("http://localhost:5183/test-harness.html", { waitUntil: "networkidle" });
await page.waitForSelector("text=test-harness.png", { timeout: 15000 });

const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();

async function isBlank() {
  const rootText = await page.locator("#root").innerText().catch(() => "<error reading root>");
  const bodyHtmlLen = await page.evaluate(() => document.getElementById("root")?.innerHTML.length ?? -1);
  return { rootTextEmpty: rootText.trim().length === 0, bodyHtmlLen };
}

// Create text "First".
await page.locator('button:has-text("TextT")').click();
await page.waitForTimeout(100);
await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
await page.waitForTimeout(150);
await page.keyboard.type("First");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
console.log("after create First:", JSON.stringify(await isBlank()));

// Create text "Second".
await page.locator('button:has-text("TextT")').click();
await page.waitForTimeout(100);
await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
await page.waitForTimeout(150);
await page.keyboard.type("Second");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
console.log("after create Second:", JSON.stringify(await isBlank()));
await page.screenshot({ path: path.join(shotDir, "crash-01-both-created.png") });

// "Second" is now auto-selected+select tool. Double-click it to edit (first double-click test).
const secondHandle = page.locator('[title^="Drag to move"]').first();
let hbox = await secondHandle.boundingBox();
await page.mouse.dblclick(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
await page.waitForTimeout(200);
console.log("after dblclick Second (1st time):", JSON.stringify(await isBlank()));
await page.screenshot({ path: path.join(shotDir, "crash-02-second-editing.png") });

// Type more, commit.
await page.keyboard.type("!!");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
console.log("after commit Second edit:", JSON.stringify(await isBlank()));

// Now double-click "Second" AGAIN (second double-click on the same, now re-selected, object).
hbox = await page.locator('[title^="Drag to move"]').first().boundingBox();
await page.mouse.dblclick(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
await page.waitForTimeout(200);
console.log("after 2nd dblclick on Second:", JSON.stringify(await isBlank()));
await page.screenshot({ path: path.join(shotDir, "crash-03-second-dblclick-again.png") });

// Commit again, then double-click on "First" (the OTHER/second-created-differs text object).
await page.keyboard.press("Enter");
await page.waitForTimeout(200);

// Select tool, click First to select it, then double-click it.
await page.locator('button:has-text("Select / moveV")').click();
await page.waitForTimeout(100);
await page.mouse.click(box.x + box.width * 0.3 + 5, box.y + box.height * 0.3 + 5);
await page.waitForTimeout(150);
console.log("after selecting First:", JSON.stringify(await isBlank()));

const firstHandle = page.locator('[title^="Drag to move"]').first();
const fbox = await firstHandle.boundingBox();
if (fbox) {
  await page.mouse.dblclick(fbox.x + fbox.width / 2, fbox.y + fbox.height / 2);
  await page.waitForTimeout(200);
}
console.log("after dblclick First:", JSON.stringify(await isBlank()));
await page.screenshot({ path: path.join(shotDir, "crash-04-first-editing.png") });

console.log("TOTAL_ERRORS", errors.length);
for (const e of errors) console.log("ERROR_DETAIL:\n", e);

await browser.close();
