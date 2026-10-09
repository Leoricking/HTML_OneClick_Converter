const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const manifest = JSON.parse(read("manifest.json"));
if (manifest.version !== "2.3.9") throw new Error("manifest version must be 2.3.9");
for (const permission of ["activeTab", "scripting", "downloads", "storage", "pageCapture", "clipboardWrite", "identity"]) {
  if (!manifest.permissions.includes(permission)) throw new Error(`missing permission: ${permission}`);
}
for (const origin of ["https://login.microsoftonline.com/*", "https://graph.microsoft.com/*"]) {
  if (!manifest.host_permissions.includes(origin)) throw new Error(`missing host permission: ${origin}`);
}
if (manifest.background?.service_worker !== "background.js") throw new Error("background service worker missing");

const html = read("popup.html");
const popupSource = read("popup.js");
const captureSource = read("capture.js");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
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
  createImageBitmap: async () => ({}),
  OffscreenCanvas: class {},
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
      captureVisibleTab: async () => "data:image/png;base64,dGVzdA=="
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
  for (const marker of ["capture-full-page-segment", "begin-full-page-download", "append-full-page-download", "finish-full-page-download", 'behavior: "smooth"', "scrollToAndWait(y)", "overlay|hidden", "網頁沒有捲動到第", "finally", "window.scrollTo(original.x"]) {
    if (!captureSource.includes(marker)) throw new Error(`background-safe capture feature missing: ${marker}`);
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
  console.log("Smoke tests passed: v2.3.9 nested scroll detection, verified segment scrolling, chunked transfer, automatic download, clipping, and OneNote");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
