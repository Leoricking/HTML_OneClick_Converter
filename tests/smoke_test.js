const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const manifest = JSON.parse(read("manifest.json"));
if (manifest.version !== "2.5.15") throw new Error("manifest version must be 2.5.15");
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
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    identity: { getRedirectURL: () => "https://test.chromiumapp.org/microsoft" },
    downloads: { download: (options, callback) => {
      backgroundContext.downloadRequests.push(options);
      if (callback) callback(1);
      return Promise.resolve(1);
    } },
    tabs: {
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
  if (!captureSource.includes("function getNextCaptureTarget") || !captureSource.includes("getNextCaptureTarget(outputCoveredCss, viewportHeight, captureStepStride, i === 1)")) {
    throw new Error("capture tiles must be aligned to the actually covered frontier");
  }
  const frontierTest = vm.runInNewContext(`${captureSource}\n(() => { let covered=0, y=0; const positions=[]; for (let i=0;i<10;i++) { y=i===0?0:getNextCaptureTarget(covered,1000,180,i===1); const actual=y-(i===4?28:0); const top=i===0?0:covered-actual; const draw=i===0?820:1000-top; positions.push({y,actual,top}); covered+=draw; } return {positions,covered}; })()`, clampContext);
  if (frontierTest.positions[5].y !== frontierTest.positions[4].actual + 180 || frontierTest.positions.some((p, i) => i > 0 && p.top >= 1000)) {
    throw new Error("a one-tile 28 px scroll clamp must not accumulate into a later stitch discontinuity");
  }
  const staleTailTarget = vm.runInNewContext(`${captureSource}\ngetPageCaptureTarget(4580,4099,true)`, clampContext);
  if (staleTailTarget !== 4099) throw new Error("a stale 4580 px planned endpoint must clamp to the live 4099 px page bottom");
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
  for (const marker of ["capture-full-page-segment", "begin-full-page-capture-session", "end-full-page-capture-session", "begin-full-page-download", "append-full-page-download", "finish-full-page-download", "window.scrollTo(0, targetY)", "const conservativeStride = Math.max(80, Math.min(180, Math.floor(captureStepHeight * 0.16)))", "const fastStride = Math.max(180, Math.floor(captureStepHeight * 0.7))", "MutationObserver", "garmin\\.com", "fastStaticStride", "uniqueSteps.length === 1 || fastStaticStride", "bottomClampPx", "outputCoveredCss", "第 ${i + 1} 段截圖高度無效", "長圖只拼接到", "for (let y = 0; y < scrollRange; y += captureStepStride)", "Never hide page elements while capturing", "網頁沒有捲動到第", "persistentSidePanelRoots", "persistentSidePanelRegions", "scrollCandidates", "panelSteps", "const panelY = panelSteps[index]", "panel.scroller.scrollTop = Math.min(panelY, panel.scrollRange)", "panel.contentHeight - panelY", "panel.originalScrollTop", 'ctx.clip("evenodd")', "panel.scroller.scrollTop = 0", "finally", "window.scrollTo(original.x"]) {
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
  const beginCapture = await sendBackgroundMessage({ type: "begin-full-page-capture-session", jobId: "capture-job" });
  if (!beginCapture?.ok || backgroundContext.debuggerAttach?.target?.tabId !== 1) throw new Error("background capture debugger attach failed");
  const captureReply = await new Promise((resolve, reject) => {
    const keepAlive = messageListener({ type: "capture-full-page-segment", jobId: "capture-job", options: { format: "png" } }, { tab: { id: 1, windowId: 1 } }, resolve);
    if (!keepAlive) reject(new Error("segment capture message channel did not stay open"));
  });
  if (!captureReply?.ok || captureReply.dataUrl !== "data:image/png;base64,dGVzdA==") {
    throw new Error("inactive-tab CDP screenshot segment integration failed");
  }
  if (!backgroundContext.debuggerCommands.some((item) => item.method === "Page.captureScreenshot" && item.params.captureBeyondViewport === false)) throw new Error("CDP screenshot command was not issued");
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
  if (captureSource.includes("el.style.setProperty('visibility', 'hidden'") || captureSource.includes('pos === "sticky"')) {
    throw new Error("full-page capture must not hide page content based on element positioning");
  }
  console.log("Smoke tests passed: v2.5.15 serialized visible-capture quota and retry policy, v2.5.14 exact 4099/4068/4800/732 tail overlap regression, live-tail shrink recovery, coverage-frontier alignment, downloads, clipping, OneNote, and existing features");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
