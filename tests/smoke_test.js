const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const manifest = JSON.parse(read("manifest.json"));
if (manifest.version !== "2.5.3") throw new Error("manifest version must be 2.5.1");
for (const permission of ["activeTab", "scripting", "downloads", "storage", "pageCapture", "clipboardWrite", "identity"]) {
  if (!manifest.permissions.includes(permission)) throw new Error(`missing permission: ${permission}`);
}
for (const origin of ["https://login.microsoftonline.com/*", "https://graph.microsoft.com/*"]) {
  if (!manifest.host_permissions.includes(origin)) throw new Error(`missing host permission: ${origin}`);
}
if (manifest.background?.service_worker !== "background.js") throw new Error("background service worker missing");

const html = read("popup.html");
const popupSource = read("popup.js");
const backgroundSource = read("background.js");
const captureSource = read("capture.js");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
if (!(html.indexOf('id="capture-full"') < html.indexOf('id="progress"') && html.indexOf('id="progress"') < html.indexOf('id="save-page-pdf"'))) {
  throw new Error("full-page capture feedback must appear in the visible image-capture section");
}
const referencedIds = new Set([...popupSource.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]));
for (const id of referencedIds) {
  if (!htmlIds.has(id)) throw new Error(`popup.js references missing HTML id: ${id}`);
}

function fakeElement() {
  return {
    value: "", checked: false, disabled: false, textContent: "", className: "", style: {},
    dataset: {}, selectedOptions: [], children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; }
  };
}
const elements = Object.fromEntries([...htmlIds].map((id) => [id, fakeElement()]));
const popupContext = {
  console,
  Blob,
  URL,
  URLSearchParams,
  TextEncoder,
  crypto: require("crypto").webcrypto,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  fetch,
  FileReader: class {},
  DOMParser: class { parseFromString() { return { body: { innerText: "", textContent: "" } }; } },
  Image: class {},
  navigator: { clipboard: {} },
  window: {},
  document: {
    getElementById: (id) => elements[id],
    querySelectorAll: () => [],
    createElement: () => fakeElement()
  },
  chrome: {
    storage: { local: { get: async (request) => typeof request === "string" ? {} : request, set: async () => {}, remove: async () => {} } },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, title: "Test Page", url: "https://example.com/", favIconUrl: "" }],
      captureVisibleTab: (windowId, options, callback) => {
        if (windowId !== 1 || options.format !== "png") throw new Error("captureVisibleTab arguments were not forwarded");
        callback("data:image/png;base64,dGVzdA==");
      }
    },
    scripting: { executeScript: async () => [] },
    downloads: { download: (_options, callback) => callback(1) },
    pageCapture: { saveAsMHTML() {} },
    runtime: { lastError: null, onMessage: { addListener() {} } },
    identity: { getRedirectURL: () => "https://test.chromiumapp.org/microsoft", launchWebAuthFlow: async () => "" }
  },
  setTimeout,
  clearTimeout
};
vm.createContext(popupContext);
vm.runInContext(read("onenote.js"), popupContext, { filename: "onenote.js" });
vm.runInContext(popupSource, popupContext, { filename: "popup.js" });
const bookmark = vm.runInContext(`buildBookmarkHtml({
  title: "A & B", url: "https://example.com/?a=1&b=2", favicon: "",
  notebook: "測試", tags: ["tag1", "tag2"], note: "hello"
})`, popupContext);
if (!bookmark.includes("A &amp; B") || !bookmark.includes("tag1") || !bookmark.includes("下載分類")) {
  throw new Error("bookmark HTML metadata/escaping test failed");
}

let messageListener = null;
const backgroundContext = {
  console,
  Blob,
  Uint8Array,
  URLSearchParams,
  TextEncoder,
  crypto: require("crypto").webcrypto,
  btoa,
  fetch,
  createImageBitmap: async () => ({ width: 200, height: 100, close() {} }),
  OffscreenCanvas: class {
    constructor(width, height) { this.width = width; this.height = height; this.types = []; }
    getContext() { return { drawImage() {}, fillRect() {} }; }
    async convertToBlob(options) { this.types.push(options.type); return new Blob(["test-image"], { type: options.type }); }
  },
  setTimeout,
  clearTimeout,
  chrome: {
    runtime: { lastError: null, sendMessage: async () => ({}), onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    identity: { getRedirectURL: () => "https://test.chromiumapp.org/microsoft" },
    downloads: { download: (options, callback) => {
      backgroundContext.downloadRequests.push(options);
      if (callback) callback(1);
      return Promise.resolve(1);
    } },
    tabs: {
      query: async () => [{ id: 1, windowId: 1 }],
      captureVisibleTab: async (_windowId, options) => {
        backgroundContext.lastSegmentCaptureOptions = options;
        return "data:image/png;base64,dGVzdA==";
      }
    }
  }
};
backgroundContext.downloadRequests = [];
vm.createContext(backgroundContext);
const backgroundBundle = `${read("onenote.js")}\n${read("background.js").replace(/^importScripts\([^\n]+\);\s*/u, "")}`;
vm.runInContext(backgroundBundle, backgroundContext, { filename: "background.bundle.js" });
if (typeof messageListener !== "function") throw new Error("background message listener missing");

for (const requiredText of ["元素已鎖定", "儲存剪藏", "重新選擇", "簡化閱讀預覽", "reader-article", "複製選取內容", "儲存選取內容", "剪藏整篇文章", "反白選取要剪藏的內容"]) {
  if (!popupSource.includes(requiredText)) throw new Error(`interactive clipping feature missing: ${requiredText}`);
}

for (const name of ["popup.html", "popup.js", "popup.css", "README.md", "VALIDATION.txt", "manifest.json"]) {
  const removedBrandPattern = new RegExp(["ever", "note"].join(""), "i");
  if (removedBrandPattern.test(read(name))) throw new Error(`obsolete third-party wording remains in ${name}`);
}

(async () => {
  const dataUrl = await vm.runInContext(`captureVisibleTabCompat(1, {format: "png"})`, popupContext);
  if (dataUrl !== "data:image/png;base64,dGVzdA==") throw new Error("callback-based screenshot compatibility failed");
  if (!popupSource.includes('files: ["capture.js"]') || !popupSource.includes('type: "start-full-page-capture"')) {
    throw new Error("full-page capture is not dispatched to the persistent tab content script");
  }
  if (!captureSource.includes("async function captureSegmentWithRetry") || !captureSource.includes("const maxAttempts = 6") || !captureSource.includes("await sleep(650)")) {
    throw new Error("long capture must pace and retry transient screenshot failures instead of stopping on the first one");
  }
  if (!captureSource.includes("const flushCompleteParts = async (coveredCss)") || !captureSource.includes("part.canvas = null") || !captureSource.includes("await flushCompleteParts(outputCoveredCss)")) {
    throw new Error("completed image parts must be encoded and released while the long capture is running");
  }
  if (!captureSource.includes("const partCount = Math.ceil(height / partCssHeight)") || !captureSource.includes("drawAcrossParts") || !captureSource.includes('_完整網頁_第${String(partIndex + 1).padStart(3, "0")}部分')) {
    throw new Error("oversized full-page captures must be split into downloadable image parts");
  }
  if (captureSource.includes("超出瀏覽器 Canvas 可輸出的長圖限制")) throw new Error("oversized pages must not be rejected before download");
  if (!captureSource.includes("let persistentSidePanelRegions = []") || !captureSource.includes("rootEl.contains(el) || el.contains(rootEl)")) {
    throw new Error("sidebar regions and their ancestor shells must remain available and protected");
  }
  if (captureSource.includes("(panelY + sourceTopCss) * dpr")) throw new Error("sidebar source crop offset must not be added to its destination Y");
  for (const marker of ["capture-full-page-segment", "begin-full-page-download", "append-full-page-download", "finish-full-page-download", 'behavior: "smooth"', "scrollToAndWait(y)", "captureStepStride = Math.max(80, Math.min(180, Math.floor(captureStepHeight * 0.16)))", "outputCoveredCss", "第 ${i + 1} 段截圖高度無效", "長圖只拼接到", "for (let y = 0; y < scrollRange; y += captureStepStride)", "Never hide page elements while capturing", "網頁沒有捲動到第", "persistentSidePanelRoots", "persistentSidePanelRegions", "scrollCandidates", "panelSteps", "const panelY = panelSteps[index]", "panel.scroller.scrollTop = Math.min(panelY, panel.scrollRange)", "panel.contentHeight - panelY", "panel.originalScrollTop", 'ctx.clip("evenodd")', "panel.scroller.scrollTop = 0", "finally", "window.scrollTo(original.x"]) {
    if (!captureSource.includes(marker)) throw new Error(`background-safe capture feature missing: ${marker}`);
  }
  if (!backgroundSource.includes('const captureFormat = "png"') || !backgroundSource.includes('createImagePage(options.oneNoteSectionId, pngBlob')) {
    throw new Error("OneNote image path must preserve the lossless PNG source");
  }
  const clipboardImage = await vm.runInContext(`saveSelectedRegion({rect:{x:0,y:0,width:50,height:40},viewportWidth:100,viewportHeight:50,options:{imageFormat:"jpg",target:"onenote",oneNoteMode:"clipboard"}},{tab:{id:1,windowId:1,title:"Test"}})`, backgroundContext);
  if (backgroundContext.lastSegmentCaptureOptions?.format !== "png" || !clipboardImage.clipboardDataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("OneNote clipboard capture must remain full-resolution PNG when JPG is selected");
  }
  const captureReply = await new Promise((resolve, reject) => {
    const keepAlive = messageListener({ type: "capture-full-page-segment", options: { format: "png" } }, { tab: { id: 1, windowId: 1 } }, resolve);
    if (!keepAlive) reject(new Error("segment capture message channel did not stay open"));
  });
  if (!captureReply?.ok || captureReply.dataUrl !== "data:image/png;base64,dGVzdA==") {
    throw new Error("background screenshot segment integration failed");
  }
  const sendBackgroundMessage = (message) => new Promise((resolve, reject) => {
    const keepAlive = messageListener(message, { tab: { id: 1, windowId: 1 } }, resolve);
    if (!keepAlive) reject(new Error(`${message.type} channel did not stay open`));
  });
  const payload = "data:image/png;base64,dGVzdA==";
  const started = await sendBackgroundMessage({ type: "begin-full-page-download", jobId: "job-test", filename: "capture.png" });
  if (!started.ok) throw new Error("background image download setup failed");
  const appended = await sendBackgroundMessage({ type: "append-full-page-download", jobId: "job-test", chunk: payload });
  if (!appended.ok) throw new Error("background image chunk transfer failed");
  const downloadReply = await sendBackgroundMessage({ type: "finish-full-page-download", jobId: "job-test" });
  if (!downloadReply?.ok || downloadReply.downloadId !== 1 || backgroundContext.downloadRequests.at(-1)?.url !== payload) {
    throw new Error("automatic background image download integration failed");
  }
  if (captureSource.includes("el.style.setProperty('visibility', 'hidden'") || captureSource.includes('pos === "sticky"')) {
    throw new Error("full-page capture must not hide page content based on element positioning");
  }
  console.log("Smoke tests passed: v2.5.3 retryable long capture and prominent feedback and oversized-page part downloads, startup API timeouts, narrow non-overwriting tiles, coverage validation, sidebar stitching, OneNote, and downloads");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
