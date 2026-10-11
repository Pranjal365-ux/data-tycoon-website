// End-to-end browser test of the player and organizer flows.
//
//   python server.py                      # with .env pointing at a test database
//   BASE_URL=http://127.0.0.1:8000 CONSOLE_PATH=... ADMIN_PASSWORD=... node tests/e2e/e2e.cjs
//
// Requires the `playwright` package (npm i -D playwright) and a Chromium build.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const CONSOLE = process.env.CONSOLE_PATH;
const PASSWORD = process.env.ADMIN_PASSWORD;
const SHOTS = process.env.SCREENSHOT_DIR || path.join(__dirname, "screenshots");
const RUN = Date.now().toString(36).slice(-5);
fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(error.message).split("\n")[0]}`);
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

let adminToken = "";
async function admin(pathname, { method = "GET", body } = {}) {
  if (!adminToken) {
    const login = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Console-Key": CONSOLE }, body: JSON.stringify({ password: PASSWORD }) });
    adminToken = (await login.json()).token;
  }
  const response = await fetch(`${BASE}/api${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Console-Key": CONSOLE, Authorization: `Bearer ${adminToken}` },
    body: body ? JSON.stringify(body) : undefined
  });
  return response.json();
}

async function alerts(teamId, kind = "alerts") {
  const data = await admin(`/admin/dashboard?kind=${kind}&team=${encodeURIComponent(teamId)}`);
  return data.activities.map(item => item.kind);
}

async function signIn(page, teamId, pin) {
  await page.goto(BASE + "/");
  await page.fill("#teamId", teamId);
  await page.fill("#pin", pin);
  await page.click("#loginForm button[type=submit]");
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

  await admin("/admin/settings", { method: "PATCH", body: { flashTimer: false, roundWait: true } });
  const team = `E2E ${RUN}`;

  console.log("Player flow");
  await check("login page renders without organizer link", async () => {
    await page.goto(BASE + "/");
    await page.waitForSelector("#loginForm");
    const html = (await page.content()).toLowerCase();
    assert(!html.includes("organizer portal") && !html.includes("admin"), "organizer link still present");
    await page.screenshot({ path: `${SHOTS}/01-login.png`, fullPage: true });
  });

  await check("paste works in the PIN field outside a flash", async () => {
    await page.fill("#pin", "");
    await page.evaluate(() => {
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      document.querySelector("#pin").dispatchEvent(event);
      window.__pasteBlocked = event.defaultPrevented;
    });
    assert(!(await page.evaluate(() => window.__pasteBlocked)), "paste was blocked");
  });

  await check("wrong PIN shows a clear error", async () => {
    await signIn(page, team, "1234");
    await page.waitForSelector(".step");
    await page.click('[data-action="sign-out"]');
    await page.click("#confirmOk");
    await page.waitForSelector("#loginForm");
    await page.fill("#teamId", team);
    await page.fill("#pin", "0000");
    await page.click("#loginForm button[type=submit]");
    const text = await page.textContent(".form-error");
    assert(/PIN does not match/.test(text), text);
  });

  await check("sign in lands on industry choice with clear steps", async () => {
    await page.fill("#pin", "1234");
    await page.click("#loginForm button[type=submit]");
    await page.waitForSelector(".industry-grid");
    const steps = await page.$$eval(".step", nodes => nodes.map(node => node.textContent.replace(/\s+/g, " ").trim()));
    assert(steps.length === 4, "expected 4 steps");
    assert(await page.isVisible(".next-step"), "next step banner missing");
    await page.screenshot({ path: `${SHOTS}/02-industry.png`, fullPage: true });
  });

  await check("choosing an industry asks for confirmation and locks it", async () => {
    await page.click('[data-action="choose-industry"][data-industry="Food"]');
    await page.waitForSelector("#confirmDialog[open]");
    await page.click("#confirmOk");
    await page.waitForSelector(".tasks");
    assert((await page.textContent("#teamChip")).includes("Food"), "team chip missing industry");
    await page.screenshot({ path: `${SHOTS}/03-round.png`, fullPage: true });
  });

  await check("dataset and table are locked before the flash", async () => {
    assert(await page.isDisabled('[data-action="download-dataset"]'), "download should be disabled");
    assert(await page.isDisabled("input[data-param]"), "inputs should be disabled");
  });

  await check("flash opens with all pages rendered and a watermark", async () => {
    await page.click('.task [data-action="open-flash"]');
    await page.waitForSelector("#flash:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#flashPages canvas").length === 6, null, { timeout: 15000 });
    const watermark = await page.$eval("#flashWatermark", el => getComputedStyle(el).backgroundImage);
    assert(watermark.startsWith("url("), "watermark missing");
    assert(await page.evaluate(() => document.querySelector("#appRoot").inert), "app behind flash should be inert");
    await page.screenshot({ path: `${SHOTS}/04-flash.png` });
  });

  await check("moving focus inside the flash does not raise a false alert", async () => {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(600);
    assert(!(await page.isVisible("#flashShield")), "shield shown for in-page focus change");
    const kinds = await alerts(team, "all");
    assert(!kinds.includes("window-blur"), `false alert: ${kinds.join(",")}`);
  });

  await check("pointer leaving through the window edge blanks the flash", async () => {
    await page.mouse.move(640, 400);
    await page.evaluate(() => document.dispatchEvent(new MouseEvent("mouseout", { clientX: 640, clientY: -1, bubbles: true })));
    assert(await page.isVisible("#flashShield"), "shield not shown");
    await page.mouse.move(600, 420, { steps: 3 });
    assert(!(await page.isVisible("#flashShield")), "shield should clear when pointer returns");
  });

  await check("Win/Cmd+Shift blanks the flash and alerts the organizer", async () => {
    await page.keyboard.down("Meta");
    await page.keyboard.down("Shift");
    assert(await page.isVisible("#flashShield"), "shield not shown");
    await page.screenshot({ path: `${SHOTS}/05-shield.png` });
    await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
    await page.waitForTimeout(800);
    assert(!(await page.isVisible("#flashShield")), "shield should clear after release");
  });

  await check("Print Screen (delivered on key release, as on Windows) is reported", async () => {
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keyup", { key: "PrintScreen", code: "PrintScreen", bubbles: true })));
    await page.waitForTimeout(500);
  });

  await check("leaving the window locks the flash and reports it", async () => {
    await page.waitForTimeout(2600);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    assert(await page.isVisible("#flashShield"), "shield not shown on blur");
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForSelector("#flashLeaveCard:not([hidden])");
    await page.screenshot({ path: `${SHOTS}/06-left-flash.png` });
    await page.click("#flashLeaveCard button");
    assert(!(await page.isVisible("#flashShield")), "shield should clear after continuing");
  });

  await check("organizer sees screenshot and tab-switch alerts", async () => {
    await page.waitForTimeout(800);
    const kinds = await alerts(team, "all");
    for (const kind of ["screenshot-suspected", "screenshot-shortcut", "window-blur", "focus-return"]) {
      assert(kinds.includes(kind), `missing ${kind}; got ${kinds.join(",")}`);
    }
  });

  await check("copy and context menu are blocked inside the flash", async () => {
    const blocked = await page.evaluate(() => {
      const copy = new ClipboardEvent("copy", { bubbles: true, cancelable: true });
      const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.querySelector("#flashPages").dispatchEvent(copy);
      document.querySelector("#flashPages").dispatchEvent(menu);
      return copy.defaultPrevented && menu.defaultPrevented;
    });
    assert(blocked, "copy/contextmenu not blocked");
  });

  await check("closing the flash unlocks the dataset without a reload", async () => {
    await page.click("#flashClose");
    await page.waitForSelector("#flash", { state: "hidden" });
    await page.waitForSelector('[data-action="download-dataset"]:not([disabled])');
  });

  await check("dataset downloads with the right file", async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click('.task [data-action="download-dataset"]')]);
    assert(download.suggestedFilename() === "food-round-1.xlsx", download.suggestedFilename());
    await page.waitForSelector("input[data-param]:not([disabled])");
  });

  await check("allocation table validates live and submits", async () => {
    const inputs = await page.$$("input[data-param]");
    assert(inputs.length === 10, "expected 10 parameters");
    await inputs[0].fill("500");
    assert((await page.textContent("#allocMessage")).includes("at least"), "minimum not flagged");
    for (const input of inputs) await input.fill("100000");
    assert((await page.textContent("#allocMessage")).includes("Ready"), "should be ready");
    await page.screenshot({ path: `${SHOTS}/07-allocation.png`, fullPage: true });
    await page.click("#submitRound");
    await page.click("#confirmOk");
    await page.waitForSelector(".result-card");
    assert(await page.isVisible('[data-countdown="wait"]'), "wait countdown missing");
    await page.screenshot({ path: `${SHOTS}/08-results.png`, fullPage: true });
  });

  await check("organizer removing the wait opens the next round live (no reload)", async () => {
    await admin("/admin/settings", { method: "PATCH", body: { roundWait: false } });
    await page.waitForSelector('.next-round [data-action="advance"]', { timeout: 12000 });
  });

  await check("round 2 starts with the carried balance plus bonus", async () => {
    const payout = await page.$eval(".result-numbers b", el => el.textContent);
    await page.click('.next-round [data-action="advance"]');
    await page.waitForSelector(".tasks");
    const budget = await page.$eval(".stats dd", el => el.textContent);
    const expected = Number(payout.replace(/[^\d]/g, "")) + 250000;
    assert(Number(budget.replace(/[^\d]/g, "")) === expected, `${budget} != ${expected}`);
  });

  await check("organizer balance change reaches the player live", async () => {
    await admin("/admin/team-balance", { method: "PATCH", body: { teamKey: team.toLowerCase(), companyValue: 1500000 } });
    await page.waitForFunction(() => document.querySelector(".stats dd")?.textContent.includes("17,50,000"), null, { timeout: 12000 });
    await page.waitForSelector(".toast");
  });

  await check("flash timer on locks the close button", async () => {
    await admin("/admin/settings", { method: "PATCH", body: { flashTimer: true } });
    await page.waitForTimeout(5500);
    await page.click('.task [data-action="open-flash"]');
    await page.waitForSelector("#flash:not([hidden])");
    assert(await page.isDisabled("#flashClose"), "close should be locked");
    assert((await page.textContent("#flashTimer")).startsWith("Locked"), "timer text missing");
  });

  await check("reloading during a locked flash reopens it", async () => {
    await page.reload();
    await page.waitForSelector("#flash:not([hidden])", { timeout: 10000 });
    assert(await page.isDisabled("#flashClose"), "lock lost after reload");
  });

  await check("turning the timer off lets the player close it live", async () => {
    await admin("/admin/settings", { method: "PATCH", body: { flashTimer: false } });
    await page.waitForSelector("#flashClose:not([disabled])", { timeout: 12000 });
    await page.click("#flashClose");
    await page.waitForSelector("#flash", { state: "hidden" });
  });

  await check("leaderboard highlights the team", async () => {
    await page.click('.step[data-view="leaderboard"]');
    await page.waitForSelector("tr.me");
    await page.screenshot({ path: `${SHOTS}/09-leaderboard.png`, fullPage: true });
  });

  await check("signing in on a second device signs the first one out (one device per team)", async () => {
    const other = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await other.newPage();
    await signIn(phone, team.toUpperCase(), "1234");
    await phone.waitForSelector(".tasks");
    assert((await phone.textContent(".round-head h1")).includes("Round 2"), "second device sees wrong round");
    await phone.screenshot({ path: `${SHOTS}/10-mobile-round.png`, fullPage: true });
    await phone.click('.step[data-view="results"]');
    await phone.screenshot({ path: `${SHOTS}/11-mobile-results.png`, fullPage: true });
    await page.waitForSelector("#loginForm", { timeout: 12000 });
    assert((await page.textContent(".form-error")).includes("another device"), "no explanation on the first device");
    await other.close();
    await signIn(page, team, "1234");
    await page.waitForSelector(".tasks");
  });

  await check("organizer PIN reset signs the player out automatically", async () => {
    await page.click('.step[data-view="round"]');
    await admin("/admin/team-reset-pin", { method: "POST", body: { teamKey: team.toLowerCase() } });
    await page.waitForSelector("#loginForm", { timeout: 12000 });
    assert((await page.textContent(".form-error")).length > 10, "no sign-out message");
  });

  console.log("Organizer console");
  const adminPage = await context.newPage();
  adminPage.on("pageerror", error => errors.push(`console: ${error.message}`));
  await check("console signs in and shows teams and alerts", async () => {
    await adminPage.goto(`${BASE}/${CONSOLE}/`);
    await adminPage.fill("#adminPassword", PASSWORD);
    await adminPage.click("#adminLoginForm button");
    await adminPage.waitForSelector("#dashboard:not([hidden])");
    await adminPage.waitForFunction(name => document.querySelector("#teamsBody")?.textContent.includes(name), team);
    await adminPage.waitForSelector(".activity-item.alert");
    await adminPage.screenshot({ path: `${SHOTS}/12-console.png`, fullPage: true });
  });

  await check("console timer toggle works", async () => {
    const before = await adminPage.textContent("#flashTimerStatus");
    await adminPage.click("#flashTimerToggle");
    await adminPage.waitForFunction(text => document.querySelector("#flashTimerStatus").textContent !== text, before);
    await adminPage.click("#flashTimerToggle");
  });

  await check("no JavaScript errors in the browser", async () => {
    const real = errors.filter(text => !/401|Failed to load resource/.test(text));
    assert(!real.length, real.join(" | "));
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
