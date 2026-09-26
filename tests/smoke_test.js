const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const manifest = JSON.parse(read("manifest.json"));
if (manifest.version !== "2.3.4") throw new Error("manifest version must be 2.3.4");
for (const permission of ["activeTab", "scripting", "downloads", "storage", "pageCapture", "clipboardWrite", "identity"]) {
  if (!manifest.permissions.includes(permission)) throw new Error(`missing permission: ${permission}`);
}
for (const origin of ["https://login.microsoftonline.com/*", "https://graph.microsoft.com/*"]) {
  if (!manifest.host_permissions.includes(origin)) throw new Error(`missing host permission: ${origin}`);
}
if (manifest.background?.service_worker !== "background.js") throw new Error("background service worker missing");

const html = read("popup.html");
const popupSource = read("popup.js");
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
    tabs: { query: async () => [{ id: 1, title: "Test Page", url: "https://example.com/", favIconUrl: "" }] },
    scripting: { executeScript: async () => [] },
    downloads: { download: async () => 1 },
    pageCapture: { saveAsMHTML() {} },
    runtime: { lastError: null },
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
  chrome: {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    identity: { getRedirectURL: () => "https://test.chromiumapp.org/microsoft" },
    downloads: { download: async () => 1 },
    tabs: { captureVisibleTab: async () => "data:image/png;base64," }
  }
};
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

console.log("Smoke tests passed: v2.3 manifest, selected reader clipping, whole-article action, Graph permissions, UI IDs, background listener, wording");
