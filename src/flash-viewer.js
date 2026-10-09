const PDFJS_VERSION = "6.4.299";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;
const PDFJS_WASM = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/wasm/`;

let pdfjsPromise;
let currentLoadingTask;
let currentDocument;
let pageObserver;

async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS_BASE}pdf.mjs`).then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.mjs`;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function clearFlashViewer(container) {
  pageObserver?.disconnect();
  pageObserver = null;
  currentLoadingTask?.destroy();
  currentLoadingTask = null;
  currentDocument?.destroy();
  currentDocument = null;
  container.replaceChildren();
}

export function clearFlashDocument(container) {
  clearFlashViewer(container);
}

async function renderPage(pageNumber, pdf, pageElement, container) {
  if (pageElement.dataset.rendered === "true") return;
  pageElement.dataset.rendered = "true";

  try {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(260, container.clientWidth - 28);
    const scale = Math.min(1.5, availableWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.5);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.setAttribute("aria-label", `Flash page ${pageNumber}`);
    pageElement.replaceChildren(canvas);

    await page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
    }).promise;
  } catch (error) {
    pageElement.dataset.rendered = "false";
    pageElement.textContent = "This page could not be displayed. Reload the flash and try again.";
    console.error(`Unable to render flash page ${pageNumber}`, error);
  }
}

export async function showFlashDocument(container, url) {
  clearFlashViewer(container);
  container.textContent = "Loading flash…";

  try {
    const pdfjs = await getPdfJs();
    currentLoadingTask = pdfjs.getDocument({ url, wasmUrl: PDFJS_WASM });
    const pdf = await currentLoadingTask.promise;
    currentDocument = pdf;
    container.replaceChildren();

    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const pageElement = document.createElement("div");
      pageElement.className = "flash-rendered-page";
      pageElement.dataset.rendered = "false";
      pageElement.setAttribute("aria-label", `Flash page ${pageNumber}`);
      container.append(pageElement);
      pages.push({ pageNumber, pageElement });
    }

    if ("IntersectionObserver" in window) {
      pageObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const pageNumber = Number(entry.target.dataset.pageNumber);
          pageObserver.unobserve(entry.target);
          renderPage(pageNumber, pdf, entry.target, container);
        });
      }, { root: container, rootMargin: "900px 0px" });

      pages.forEach(({ pageNumber, pageElement }) => {
        pageElement.dataset.pageNumber = String(pageNumber);
        pageObserver.observe(pageElement);
      });
      if (pages[0]) renderPage(1, pdf, pages[0].pageElement, container);
    } else {
      for (const { pageNumber, pageElement } of pages) {
        await renderPage(pageNumber, pdf, pageElement, container);
      }
    }
  } catch (error) {
    if (error?.name === "RenderingCancelledException") return;
    container.textContent = "The flash could not be loaded. Check your connection and reopen it.";
    console.error("Unable to load flash document", error);
  }
}
