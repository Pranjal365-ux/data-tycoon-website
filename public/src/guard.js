// Flash integrity guard. Active only while a flash is open.
//
// Browsers cannot see operating-system screenshots directly, so this combines
// every signal a web page does get, on Windows, macOS, Linux and ChromeOS:
//  * The flash is blanked the moment Windows/Command, Shift or Alt goes down,
//    and stays blank for as long as any of them is held (no time limit). It is
//    shown again only once the keys are released, which is re-checked on every
//    key and mouse event, so a missed key release cannot leave it uncovered.
//    Every screenshot shortcut (Win+Shift+S, Win+PrtScn, Alt+PrtScn,
//    Cmd+Shift+3/4/5, Cmd+Ctrl+Shift+3/4) starts with one of those keys.
//  * Print Screen arrives as keyup only on Windows. The clipboard copy it
//    makes is overwritten straight away, and again when the team comes back
//    to the page, so a pasted capture comes out empty.
//  * Launching Snipping Tool, Alt-Tab, switching tabs or apps all take focus
//    away: the flash is blanked and the organizers are alerted (tab lock).
//  * The pointer leaving the window (e.g. towards a taskbar screenshot tool)
//    blanks the flash until it comes back.
// Limits no web page can get around: a key pressed within the same screen
// refresh (about 1/60 s) as the capture key, Print Screen on its own (Windows
// only tells the page after the capture), and phone cameras. The team-name
// watermark on every page is the deterrent there.

const REPORT_DEDUPE_MS = 2500;
const KEY_COVER_MS = 1500;
const HOLD_MESSAGE = "Flash hidden while Windows / Command, Shift or Alt is held. Let go of the keys to keep reading.";

let active = false;
let options = null;
let away = null;
let modifierTimer = null;
let pointerOutside = false;
let keysHeld = false;
let coverUntil = 0;
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

// The shield is always laid out; only its visibility flips, so blanking costs
// no layout work and lands on the very next frame.
function cover(message) {
  const el = shield();
  if (!el) return;
  el.classList.add("on");
  if (shieldText().textContent !== message) shieldText().textContent = message;
}

function uncover() {
  if (away || pointerOutside || keysHeld || Date.now() < coverUntil || lockCard()?.hidden === false) return;
  shield()?.classList.remove("on");
}

function scheduleUncover(delay) {
  clearTimeout(modifierTimer);
  modifierTimer = setTimeout(uncover, delay);
}

function coverFor(message, ms) {
  cover(message);
  coverUntil = Math.max(coverUntil, Date.now() + ms);
  scheduleUncover(ms + 50);
}

// Windows/Command, Shift or Alt: the first key of every screenshot shortcut.
function riskyKeysHeld(event) {
  return Boolean(event.metaKey || event.shiftKey || event.altKey || event.getModifierState?.("OS") || event.getModifierState?.("Meta"));
}

function syncHeld(event) {
  const held = riskyKeysHeld(event);
  if (held === keysHeld) return;
  keysHeld = held;
  if (held) cover(HOLD_MESSAGE);
  else scheduleUncover(250);
}

function wipeClipboard() {
  try {
    navigator.clipboard?.writeText?.("Screenshots of the news flash are not allowed.").catch(() => {});
  } catch { /* Clipboard access refused: nothing else to do. */ }
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
  wipeClipboard();
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

function isModifierKey(event) {
  return ["Meta", "OS", "Super", "Shift", "Alt", "AltGraph", "Control"].includes(event.key);
}

function onKeyDown(event) {
  if (!active) return;
  const key = (event.key || "").toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  syncHeld(event);

  if (isPrintScreen(event)) {
    event.preventDefault();
    coverFor("Screenshots are not allowed during a flash.", KEY_COVER_MS);
    wipeClipboard();
    report("screenshot-shortcut", "Print Screen key pressed.");
    return;
  }
  if (isModifierKey(event)) {
    if ((event.metaKey && event.shiftKey) || (event.ctrlKey && event.shiftKey && event.metaKey)) {
      report("screenshot-suspected", `${event.ctrlKey ? "Ctrl+" : ""}Windows/Command + Shift held (screenshot shortcut).`);
    }
    return;
  }
  if (event.metaKey && event.shiftKey && ["3", "4", "5", "6", "s", "#", "$", "%", "^"].includes(key)) {
    event.preventDefault();
    coverFor("Screenshots are not allowed during a flash.", KEY_COVER_MS);
    report("screenshot-shortcut", `Screenshot shortcut (${event.ctrlKey ? "Ctrl+" : ""}Cmd/Win+Shift+${event.key}).`);
    return;
  }
  if (event.ctrlKey && event.shiftKey && ["s", "printscreen"].includes(key)) {
    event.preventDefault();
    coverFor("Screenshots are not allowed during a flash.", KEY_COVER_MS);
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
    // Windows hands Print Screen to the page only on key release: replace
    // whatever it just copied, and keep the flash hidden for a moment.
    coverFor("Screenshots are not allowed during a flash.", KEY_COVER_MS);
    wipeClipboard();
    report("screenshot-shortcut", "Print Screen key pressed.");
    return;
  }
  syncHeld(event);
}

// Mouse events carry the live modifier state too: they catch a key release
// the page never heard about (macOS often swallows them during a capture).
function onPointerActivity(event) {
  if (!active) return;
  syncHeld(event);
  if (pointerOutside) {
    pointerOutside = false;
    uncover();
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
  [document, "mousemove", onPointerActivity],
  [document, "mousedown", onPointerActivity],
  [document, "wheel", onPointerActivity],
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
  keysHeld = false;
  coverUntil = 0;
  listeners.forEach(([target, type, handler]) => target.addEventListener(type, handler, true));
  lockCard()?.querySelector("button")?.addEventListener("click", resumeReading);
  if (document.hidden || !document.hasFocus()) leave("window-blur", "The flash opened while the page was not in focus.");
}

export function stopGuard() {
  if (!active) return;
  active = false;
  away = null;
  pointerOutside = false;
  keysHeld = false;
  coverUntil = 0;
  clearTimeout(modifierTimer);
  listeners.forEach(([target, type, handler]) => target.removeEventListener(type, handler, true));
  lockCard()?.querySelector("button")?.removeEventListener("click", resumeReading);
  if (lockCard()) lockCard().hidden = true;
  shield()?.classList.remove("on");
}

function resumeReading() {
  pointerOutside = false;
  wipeClipboard();
  lockCard().hidden = true;
  uncover();
}
