// Flash viewer: fetches the round's page images through the authenticated API
// and draws them onto canvases under a team watermark.

const bitmapCache = new Map();
let renderToken = 0;
let resizeObserver = null;

function pageContainer() {
  return document.querySelector("#flashPages");
}

function watermarkImage(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 420;
  canvas.height = 260;
  const ctx = canvas.getContext("2d");
  ctx.translate(210, 130);
  ctx.rotate(-Math.PI / 7);
  ctx.font = "600 20px system-ui, sans-serif";
  ctx.fillStyle = "rgba(142, 33, 27, 0.16)";
  ctx.textAlign = "center";
  ctx.fillText(text, 0, 0);
  ctx.font = "500 13px system-ui, sans-serif";
  ctx.fillText("DATA TYCOON · CONFIDENTIAL", 0, 24);
  return canvas.toDataURL("image/png");
}

function drawPage(canvas, bitmap) {
  const width = Math.min(canvas.parentElement.clientWidth - 20, 1000);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const height = Math.round(width * bitmap.height / bitmap.width);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

async function loadBitmap(fetchPage, round, page) {
  const key = `${round}:${page}`;
  if (!bitmapCache.has(key)) {
    bitmapCache.set(key, fetchPage(round, page).then(blob => createImageBitmap(blob)).catch(error => {
      bitmapCache.delete(key);
      throw error;
    }));
  }
  return bitmapCache.get(key);
}

export async function showFlash({ round, pages, teamId, fetchPage }) {
  const token = ++renderToken;
  const container = pageContainer();
  const stamp = new Date().toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
  // Each page carries the watermark, so it stays on every page while scrolling.
  container.style.setProperty("--flash-watermark", `url("${watermarkImage(`${teamId} · ${stamp}`)}")`);
  container.replaceChildren();
  const slots = Array.from({ length: pages }, (_, index) => {
    const slot = document.createElement("div");
    slot.className = "flash-page";
    slot.innerHTML = `<p class="flash-page-status">Loading page ${index + 1} of ${pages}…</p>`;
    container.append(slot);
    return slot;
  });
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    container.querySelectorAll("canvas").forEach(canvas => { if (canvas.bitmap) drawPage(canvas, canvas.bitmap); });
  });
  resizeObserver.observe(container);

  for (let index = 0; index < slots.length; index += 1) {
    if (token !== renderToken) return;
    const slot = slots[index];
    try {
      const bitmap = await loadBitmap(fetchPage, round, index + 1);
      if (token !== renderToken) return;
      const canvas = document.createElement("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Flash ${round}, page ${index + 1}`);
      canvas.bitmap = bitmap;
      slot.replaceChildren(canvas);
      drawPage(canvas, bitmap);
    } catch (error) {
      if (token !== renderToken) return;
      const message = document.createElement("p");
      message.className = "flash-page-status error";
      message.textContent = `Page ${index + 1} did not load. `;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "link-button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => showFlash({ round, pages, teamId, fetchPage }));
      message.append(retry);
      slot.replaceChildren(message);
      console.warn("Flash page failed to load", error);
    }
  }
}

export function hideFlash() {
  renderToken += 1;
  resizeObserver?.disconnect();
  resizeObserver = null;
  pageContainer()?.replaceChildren();
  // A flash is seen once: drop every decoded page so nothing stays in memory.
  bitmapCache.forEach(entry => entry.then(bitmap => bitmap.close?.()).catch(() => {}));
  bitmapCache.clear();
}
