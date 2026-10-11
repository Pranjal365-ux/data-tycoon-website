// Flash integrity guard. Active only while a flash is open.
//
// Browsers cannot see operating-system screenshots directly, so this combines
// every signal a web page does get, on Windows, macOS, Linux and ChromeOS:
//  * Print Screen arrives as keyup only on Windows; we listen to both.
//  * Win+Shift+S (Snipping Tool) and Cmd+Shift+3/4/5 (macOS) are swallowed by
//    the OS, but the Win/Cmd and Shift presses reach the page first. The
//    flash is blanked as soon as that pair is held, before the capture key.
//  * Launching Snipping Tool, Alt-Tab, switching tabs or apps all take focus
//    away: the flash is blanked and the organizers are alerted (tab lock).
//  * The pointer leaving the window (e.g. towards a taskbar screenshot tool)
//    blanks the flash until it comes back.
// Phone cameras and phone screenshot buttons cannot be detected by any
// website; the team-name watermark on every page is the deterrent there.

const REPORT_DEDUPE_MS = 2500;
const MODIFIER_COVER_MS = 1500;

let active = false;
let options = null;
let away = null;
let modifierTimer = null;
let pointerOutside = false;
const lastReport = new Map();

const shield = () => document.querySelector("#flashShield");
const shieldText = () => document.querySelector("#flashShieldText");
const lockCard = () => document.querySelector("#flashLeaveCard");

function report(kind, detail) {
  const now = Date.now();
  if (now - (lastReport.get(kind) || 0) < REPORT_DEDUPE_MS) return;
  lastReport.set(kind, now);
  options?.report(kind, detail);
}

function cover(message) {
  const el = shield();
  if (!el) return;
  shieldText().textContent = message;
  el.hidden = false;
}

function uncover() {
  if (away || pointerOutside || lockCard()?.hidden === false) return;
  const el = shield();
  if (el) el.hidden = true;
}

function coverBriefly(message) {
  cover(message);
  clearTimeout(modifierTimer);
  modifierTimer = setTimeout(uncover, MODIFIER_COVER_MS);
}

function leave(kind, detail) {
  if (!active) return;
  cover("Flash hidden. Come back to this tab to keep reading.");
  if (away) return;
  away = { since: Date.now(), kind };
  report(kind, detail);
}

function comeBack() {
  if (!active || !away || document.hidden || !document.hasFocus()) return;
  const seconds = Math.max(1, Math.round((Date.now() - away.since) / 1000));
  away = null;
  report("focus-return", `Returned to the flash after ${seconds} s away.`);
  const card = lockCard();
  if (card) {
    card.querySelector("[data-away-seconds]").textContent = `${seconds} second${seconds === 1 ? "" : "s"}`;
    card.hidden = false;
    card.querySelector("button")?.focus();
  }
}

function isPrintScreen(event) {
  return event.key === "PrintScreen" || event.code === "PrintScreen" || event.keyCode === 44;
}

function onKeyDown(event) {
  if (!active) return;
  const key = (event.key || "").toLowerCase();
  const mod = event.ctrlKey || event.metaKey;

  if (isPrintScreen(event)) {
    event.preventDefault();
    cover("Screenshots are not allowed during a flash.");
    report("screenshot-shortcut", "Print Screen key pressed.");
    return;
  }
  if (event.key === "Meta" || event.key === "OS" || event.key === "Super") {
    coverBriefly("Flash hidden while the Windows / Command key is held.");
    if (event.shiftKey) report("screenshot-suspected", "Windows/Command + Shift held (screenshot shortcut).");
    return;
  }
  if (event.key === "Shift" && event.metaKey) {
    coverBriefly("Screenshots are not allowed during a flash.");
    report("screenshot-suspected", "Windows/Command + Shift held (screenshot shortcut).");
    return;
  }
  if (event.metaKey && event.shiftKey && ["3", "4", "5", "6", "s", "#", "$", "%", "^"].includes(key)) {
    event.preventDefault();
    cover("Screenshots are not allowed during a flash.");
    report("screenshot-shortcut", `Screenshot shortcut (${event.ctrlKey ? "Ctrl+" : ""}Cmd/Win+Shift+${event.key}).`);
    return;
  }
  if (event.ctrlKey && event.shiftKey && ["s", "printscreen"].includes(key)) {
    event.preventDefault();
    cover("Screenshots are not allowed during a flash.");
    report("screenshot-shortcut", `Screenshot shortcut (Ctrl+Shift+${event.key}).`);
    return;
  }
  if (mod && key === "p") {
    event.preventDefault();
    report("print-attempt", "Tried to print the flash.");
    return;
  }
  const devtools = key === "f12" || (mod && event.shiftKey && ["i", "j", "c"].includes(key)) || (event.metaKey && event.altKey && ["i", "j", "c"].includes(key));
  if (devtools) {
    event.preventDefault();
    report("devtools-shortcut", "Tried to open developer tools during a flash.");
    return;
  }
  if (mod && ["c", "x", "a", "s", "u"].includes(key)) event.preventDefault();
}

function onKeyUp(event) {
  if (!active) return;
  if (isPrintScreen(event)) {
    // Windows hands Print Screen to the page only on key release.
    cover("Screenshots are not allowed during a flash.");
    report("screenshot-shortcut", "Print Screen key pressed.");
    clearTimeout(modifierTimer);
    modifierTimer = setTimeout(uncover, MODIFIER_COVER_MS);
    return;
  }
  if (["Meta", "OS", "Super", "Shift"].includes(event.key)) {
    clearTimeout(modifierTimer);
    modifierTimer = setTimeout(uncover, 400);
  }
}

const block = event => { if (active) event.preventDefault(); };
// Listeners run in the capture phase, so ignore blur/focus of elements inside the page.
const onBlur = event => event.target === window && leave("window-blur", "Left the flash window (switched app, opened a screenshot tool, or clicked outside the page).");
const onVisibility = () => {
  if (document.hidden) leave("tab-hidden", "Switched tab or minimized the browser during a flash.");
  else comeBack();
};
const onFocus = event => { if (event.target === window) comeBack(); };
const onPageHide = () => leave("tab-hidden", "Closed or reloaded the page during a flash.");
const onBeforePrint = () => { if (active) report("print-attempt", "Tried to print the flash."); };
const onPointerLeave = event => {
  // Only a real exit through the window edge counts (no destination element).
  if (!active || event.relatedTarget) return;
  const edge = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth - 1 || event.clientY >= window.innerHeight - 1;
  if (!edge) return;
  pointerOutside = true;
  cover("Move your pointer back onto the page to keep reading.");
};
const onPointerEnter = () => {
  if (!pointerOutside) return;
  pointerOutside = false;
  uncover();
};

const listeners = [
  [document, "keydown", onKeyDown],
  [document, "keyup", onKeyUp],
  [document, "contextmenu", block],
  [document, "copy", block],
  [document, "cut", block],
  [document, "dragstart", block],
  [document, "selectstart", block],
  [document, "visibilitychange", onVisibility],
  [document, "mouseout", onPointerLeave],
  [document, "mousemove", onPointerEnter],
  [window, "blur", onBlur],
  [window, "focus", onFocus],
  [window, "pagehide", onPageHide],
  [window, "beforeprint", onBeforePrint]
];

export function startGuard(nextOptions) {
  options = nextOptions;
  if (active) return;
  active = true;
  away = null;
  pointerOutside = false;
  listeners.forEach(([target, type, handler]) => target.addEventListener(type, handler, true));
  lockCard()?.querySelector("button")?.addEventListener("click", resumeReading);
  if (document.hidden || !document.hasFocus()) leave("window-blur", "The flash opened while the page was not in focus.");
}

export function stopGuard() {
  if (!active) return;
  active = false;
  away = null;
  pointerOutside = false;
  clearTimeout(modifierTimer);
  listeners.forEach(([target, type, handler]) => target.removeEventListener(type, handler, true));
  lockCard()?.querySelector("button")?.removeEventListener("click", resumeReading);
  if (lockCard()) lockCard().hidden = true;
  if (shield()) shield().hidden = true;
}

function resumeReading() {
  pointerOutside = false;
  lockCard().hidden = true;
  uncover();
}
