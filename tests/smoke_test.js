const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const manifest = JSON.parse(read("manifest.json"));
if (manifest.version !== "2.5.44") throw new Error("manifest version must be 2.5.44");
for (const permission of ["activeTab", "scripting", "downloads", "storage", "pageCapture", "clipboardWrite", "identity", "debugger"]) {
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
if (!html.includes('id="copy-capture-log"') || !html.includes('id="capture-log-output"') ||
    !popupSource.includes('get-full-page-capture-log') || !popupSource.includes('navigator.clipboard.writeText')) {
  throw new Error("complete capture diagnostics must be visible and one-click copyable from the popup");
}
for (const marker of ["page-inventory", "wheel-preflight", "selected-scroller-verified", "wheel-fallback-attempt", "scroll-settled", "segment-captured", "segment-stitched", "download-started", "capture-error"]) {
  if (!captureSource.includes(marker)) throw new Error(`complete capture diagnostic event missing: ${marker}`);
}
for (const marker of ["function isReverseCaptureScroller", "function getCaptureLogicalScrollY", "function getCapturePhysicalScrollY", "scroll-model-detected", "reverse-negative-scrollTop"]) {
  if (!captureSource.includes(marker)) throw new Error(`reverse-scroll handling missing: ${marker}`);
}
for (const marker of ["chatGPTContentCapture", "event: \"chatgpt-ui-filter\"", "textarea,[contenteditable]:not([contenteditable='false'])", "document.querySelectorAll(\"form,[data-testid*='composer'],[data-testid*='prompt']\")", "mapCaptureRectToPixels(captureRect", "sourceRect.y + Math.round(Math.max(0, sourceTopCss)", "chatGPTContentCapture ? width : viewportWidth", "getChatGPTCaptureLayout(captureRect)", "chatgpt-sidebar-preserved-once", "const mainDestinationX = chatGPTContentCapture ? chatGPTSidebarWidth : 0", "jump.*latest"]) {
  if (!captureSource.includes(marker)) throw new Error(`ChatGPT repeat-UI filtering missing: ${marker}`);
}
const chatGPTCrop = vm.runInNewContext(`${captureSource}\nmapCaptureRectToPixels({left:260,top:50,width:1400,height:780},3360,1680,1680,840)`, { chrome: { runtime: { onMessage: { addListener() {} } } } });
if (chatGPTCrop.x !== 520 || chatGPTCrop.y !== 100 || chatGPTCrop.width !== 2800 || chatGPTCrop.height !== 1560) {
  throw new Error("ChatGPT conversation crop must map CSS viewport coordinates to screenshot pixels without stretching");
}
const chatGPTLayout = vm.runInNewContext(`${captureSource}\ngetChatGPTCaptureLayout({left:260,width:1400})`, { chrome: { runtime: { onMessage: { addListener() {} } } } });
if (chatGPTLayout.sidebarWidth !== 260 || chatGPTLayout.contentWidth !== 1400 || chatGPTLayout.outputWidth !== 1660) {
  throw new Error("ChatGPT output layout must preserve the left rail once and keep the conversation at its original width");
}
const reverseScrollMath = vm.runInNewContext(`${captureSource}\n({top:getCapturePhysicalScrollY(0,4249,true), second:getCapturePhysicalScrollY(125,4249,true), logical:getCaptureLogicalScrollY({scrollTop:-4124},true,4249), normal:getCapturePhysicalScrollY(125,4249,false)})`, { chrome: { runtime: { onMessage: { addListener() {} } } } });
if (reverseScrollMath.top !== -4249 || reverseScrollMath.second !== -4124 || reverseScrollMath.logical !== 125 || reverseScrollMath.normal !== 125) {
  throw new Error("reverse ChatGPT scroll coordinates must map capture top-to-bottom correctly");
}
if (!backgroundSource.includes('type === "get-full-page-capture-log"') || !backgroundSource.includes("fullPageCaptureLog")) {
  throw new Error("capture diagnostics must persist after popup close and be retrievable");
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
  console: {
    ...console,
    error: (...args) => {
      if (String(args[0]?.message || args[0] || "").includes("[CAPTURE_WAITING_FOR_SOURCE_TAB]")) return;
      console.error(...args);
    }
  },
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
    debugger: {
      onDetach: { addListener() {} },
      attach: async (target, version) => { backgroundContext.debuggerAttach = { target, version }; },
      sendCommand: async (target, method, params) => {
        backgroundContext.debuggerCommands.push({ target, method, params });
        if (method === "Page.captureScreenshot") return { data: "dGVzdA==" };
        return {};
      },
      detach: async (target) => { backgroundContext.debuggerDetached = target; }
    },
    storage: { local: {
      get: async (defaults = {}) => ({ ...defaults, ...(backgroundContext.captureLogStore || {}) }),
      set: async (values) => { backgroundContext.captureLogStore = { ...(backgroundContext.captureLogStore || {}), ...values }; },
      remove: async () => {}
    } },
    identity: { getRedirectURL: () => "https://test.chromiumapp.org/microsoft" },
    downloads: { download: (options, callback) => {
      backgroundContext.downloadRequests.push(options);
      if (callback) callback(1);
      return Promise.resolve(1);
    } },
    tabs: {
      zoom: 1,
      getZoom: async () => backgroundContext.chrome.tabs.zoom,
      setZoom: async (_tabId, zoom) => { backgroundContext.chrome.tabs.zoom = zoom; },
      query: async () => [{ id: backgroundContext.activeTabId ?? 1, windowId: 1 }],
      captureVisibleTab: (_windowId, options, callback) => {
        backgroundContext.lastSegmentCaptureOptions = options;
        (backgroundContext.visibleCaptureCalls ||= []).push(Date.now());
        callback("data:image/png;base64,dGVzdA==");
      }
    }
  }
};
backgroundContext.downloadRequests = [];
backgroundContext.debuggerCommands = [];
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
  if (!captureSource.includes("async function captureSegmentWithRetry") || !captureSource.includes("const maxAttempts = 6") || !captureSource.includes("await sleep(fastStaticStride ? 110 : 260)")) {
    throw new Error("long capture must pace and retry transient screenshot failures instead of stopping on the first one");
  }
  if (!backgroundSource.includes("VISIBLE_CAPTURE_MIN_INTERVAL_MS = 600") || !backgroundSource.includes("visibleCaptureQueues") ||
      !captureSource.includes("quotaLimited ? Math.min(8000, 1200 * attempt)")) {
    throw new Error("visible-tab fallback must serialize screenshots below Chromium's per-second capture quota and back off on quota errors");
  }
  if (!captureSource.includes('type: "scroll-capture-by-wheel"') || !backgroundSource.includes('"Input.dispatchMouseEvent"')) {
    throw new Error("stalled direct scrolling must have a trusted CDP mouse-wheel fallback");
  }
  backgroundContext.visibleCaptureCalls = [];
  await Promise.all([
    vm.runInContext(`captureVisibleTabCompat(1,{format:"png"})`, backgroundContext),
    vm.runInContext(`captureVisibleTabCompat(1,{format:"png"})`, backgroundContext)
  ]);
  if (backgroundContext.visibleCaptureCalls.length !== 2 || backgroundContext.visibleCaptureCalls[1] - backgroundContext.visibleCaptureCalls[0] < 550) {
    throw new Error("concurrent visible-tab screenshots must be serialized with the minimum safe interval");
  }
  if (!captureSource.includes("function evaluateCaptureScrollClamp") || !captureSource.includes("const bottomTolerance = 24") ||
      !captureSource.includes("function canTrimCaptureTail") ||
      !captureSource.includes("const actualY = await scrollToAndWait(y)") || !captureSource.includes("outputCoveredCss - actualY")) {
    throw new Error("final-tail clamping must require the live scroll maximum, stitch using actual position, and trim only a matching short tail");
  }
  if (!captureSource.includes("async function probeCaptureScrollContainer") ||
      !captureSource.includes("async function probeCaptureWindowScroll") ||
      !captureSource.includes("async function selectCaptureScrollContainer") ||
      !captureSource.includes("selectCaptureScrollContainer(window, windowRange, scrollCandidates, document.scrollingElement, body)") ||
      !captureSource.includes("candidates.slice(0, 24)")) {
    throw new Error("scroll source detection must select the window or an inner scroller by measured movement, not estimated height ratios");
  }
  const elementRangeMatch = captureSource.match(/const elementRange = ([^;]+);/);
  if (!elementRangeMatch || /\bscroller\b/.test(elementRangeMatch[1])) {
    throw new Error("element scroll range must use the selected activeScroller, not an undefined scroller variable");
  }
  const selectedRange = vm.runInNewContext(elementRangeMatch[1], {
    activeScroller: { scrollHeight: 6200, clientHeight: 800 },
    windowRange: 5000
  });
  const documentRange = vm.runInNewContext(elementRangeMatch[1], {
    activeScroller: null,
    windowRange: 5000
  });
  if (selectedRange !== 5400 || documentRange !== 0) {
    throw new Error("element range calculation must work for both a selected scroller and window scrolling");
  }
  if (!captureSource.includes("async function probeCaptureWheelScrollContainer") ||
      !captureSource.includes("document.elementFromPoint(probeX, probeY)") ||
      !captureSource.includes('type: "scroll-capture-by-wheel", jobId')) {
    throw new Error("a stalled main-content scroller must be discovered with a bounded wheel probe before capture dimensions are finalized");
  }
  if (!captureSource.includes("A successful programmatic scrollTop probe is not proof") ||
      !captureSource.includes("findMovedCaptureScroller(documentObject, before, direction)")) {
    throw new Error("scroll selection must be validated by actual browser wheel movement, not a writable scrollTop alone");
  }
  if (!captureSource.includes("function getCaptureDocumentHeight(root, body)") ||
      (captureSource.match(/pageHeight = getCaptureDocumentHeight\(root, body\)/g) || []).length < 3) {
    throw new Error("when wheel validation selects window scrolling, canvas height must be remeasured along with scroll range");
  }
  if (!captureSource.includes("let captureScrollInputPoint = null") ||
      !captureSource.includes("if (wheelProbe.moved) captureScrollInputPoint = { x: probeX, y: probeY }") ||
      !captureSource.includes("x: captureScrollInputPoint?.x ?? Math.round(viewportWidth * 0.68)") ||
      !captureSource.includes("y: captureScrollInputPoint?.y ?? Math.round(viewportHeight * 0.45)")) {
    throw new Error("capture retries must reuse the verified wheel hit-test point for every segment");
  }
  if (!captureSource.includes("let wheelFallbackAttempts = 0") ||
      !captureSource.includes("wheelFallbackAttempts < 6") ||
      !captureSource.includes("const wheelDeltaY = Math.max(160, targetY - getScrollY())") ||
      !captureSource.includes("currentPolicy.settledNearTarget")) {
    throw new Error("ChatGPT capture must retry the verified wheel target until measurable forward movement reaches the overlap tolerance");
  }
  const verifiedPartialProgress = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(125, 4249, 107, 24, 0)`, { chrome: { runtime: { onMessage: { addListener() {} } } } });
  const noProgress = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(125, 4249, 0, 24, 0)`, { chrome: { runtime: { onMessage: { addListener() {} } } } });
  if (!verifiedPartialProgress.settledNearTarget || noProgress.settledNearTarget) {
    throw new Error("the reported 125 px target / 107 px trusted-wheel movement must be accepted as measured progress, while 0 px must not");
  }
  const heightHelper = captureSource.match(/function getCaptureDocumentHeight\(root, body\) \{[\s\S]*?\n\}/)?.[0];
  if (!heightHelper) throw new Error("document height measurement helper missing");
  const measuredHeight = vm.runInNewContext(`(${heightHelper})(root, body)`, {
    root: { scrollHeight: 6240, clientHeight: 1000 }, body: { scrollHeight: 6100 }
  });
  if (measuredHeight !== 6240) throw new Error("document height must use the refreshed live root/body dimensions");
  for (const diagnostic of ["scrollProbeDiagnostics", "命中=", "位移=${wheelProbe.movement}", "候選數=${scrollCandidates.length}"]) {
    if (!captureSource.includes(diagnostic)) throw new Error(`scroll-owner failure must expose actionable UI diagnostics: ${diagnostic}`);
  }
  const wheelContext = { chrome: { runtime: { onMessage: { addListener() {} } } } };
  const wheelOutcome = await vm.runInNewContext(`${captureSource}\n(async () => {
    let position = 900;
    const innerScroller = { scrollHeight: 2400, clientHeight: 800,
      get scrollTop() { return position; }, set scrollTop(value) { position = value; } };
    const pageWindow = { scrollY: 0, scrollTo() {} };
    const result = await probeCaptureWheelScrollContainer(pageWindow, [innerScroller], null,
      async (deltaY) => { position = Math.max(0, Math.min(1600, position + deltaY)); return true; }, async () => {});
    return { found: result.scroller === innerScroller, moved: result.moved, restored: position === 900 };
  })()`, wheelContext);
  if (!wheelOutcome.found || !wheelOutcome.moved || !wheelOutcome.restored) {
    throw new Error("wheel probe must identify and restore a non-programmatic inner scroller even when the page starts near its bottom");
  }
  const wheelDocumentOutcome = await vm.runInNewContext(`${captureSource}\n(async () => {
    let position = 0;
    const documentScroller = { scrollHeight: 40000, clientHeight: 1000,
      get scrollTop() { return position; }, set scrollTop(value) { position = value; } };
    const pageWindow = { scrollY: 0, scrollTo() {} };
    let dispatched = false;
    const result = await probeCaptureWheelScrollContainer(pageWindow, [], documentScroller,
      async (deltaY) => { dispatched = true; position += deltaY; return true; }, async () => {});
    return { dispatched, found: result.scroller === documentScroller, restored: position === 0 };
  })()`, wheelContext);
  if (!wheelDocumentOutcome.dispatched || !wheelDocumentOutcome.found || !wheelDocumentOutcome.restored) {
    throw new Error("wheel probe must run from measured document height even when overflow-style candidate discovery returns no elements");
  }
  const omittedScrollerOutcome = await vm.runInNewContext(`${captureSource}\n(async () => {
    let position = 0;
    const realChatScroller = { tagName: "DIV", id: "chat-feed", scrollHeight: 5200, clientHeight: 900,
      get scrollTop() { return position; }, set scrollTop(value) { position = value; } };
    const documentScroller = { tagName: "HTML", scrollHeight: 900, clientHeight: 900, scrollTop: 0 };
    const pageDocument = { scrollingElement: documentScroller, documentElement: documentScroller, body: null,
      querySelectorAll: () => [realChatScroller] };
    const pageWindow = { scrollY: 0, scrollTo() {} };
    const result = await probeCaptureWheelScrollContainer(pageWindow, [], documentScroller,
      async (deltaY) => { position += deltaY; return true; }, async () => {}, pageDocument);
    return { moved: result.moved, found: result.scroller === realChatScroller, restored: position === 0 };
  })()`, wheelContext);
  if (!omittedScrollerOutcome.moved || !omittedScrollerOutcome.found || !omittedScrollerOutcome.restored) {
    throw new Error("trusted-wheel discovery must include a real ChatGPT scroller omitted by the size/overflow candidate filters");
  }
  if (!captureSource.includes("const allLiveScrollers = collectLiveCaptureScrollers(document)") ||
      !captureSource.includes("...allLiveScrollers")) {
    throw new Error("full-page capture must wheel-probe the complete live DOM scroller inventory before accepting a one-segment output");
  }
  const liveScrollerOutcome = await vm.runInNewContext(`${captureSource}\n(() => {
    let initial = 0;
    const scroller = { tagName: "DIV", scrollHeight: 5000, clientHeight: 800,
      get scrollTop() { return initial; }, set scrollTop(value) { initial = value; } };
    const documentObject = { scrollingElement: null, documentElement: null, body: null,
      querySelectorAll: () => [scroller] };
    const before = new Map([[scroller, 0]]);
    scroller.scrollTop = 125;
    return findMovedCaptureScroller(documentObject, before, 1)?.element === scroller;
  })()`, wheelContext);
  if (!liveScrollerOutcome) throw new Error("recovery after a stalled scroll must detect an actual scroller omitted from the initial candidate list when its baseline was recorded");
  const staleScrollOutcome = await vm.runInNewContext(`${captureSource}\n(async () => {
    const primary = { tagName: "DIV", id: "primary", scrollHeight: 2000, clientHeight: 800, scrollTop: 0,
      style: {}, getBoundingClientRect() { return { width: 500, height: 700, top: 0, left: 0, right: 500, bottom: 700 }; } };
    const alreadyScrolled = { tagName: "DIV", id: "old-scroll", scrollHeight: 5000, clientHeight: 800, scrollTop: 1200,
      style: {}, getBoundingClientRect() { return { width: 500, height: 700, top: 0, left: 0, right: 500, bottom: 700 }; } };
    const docScroller = { tagName: "HTML", scrollHeight: 800, clientHeight: 800, scrollTop: 0 };
    const doc = { scrollingElement: docScroller, documentElement: docScroller, body: null, querySelectorAll: () => [primary, alreadyScrolled] };
    const win = { scrollY: 0, scrollTo() {} };
    const result = await probeCaptureWheelScrollContainer(win, [primary], docScroller, async () => true, async () => {}, doc);
    return { moved: result.moved, scroller: result.scroller, preserved: alreadyScrolled.scrollTop === 1200 };
  })()`, wheelContext);
  if (staleScrollOutcome.moved || staleScrollOutcome.scroller || !staleScrollOutcome.preserved) {
    throw new Error("wheel preflight must ignore an unmeasured scroller's existing scrollTop instead of falsely selecting and resetting it");
  }
  if (!captureSource.includes("const range = element.scrollHeight - element.clientHeight") ||
      captureSource.includes("if (!/(auto|scroll|overlay|hidden)/.test(style.overflowY)) continue;")) {
    throw new Error("scroll candidates must not be discarded solely because the SPA shell uses nonstandard overflow styling");
  }
  const probeContext = { chrome: { runtime: { onMessage: { addListener() {} } } } };
  const probeOutcomes = await vm.runInNewContext(`${captureSource}\n
    (async () => {
      const waitFrame = async () => {};
      let position = 0;
      const working = { scrollHeight: 900, clientHeight: 800, style: { scrollBehavior: "smooth" }, get scrollTop() { return position; }, set scrollTop(value) { position = value; } };
      const moved = await probeCaptureScrollContainer(working, waitFrame);
      const restored = position === 0 && working.style.scrollBehavior === "smooth";
      let stuckPosition = 0;
      const stuck = { scrollHeight: 900, clientHeight: 800, style: {}, get scrollTop() { return stuckPosition; }, set scrollTop(_value) {} };
      const rejected = !(await probeCaptureScrollContainer(stuck, waitFrame));
      let windowPosition = 0;
      const workingWindow = { get scrollY() { return windowPosition; }, scrollTo(_x, y) { windowPosition = y; } };
      const windowMoved = await probeCaptureWindowScroll(workingWindow, 900, waitFrame);
      const windowRestored = windowPosition === 0;
      const blockedWindow = { scrollY: 0, scrollTo() {} };
      const windowRejected = !(await probeCaptureWindowScroll(blockedWindow, 900, waitFrame));
      let innerPosition = 0;
      const inner = { scrollHeight: 6000, clientHeight: 800, style: {}, get scrollTop() { return innerPosition; }, set scrollTop(value) { innerPosition = value; } };
      let deadPosition = 0;
      const deadWrapper = { scrollHeight: 6100, clientHeight: 800, style: {}, get scrollTop() { return deadPosition; }, set scrollTop(_value) {} };
      const selected = await selectCaptureScrollContainer(blockedWindow, 5300,
        [{element:deadWrapper, range:5300, score:1000}, {element:inner, range:5200, score:900}], null, null, waitFrame);
      let nearBottomPosition = 850;
      const nearBottomWindow = { get scrollY() { return nearBottomPosition; }, scrollTo(_x, y) { nearBottomPosition = y; } };
      const nearBottomMoved = await probeCaptureWindowScroll(nearBottomWindow, 900, waitFrame);
      return { moved, restored, rejected, windowMoved, windowRestored, windowRejected,
        selectedInner: selected === inner, innerRestored: innerPosition === 0, nearBottomMoved, nearBottomRestored: nearBottomPosition === 850 };
    })()
  `, probeContext);
  if (!probeOutcomes.moved || !probeOutcomes.restored || !probeOutcomes.rejected ||
      !probeOutcomes.windowMoved || !probeOutcomes.windowRestored || !probeOutcomes.windowRejected ||
      !probeOutcomes.selectedInner || !probeOutcomes.innerRestored || !probeOutcomes.nearBottomMoved || !probeOutcomes.nearBottomRestored) {
    throw new Error("scroll selection must find the real inner scroller when ranges are similar, restore probes, and work from a page-tail starting position");
  }
  const smoothDocumentProbe = await vm.runInNewContext(`${captureSource}\n(async () => {
    let position = 0;
    let behavior = "smooth";
    let priority = "important";
    const style = {
      getPropertyValue: () => behavior,
      getPropertyPriority: () => priority,
      setProperty: (_name, value, nextPriority) => { behavior = value; priority = nextPriority; },
      removeProperty: () => { behavior = ""; priority = ""; }
    };
    const root = { style, scrollHeight: 4704, clientHeight: 732,
      get scrollTop() { return position; }, set scrollTop(value) { if (behavior === "auto") position = value; } };
    const documentObject = { scrollingElement: root, documentElement: root };
    const pageWindow = { document: documentObject, get scrollY() { return position; },
      scrollTo(_x, y) { if (behavior === "auto") position = y; } };
    const moved = await probeCaptureWindowScroll(pageWindow, 4003, async () => {});
    return { moved, restored: position === 0, styleRestored: behavior === "smooth" && priority === "important" };
  })()`, probeContext);
  if (!smoothDocumentProbe.moved || !smoothDocumentProbe.restored || !smoothDocumentProbe.styleRestored) {
    throw new Error("document scrolling with smooth !important behavior must be detected and restored without requiring a debugger wheel");
  }
  if (!captureSource.includes("const windowScrollVerified = await probeCaptureWindowScroll(window, windowRange)") ||
      !captureSource.includes('event: "window-scroll-preflight"') ||
      !captureSource.includes("if (windowScrollVerified)")) {
    throw new Error("verified document scrolling must bypass debugger-only wheel preflight when the browser rejects debugger attachment");
  }
  const clampContext = { chrome: { runtime: { onMessage: { addListener() {} } } } };
  const tail31 = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(4003, 3972, 3972, 24)`, clampContext);
  if (tail31.overrun || !tail31.reachedBottom || tail31.allowedRangeChange !== 64) {
    throw new Error("the reported 4003/3972 px final-page clamp must be accepted when the measured scroll maximum is 3972 px");
  }
  const staleReportedMaximum = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(4003, 4003, 3972, 24)`, clampContext);
  if (staleReportedMaximum.overrun || !staleReportedMaximum.reachedBottom) {
    throw new Error("a settled position 31 px below a stale reported maximum must be accepted at the final page tail");
  }
  const reported104Clamp = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(4096, 4096, 4068, 24)`, clampContext);
  if (reported104Clamp.overrun || !reported104Clamp.reachedBottom || !reported104Clamp.settledNearTarget) {
    throw new Error("the user's 104-page 4096/4068 px final-tail clamp must be accepted");
  }
  const expanding104Page = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(4096, 5000, 4068, 24, 3900)`, clampContext);
  if (!expanding104Page.settledNearTarget) {
    throw new Error("the 104-page 4096/4068 px advancing near-target scroll must be accepted while the page is still expanding");
  }
  const unchangedViewport = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(4096, 5000, 3900, 24, 3900)`, clampContext);
  if (unchangedViewport.settledNearTarget) throw new Error("a repeated viewport without forward scroll progress must still be rejected");
  const midPageStall = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(2000, 5000, 1500, 24)`, clampContext);
  if (midPageStall.reachedBottom) throw new Error("a mid-page position mismatch must not be accepted as a tail clamp");
  const oversizedTailChange = vm.runInNewContext(`${captureSource}\nevaluateCaptureScrollClamp(4004, 3939, 3939, 24)`, clampContext);
  if (!oversizedTailChange.overrun) throw new Error("tail changes greater than 64 px must still fail closed");
  if (!captureSource.includes("function getNextCaptureTarget") || !captureSource.includes("getNextCaptureTarget(outputCoveredCss, captureViewportHeight, captureStepStride, i === 1)")) {
    throw new Error("capture tiles must be aligned to the actually covered frontier");
  }
  const frontierTest = vm.runInNewContext(`${captureSource}\n(() => { let covered=0, y=0; const positions=[]; for (let i=0;i<10;i++) { y=i===0?0:getNextCaptureTarget(covered,1000,180,i===1); const actual=y-(i===4?28:0); const top=i===0?0:covered-actual; const draw=i===0?820:1000-top; positions.push({y,actual,top}); covered+=draw; } return {positions,covered}; })()`, clampContext);
  if (frontierTest.positions[5].y !== frontierTest.positions[4].actual + 180 || frontierTest.positions.some((p, i) => i > 0 && p.top >= 1000)) {
    throw new Error("a one-tile 28 px scroll clamp must not accumulate into a later stitch discontinuity");
  }
  const staleTailTarget = vm.runInNewContext(`${captureSource}\ngetPageCaptureTarget(4580,4099,true)`, clampContext);
  if (staleTailTarget !== 4099) throw new Error("a stale 4580 px planned endpoint must clamp to the live 4099 px page bottom");
  const expandingTail = vm.runInNewContext(`${captureSource}\n(() => { const viewport=834, liveMax=4744, totalHeight=liveMax+viewport, stride=133; let covered=3890, count=0, gap=false; while (covered<totalHeight-2 && count<100) { const last=true; const jump=shouldJumpToCaptureTail(last,liveMax,covered); const target=getPageCaptureTarget(getNextCaptureTarget(covered,viewport,stride),liveMax,jump); const sourceTop=covered-target; if (sourceTop < -2 || sourceTop >= viewport) gap=true; const draw=Math.min(viewport-Math.max(0,sourceTop),totalHeight-covered); if (draw<=0) { gap=true; break; } covered+=draw; count++; } return {covered,count,gap,totalHeight}; })()`, clampContext);
  if (expandingTail.gap || expandingTail.covered < expandingTail.totalHeight - 2 || expandingTail.count < 2) {
    throw new Error("the supplied YouTube 3890/4744 px case must extend the plan and cover every remaining pixel without a gap");
  }
  if (!captureSource.includes("const expandCaptureHeight = (measuredHeight)") ||
      !captureSource.includes('event: "page-height-expanded"') ||
      !captureSource.includes("uniqueSteps.push(null)")) {
    throw new Error("dynamic page growth must expand output capacity and append capture segments");
  }
  const safeShrink = vm.runInNewContext(`${captureSource}\ncanTrimCaptureTail(5180,4799,4799,4099,4099)`, clampContext);
  if (!safeShrink) throw new Error("a contracted page may be trimmed once its live bottom and all remaining pixels are covered");
  const incompleteShrink = vm.runInNewContext(`${captureSource}\ncanTrimCaptureTail(5180,4799,4700,4099,4099)`, clampContext);
  const notAtBottomShrink = vm.runInNewContext(`${captureSource}\ncanTrimCaptureTail(5180,4799,4799,4000,4099)`, clampContext);
  if (incompleteShrink || notAtBottomShrink) throw new Error("page shrink must not be accepted before complete coverage at the live bottom");
  const covered4099Clamp = vm.runInNewContext(`${captureSource}\n({skip:isCoveredClampedTail(732,732,4800,4068,4099,31),trim:canTrimCaptureTail(4831,4800,4800,4068,4099,31)})`, clampContext);
  if (!covered4099Clamp.skip || !covered4099Clamp.trim) throw new Error("the reported 4099/4068/4800/732 px tail must skip the empty tile and trim only the already-covered 31 px phantom tail");
  const uncovered4099Clamp = vm.runInNewContext(`${captureSource}\n({skip:isCoveredClampedTail(732,732,4790,4068,4099,31),trim:canTrimCaptureTail(4831,4800,4790,4068,4099,31)})`, clampContext);
  if (uncovered4099Clamp.skip || uncovered4099Clamp.trim) throw new Error("the 4099/4068 px clamp must not trim or skip when the visible tail is not fully covered");
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
  if (captureSource.indexOf("const isVisible =") < 0 || captureSource.indexOf("const isVisible =") > captureSource.indexOf("const fixedCandidates =")) throw new Error("isVisible must be initialized before the fixed-control scan");
  for (const marker of ["capture-full-page-segment", "begin-full-page-capture-session", "end-full-page-capture-session", "begin-full-page-download", "append-full-page-download", "finish-full-page-download", "window.scrollTo(0, targetY)", "const conservativeStride = Math.max(80, Math.min(180, Math.floor(captureStepHeight * 0.16)))", "function getFastStaticCaptureStride(viewportHeight)", "MutationObserver", "garmin\\.com", "fastStaticStride", "uniqueSteps.length === 1 || fastStaticStride", "bottomClampPx", "outputCoveredCss", "第 ${i + 1} 段截圖高度無效", "長圖只拼接到", "for (let y = 0; y < scrollRange; y += captureStepStride)", "isFixedCaptureChrome", "repeated-fixed-ui-filter", "repeatedFixedUiOriginals", "網頁沒有捲動到第", "persistentSidePanelRoots", "persistentSidePanelRegions", "scrollCandidates", "panelSteps", "const panelY = panelSteps[index]", "panel.scroller.scrollTop = Math.min(panelY, panel.scrollRange)", "panel.contentHeight - panelY", "panel.originalScrollTop", 'ctx.clip("evenodd")', "panel.scroller.scrollTop = 0", "finally", "window.scrollTo(original.x"]) {
    if (!captureSource.includes(marker)) throw new Error(`background-safe capture feature missing: ${marker}`);
  }
  if (!backgroundSource.includes('const captureFormat = "png"') || !backgroundSource.includes('createImagePage(options.oneNoteSectionId, pngBlob')) {
    throw new Error("OneNote image path must preserve the lossless PNG source");
  }
  const clipboardImage = await vm.runInContext(`saveSelectedRegion({rect:{x:0,y:0,width:50,height:40},viewportWidth:100,viewportHeight:50,options:{imageFormat:"jpg",target:"onenote",oneNoteMode:"clipboard"}},{tab:{id:1,windowId:1,title:"Test"}})`, backgroundContext);
  if (backgroundContext.lastSegmentCaptureOptions?.format !== "png" || !clipboardImage.clipboardDataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("OneNote clipboard capture must remain full-resolution PNG when JPG is selected");
  }
  const sendBackgroundMessage = (message) => new Promise((resolve, reject) => {
    const keepAlive = messageListener(message, { tab: { id: 1, windowId: 1 } }, resolve);
    if (!keepAlive) reject(new Error(`${message.type} channel did not stay open`));
  });
  const logWrite = await sendBackgroundMessage({ type: "full-page-capture-progress", jobId: "diagnostic-job", diagnostic: { event: "test-event" } });
  if (!logWrite?.ok) throw new Error("full capture diagnostic event was not persisted");
  const logRead = await sendBackgroundMessage({ type: "get-full-page-capture-log" });
  if (!logRead?.ok || logRead.log?.jobId !== "diagnostic-job" || logRead.log.entries.at(-1)?.event !== "test-event") {
    throw new Error("persisted full capture diagnostic log could not be retrieved after popup close");
  }
  const beginCapture = await sendBackgroundMessage({ type: "begin-full-page-capture-session", jobId: "capture-job" });
  if (!beginCapture?.ok || backgroundContext.debuggerAttach?.target?.tabId !== 1) throw new Error("background capture debugger attach failed");
  backgroundContext.chrome.tabs.zoom = 1.75;
  const zoomBegin = await sendBackgroundMessage({ type: "begin-full-page-capture-session", jobId: "zoom-job" });
  if (!zoomBegin?.ok || zoomBegin.zoomAdjusted || backgroundContext.chrome.tabs.zoom !== 1.75) {
    throw new Error("capture must preserve the user's 175% browser zoom");
  }
  const zoomEnd = await sendBackgroundMessage({ type: "end-full-page-capture-session", jobId: "zoom-job" });
  if (!zoomEnd?.ok || backgroundContext.chrome.tabs.zoom !== 1.75) {
    throw new Error("capture must leave the user's 175% browser zoom unchanged");
  }
  const captureReply = await new Promise((resolve, reject) => {
    const keepAlive = messageListener({ type: "capture-full-page-segment", jobId: "capture-job", options: { format: "png" } }, { tab: { id: 1, windowId: 1 } }, resolve);
    if (!keepAlive) reject(new Error("segment capture message channel did not stay open"));
  });
  if (!captureReply?.ok || captureReply.dataUrl !== "data:image/png;base64,dGVzdA==") {
    throw new Error("inactive-tab CDP screenshot segment integration failed");
  }
  if (!backgroundContext.debuggerCommands.some((item) => item.method === "Page.captureScreenshot" && item.params.captureBeyondViewport === false)) throw new Error("CDP screenshot command was not issued");
  const wheelReply = await sendBackgroundMessage({ type: "scroll-capture-by-wheel", jobId: "capture-job", x: 640, y: 400, deltaY: 125 });
  const wheelCommand = backgroundContext.debuggerCommands.find((item) => item.method === "Input.dispatchMouseEvent");
  if (!wheelReply?.ok || wheelCommand?.params?.type !== "mouseWheel" || wheelCommand.params.deltaY !== 125 || wheelCommand.params.x !== 640) {
    throw new Error("direct-scroll failure fallback must dispatch the requested CDP wheel input to the source tab");
  }
  const tailReply = await sendBackgroundMessage({ type: "capture-full-page-segment", jobId: "capture-job", options: { format: "png", clip: { x: 0, y: 1000, width: 800, height: 6, scale: 1 } } });
  if (!tailReply?.ok || !backgroundContext.debuggerCommands.some((item) => item.method === "Page.captureScreenshot" && item.params.captureBeyondViewport === true && item.params.clip?.y === 1000)) {
    throw new Error("sub-viewport page-tail capture was not requested through CDP");
  }
  const endedCapture = await sendBackgroundMessage({ type: "end-full-page-capture-session", jobId: "capture-job" });
  if (!endedCapture?.ok || backgroundContext.debuggerDetached?.tabId !== 1) throw new Error("capture debugger was not detached after the job");
  backgroundContext.failDebuggerAttach = true;
  const originalAttach = backgroundContext.chrome.debugger.attach;
  backgroundContext.chrome.debugger.attach = async () => { throw new Error("Cannot attach to this target."); };
  const fallbackBegin = await sendBackgroundMessage({ type: "begin-full-page-capture-session", jobId: "fallback-job" });
  if (!fallbackBegin?.ok || fallbackBegin.mode !== "visible") throw new Error("debugger rejection must select the visible-tab fallback");
  backgroundContext.activeTabId = 2;
  const waitingCapture = await sendBackgroundMessage({ type: "capture-full-page-segment", jobId: "fallback-job", options: { format: "png" } });
  if (waitingCapture?.ok || !waitingCapture?.message?.includes("CAPTURE_WAITING_FOR_SOURCE_TAB")) {
    throw new Error("visible-tab fallback must wait rather than capture a different active tab");
  }
  backgroundContext.activeTabId = 1;
  const fallbackCapture = await sendBackgroundMessage({ type: "capture-full-page-segment", jobId: "fallback-job", options: { format: "png" } });
  if (!fallbackCapture?.ok || fallbackCapture.mode !== "visible" || fallbackCapture.dataUrl !== "data:image/png;base64,dGVzdA==") {
    throw new Error("visible-tab fallback did not resume on the original tab");
  }
  await sendBackgroundMessage({ type: "end-full-page-capture-session", jobId: "fallback-job" });
  backgroundContext.chrome.debugger.attach = originalAttach;
  const payload = "data:image/png;base64,dGVzdA==";
  const started = await sendBackgroundMessage({ type: "begin-full-page-download", jobId: "job-test", filename: "capture.png" });
  if (!started.ok) throw new Error("background image download setup failed");
  const appended = await sendBackgroundMessage({ type: "append-full-page-download", jobId: "job-test", chunk: payload });
  if (!appended.ok) throw new Error("background image chunk transfer failed");
  const downloadReply = await sendBackgroundMessage({ type: "finish-full-page-download", jobId: "job-test" });
  if (!downloadReply?.ok || downloadReply.downloadId !== 1 || backgroundContext.downloadRequests.at(-1)?.url !== payload) {
    throw new Error("automatic background image download integration failed");
  }
  if (!captureSource.includes('const segmentCaptureOptions = { format: "png" }') ||
    !captureSource.includes('segmentFormat: "png-lossless"') ||
    !captureSource.includes('event: "capture-zoom"') ||
    !captureSource.includes('canvasToBlob(part.canvas, "image/png")') ||
    !captureSource.includes('canvasToBlob(croppedCanvas, "image/png")') ||
    !popupSource.includes('quality: uiFormat === "jpg" ? 96 : undefined,')) {
  throw new Error("full-page capture tiles and intermediate parts must stay lossless until final encoding");
}
if (captureSource.includes('canvasToBlob(part.canvas, imageOptions.mimeType') || captureSource.includes('canvasToBlob(croppedCanvas, imageOptions.mimeType')) {
  throw new Error("intermediate image parts must not be JPEG-compressed before final output");
}
if (captureSource.includes('captureSegmentWithRetry(jobId, windowId, captureOptions, `第 ${i + 1} 段`)')) {
  throw new Error("full-page tiles must not be compressed as JPG before stitching");
}
const fixedUiContext = { chrome: { runtime: { onMessage: { addListener() {} } } } };
const fixedUiOutcomes = vm.runInNewContext(`${captureSource}\n(() => {
  const style = { position: "fixed" };
  const rect = { left: 4, top: 1080, right: 52, bottom: 1128, width: 48, height: 48 };
  const fixedWidget = { getBoundingClientRect: () => rect };
  const stillFixed = isRepeatedFixedCaptureUi(fixedWidget, rect, 1433, 1132, () => style);
  const movedRect = { ...rect, top: 720, bottom: 768 };
  const pageContent = { getBoundingClientRect: () => movedRect };
  const movedContentRejected = !isRepeatedFixedCaptureUi(pageContent, rect, 1433, 1132, () => style);
  const centerRect = { left: 500, top: 400, right: 548, bottom: 448, width: 48, height: 48 };
  const centeredWidget = { getBoundingClientRect: () => centerRect };
  const centralUiPreserved = !isFixedCaptureChrome(centeredWidget, centerRect, 1433, 1132, () => style);
  return { stillFixed, movedContentRejected, centralUiPreserved };
})()`, fixedUiContext);
if (!fixedUiOutcomes.stillFixed || !fixedUiOutcomes.movedContentRejected || !fixedUiOutcomes.centralUiPreserved) {
  throw new Error("only small fixed edge controls that remain stationary across scrolling may be hidden from later tiles");
}
const sensorOutcomes = vm.runInNewContext(`${captureSource}\n(() => {
  const declarations = new Map();
  const style = { setProperty(name, value, priority) { declarations.set(name, { value, priority }); },
    getPropertyValue(name) { return declarations.get(name)?.value || ""; },
    getPropertyPriority(name) { return declarations.get(name)?.priority || ""; },
    removeProperty(name) { declarations.delete(name); } };
  const sensor = { tagName: "DIV", className: "resize-sensor-shrink", id: "", style,
    scrollHeight: 1262, clientHeight: 631, clientWidth: 1254, scrollTop: 626, scrollLeft: 1254,
    getAttribute: () => "", getBoundingClientRect: () => ({ left: 0, top: 0, right: 1254, bottom: 631, width: 1254, height: 631 }), isConnected: true };
  const realScroller = { tagName: "DIV", className: "markdown-body", id: "content", style: {},
    scrollHeight: 4800, clientHeight: 631, clientWidth: 1254, scrollTop: 0, scrollLeft: 0,
    getAttribute: () => "", getBoundingClientRect: () => ({ left: 0, top: 0, right: 1254, bottom: 631, width: 1254, height: 631 }), isConnected: true };
  const view = { getComputedStyle: (element) => ({ overflowY: "hidden", flexDirection: "row", position: "static" }) };
  const pageDocument = { defaultView: view, scrollingElement: null, documentElement: null, body: null,
    querySelectorAll: (selector) => selector === "iframe" ? [] : selector.includes("resize-sensor") ? [sensor] : [sensor, realScroller] };
  const candidates = collectCaptureScrollCandidates(pageDocument, 1254, 631);
  const liveScrollers = collectLiveCaptureScrollers(pageDocument);
  const original = disableCaptureResizeSensorHitTesting(pageDocument);
  const passedThrough = declarations.get("pointer-events")?.value === "none" && declarations.get("pointer-events")?.priority === "important";
  restoreCaptureResizeSensorHitTesting(original);
  const restored = !declarations.has("pointer-events");
  return { sensorClassified: isCaptureResizeSensor(sensor), sensorExcluded: !candidates.some((x) => x.element === sensor) && !liveScrollers.includes(sensor),
    realScrollerFound: candidates.some((x) => x.element === realScroller) && liveScrollers.includes(realScroller), passedThrough, restored };
})()`, { getComputedStyle: () => ({ overflowY: "auto", flexDirection: "row" }), chrome: { runtime: { onMessage: { addListener() {} } } } });
if (!sensorOutcomes.sensorClassified || !sensorOutcomes.sensorExcluded || !sensorOutcomes.realScrollerFound ||
    !sensorOutcomes.passedThrough || !sensorOutcomes.restored) {
  throw new Error("HackMD resize-sensor regression must exclude its range-625 sensor, detect the real scroller, and restore pointer events");
}
const iframeOutcomes = vm.runInNewContext(`${captureSource}\n(() => {
  const childView = { getComputedStyle: () => ({ overflowY: "auto", flexDirection: "row" }), frameElement: null };
  const childScroller = { tagName: "DIV", className: "iframe-content", id: "main", ownerDocument: null,
    scrollHeight: 2400, clientHeight: 600, clientWidth: 800, getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) };
  const childDocument = { defaultView: childView, documentElement: {}, querySelectorAll: () => [childScroller] };
  childScroller.ownerDocument = childDocument;
  const frame = { contentDocument: childDocument, getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 }) };
  childView.frameElement = frame;
  const parentView = {};
  childView.parent = parentView;
  const parentDocument = { defaultView: parentView, querySelectorAll: (selector) => selector === "iframe" ? [frame] : [] };
  const docs = getAccessibleCaptureDocuments(parentDocument);
  const candidates = collectCaptureScrollCandidates(parentDocument, 1000, 700);
  const rect = getCaptureElementRectInTopViewport(childScroller, parentView);
  return { scanned: docs.includes(childDocument), found: candidates.some((item) => item.element === childScroller), rect };
})()`, { getComputedStyle: () => ({ overflowY: "auto", flexDirection: "row" }), chrome: { runtime: { onMessage: { addListener() {} } } } });
if (!iframeOutcomes.scanned || !iframeOutcomes.found || iframeOutcomes.rect.left !== 100 || iframeOutcomes.rect.top !== 50) {
  throw new Error("accessible iframe scrollers must be discovered and mapped to the top-level screenshot viewport");
}
const speedContext = { chrome: { runtime: { onMessage: { addListener() {} } } } };
const speedOutcomes = vm.runInNewContext(`${captureSource}\n({
  stableInner: shouldProbeFastStaticCapture(false, 625, 631, true),
  shortPage: shouldProbeFastStaticCapture(false, 300, 631, true),
  noObserver: shouldProbeFastStaticCapture(false, 2000, 631, false),
  table: shouldProbeFastStaticCapture(true, 5000, 800, true),
  stride: getFastStaticCaptureStride(631)
})`, speedContext);
if (!speedOutcomes.stableInner || speedOutcomes.shortPage || speedOutcomes.noObserver || speedOutcomes.table || speedOutcomes.stride !== 441) {
  throw new Error("fast capture must include stable inner scrollers, preserve conservative exclusions, and retain the proven 70% stride");
}
if (!captureSource.includes("const mutationRoots = [...new Set([body, activeScroller?.ownerDocument?.body].filter(Boolean))]")) {
  throw new Error("fast stride must observe both the page and active iframe body for content mutations");
}
console.log("Smoke tests passed: v2.5.44 stable-page speed path, v2.5.43 HackMD sensor fix, iframe scroll detection, and capture regressions");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
