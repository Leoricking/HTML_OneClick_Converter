importScripts("onenote.js");

const pendingFullPageDownloads = new Map();
const fullPageDebuggerSessions = new Map();
const visibleCaptureQueues = new Map();
const visibleCaptureStartedAt = new Map();
const VISIBLE_CAPTURE_MIN_INTERVAL_MS = 600;

function debuggerCommand(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function beginFullPageDebuggerSession(tabId, windowId, jobId) {
  if (!Number.isInteger(tabId) || !jobId) throw new Error("完整頁面截圖工作資訊不完整。");
  if (fullPageDebuggerSessions.has(jobId)) return { ok: true };
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await debuggerCommand(target, "Page.enable");
  } catch (error) {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch {}
    }
    // Some Chromium builds/pages reject debugger attachment. Keep the job
    // usable by falling back to captureVisibleTab; segment requests will wait
    // for the source tab to become active instead of accidentally capturing a
    // different tab or cancelling the whole job.
    const reason = error?.message || String(error);
    fullPageDebuggerSessions.set(jobId, { tabId, windowId, target, mode: "visible", fallbackReason: reason });
    return { ok: true, mode: "visible", warning: reason };
  }
  fullPageDebuggerSessions.set(jobId, { tabId, windowId, target, mode: "debugger" });
  return { ok: true, mode: "debugger" };
}

async function endFullPageDebuggerSession(jobId, tabId) {
  const session = fullPageDebuggerSessions.get(jobId);
  if (!session || (Number.isInteger(tabId) && session.tabId !== tabId)) return { ok: true };
  fullPageDebuggerSessions.delete(jobId);
  try { if (session.mode === "debugger") await chrome.debugger.detach(session.target); } catch (error) {
    console.warn("Could not detach screenshot debugger session:", error);
  }
  return { ok: true };
}

chrome.debugger.onDetach.addListener((source) => {
  for (const [jobId, session] of fullPageDebuggerSessions) {
    if (session.tabId === source.tabId && session.mode === "debugger") {
      session.mode = "visible";
      session.fallbackReason = "背景截圖連線已中斷";
    }
  }
});

async function captureTabViewport(tabId, options, jobId) {
  const session = fullPageDebuggerSessions.get(jobId);
  if (!session || session.tabId !== tabId) throw new Error("來源分頁的背景截圖工作已中斷，請重新開始。");
  if (session.mode === "visible") {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: session.windowId });
    if (activeTab?.id !== tabId) throw new Error("[CAPTURE_WAITING_FOR_SOURCE_TAB] 請切回原網頁；截圖會在原分頁回到前景後自動續跑。");
    const dataUrl = await captureVisibleTabCompat(session.windowId, { format: options?.format === "jpeg" ? "jpeg" : "png", ...(options?.format === "jpeg" && Number.isFinite(options?.quality) ? { quality: options.quality } : {}) });
    return { dataUrl, mode: "visible" };
  }
  const format = options?.format === "jpeg" ? "jpeg" : "png";
  const clip = options?.clip && typeof options.clip === "object" ? options.clip : null;
  const params = { format, fromSurface: true, captureBeyondViewport: Boolean(clip) };
  if (clip) params.clip = clip;
  if (format === "jpeg" && Number.isFinite(options?.quality)) params.quality = options.quality;
  const result = await debuggerCommand(session.target, "Page.captureScreenshot", params);
  if (typeof result?.data !== "string" || !result.data) throw new Error("瀏覽器沒有回傳來源分頁截圖資料。");
  return { dataUrl: `data:image/${format};base64,${result.data}`, mode: "debugger" };
}

function safeFilename(value, fallback = "webpage") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function clipFolder(options = {}) {
  return `HTML網頁剪藏/${safeFilename(options.notebook, "未分類")}`;
}

function metadataText(options = {}) {
  return [
    `標題：${options.title || ""}`,
    `網址：${options.url || ""}`,
    `下載分類：${options.notebook || "未分類"}`,
    `OneNote 位置：${options.oneNoteNotebookName && options.oneNoteSectionName ? `${options.oneNoteNotebookName} / ${options.oneNoteSectionName}` : "剪貼簿模式"}`,
    `標籤：${Array.isArray(options.tags) ? options.tags.join(", ") : ""}`,
    `剪藏時間：${new Date().toLocaleString("zh-TW", { hour12: false })}`,
    "",
    "備註：",
    options.note || ""
  ].join("\r\n");
}

async function downloadBlob(blob, filename) {
  const url = await blobToDataUrl(blob);
  return chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });
}

function captureVisibleTabCompat(windowId, options) {
  const previous = visibleCaptureQueues.get(windowId) || Promise.resolve();
  const capture = previous.catch(() => {}).then(async () => {
    const lastStarted = visibleCaptureStartedAt.get(windowId);
    if (Number.isFinite(lastStarted)) {
      const waitMs = VISIBLE_CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastStarted);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    visibleCaptureStartedAt.set(windowId, Date.now());
    return captureVisibleTabOnce(windowId, options);
  });
  visibleCaptureQueues.set(windowId, capture.catch(() => {}));
  return capture;
}

function captureVisibleTabOnce(windowId, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("瀏覽器截圖逾時。")), 25000);
    const callback = (dataUrl) => {
      const apiError = chrome.runtime.lastError;
      if (apiError) finish(reject, new Error(apiError.message || "瀏覽器截圖失敗。"));
      else if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) finish(reject, new Error("瀏覽器沒有回傳有效的截圖資料。"));
      else finish(resolve, dataUrl);
    };
    try {
      const result = chrome.tabs.captureVisibleTab(windowId, options, callback);
      if (result && typeof result.then === "function") result.then((dataUrl) => {
        if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) finish(reject, new Error("瀏覽器沒有回傳有效的截圖資料。"));
        else finish(resolve, dataUrl);
      }, (error) => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function saveSelectedHtml(message) {
  const options = message.options || {};
  const title = safeFilename(options.title, "selected-content");
  const suffix = safeFilename(message.suffix, "選取元素");
  const filename = `${clipFolder(options)}/${title}_${timestamp()}_${suffix}.html`;
  const blob = new Blob(["\uFEFF", message.html || ""], { type: "text/html;charset=utf-8" });
  const shouldDownload = options.target !== "onenote";
  const shouldCreateOneNote = options.target !== "download" && options.oneNoteMode === "direct";
  if (shouldDownload) await downloadBlob(blob, filename);
  if (shouldCreateOneNote) {
    await OneNoteClient.createHtmlPage(options.oneNoteSectionId, message.html || "", options.title);
  }
  return {
    ok: true,
    oneNoteCreated: shouldCreateOneNote,
    message: shouldDownload && shouldCreateOneNote
      ? `${suffix} HTML 已下載，並在 OneNote 建立新頁面。`
      : shouldCreateOneNote ? `${suffix}已在 OneNote 建立新頁面。` : `${suffix} HTML 已下載。`
  };
}

async function saveSelectedRegion(message, sender) {
  const tab = sender.tab;
  if (!tab?.windowId) throw new Error("找不到來源分頁視窗。");
  const options = message.options || {};
  // Capture losslessly first. OneNote's clipboard and Graph paths always get
  // the original PNG pixels; JPG is generated separately only for a requested
  // file download, so a JPG setting cannot blur the image pasted into OneNote.
  const requestedDownloadFormat = options.imageFormat === "jpg" ? "jpeg" : "png";
  const captureFormat = "png";
  const captureOptions = { format: captureFormat };
  const dataUrl = await captureVisibleTabCompat(tab.windowId, captureOptions);
  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  const rect = message.rect || {};
  const scaleX = bitmap.width / Math.max(1, Number(message.viewportWidth) || bitmap.width);
  const scaleY = bitmap.height / Math.max(1, Number(message.viewportHeight) || bitmap.height);
  const sx = Math.max(0, Math.round((Number(rect.x) || 0) * scaleX));
  const sy = Math.max(0, Math.round((Number(rect.y) || 0) * scaleY));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round((Number(rect.width) || 1) * scaleX)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round((Number(rect.height) || 1) * scaleY)));
  const canvas = new OffscreenCanvas(sw, sh);
  const context = canvas.getContext("2d", { alpha: true });
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  const shouldDownload = options.target !== "onenote" || Boolean(message.forceDownload);
  const shouldCreateOneNote = options.target !== "download" && options.oneNoteMode === "direct" && !message.forceDownload;
  const useJpgForDownload = shouldDownload && requestedDownloadFormat === "jpeg" && !(message.forceDownload && options.target === "onenote");
  const extension = useJpgForDownload ? "jpg" : "png";
  const outputBlob = useJpgForDownload
    ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })
    : pngBlob;
  const title = safeFilename(options.title, tab.title || "selected-region");
  const stamp = timestamp();
  const filename = `${clipFolder(options)}/${title}_${stamp}_選取區域.${extension}`;
  if (shouldDownload) {
    await downloadBlob(outputBlob, filename);
    const metadataBlob = new Blob(["\uFEFF", metadataText(options)], { type: "text/plain;charset=utf-8" });
    await downloadBlob(metadataBlob, `${clipFolder(options)}/${title}_${stamp}_剪藏資訊.txt`);
  }
  if (shouldCreateOneNote) {
    await OneNoteClient.createImagePage(options.oneNoteSectionId, pngBlob, options);
  }
  let clipboardDataUrl = "";
  if (options.target !== "download" && options.oneNoteMode !== "direct" && !message.forceDownload) {
    clipboardDataUrl = await blobToDataUrl(pngBlob);
  }
  return {
    ok: true,
    oneNoteCreated: shouldCreateOneNote,
    message: shouldDownload && shouldCreateOneNote
      ? `選取區域 ${extension.toUpperCase()} 已下載，並在 OneNote 建立新頁面。`
      : shouldCreateOneNote ? "選取區域已在 OneNote 建立新頁面。"
      : shouldDownload ? `選取區域 ${extension.toUpperCase()} 已下載。` : "選取區域已準備複製。",
    clipboardDataUrl,
    clipboardMime: clipboardDataUrl ? "image/png" : ""
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.type === "full-page-capture-progress") {
    chrome.runtime.sendMessage({
      type: "full-capture-progress-update",
      progress: message.progress,
      status: message.status,
      statusType: message.statusType
    }).catch(() => {});
    return false;
  }
  if (!["clip-selected-html", "clip-selected-region", "begin-full-page-capture-session", "end-full-page-capture-session", "capture-full-page-segment",
    "begin-full-page-download", "append-full-page-download", "finish-full-page-download", "abort-full-page-download"].includes(message.type)) return false;
  (async () => {
    if (message.type === "clip-selected-html") return saveSelectedHtml(message);
    if (message.type === "clip-selected-region") return saveSelectedRegion(message, sender);
    if (message.type === "begin-full-page-capture-session") {
      if (!sender.tab?.id) throw new Error("找不到來源分頁，無法啟用背景截圖。");
      if (!Number.isInteger(sender.tab.windowId)) throw new Error("找不到來源分頁視窗，無法啟用截圖。");
      return beginFullPageDebuggerSession(sender.tab.id, sender.tab.windowId, message.jobId);
    }
    if (message.type === "end-full-page-capture-session") {
      return endFullPageDebuggerSession(message.jobId, sender.tab?.id);
    }
    if (message.type === "capture-full-page-segment") {
      if (!sender.tab?.id || !Number.isInteger(sender.tab.windowId)) throw new Error("找不到完整頁面截圖的來源分頁。");
      const captured = await captureTabViewport(sender.tab.id, message.options || { format: "png" }, message.jobId);
      return { ok: true, ...captured };
    }
    if (message.type === "begin-full-page-download") {
      if (!sender.tab?.id || !message.jobId || typeof message.filename !== "string") throw new Error("長圖下載工作資訊不完整。");
      pendingFullPageDownloads.set(message.jobId, { tabId: sender.tab.id, filename: message.filename, chunks: [] });
      return { ok: true };
    }
    if (message.type === "append-full-page-download") {
      const pending = pendingFullPageDownloads.get(message.jobId);
      if (!pending || pending.tabId !== sender.tab?.id) throw new Error("長圖下載工作已逾時或來源分頁不符，請重新截圖。");
      if (typeof message.chunk !== "string" || message.chunk.length > 512 * 1024) throw new Error("長圖資料區塊格式不正確。");
      pending.chunks.push(message.chunk);
      return { ok: true };
    }
    if (message.type === "abort-full-page-download") {
      const pending = pendingFullPageDownloads.get(message.jobId);
      if (pending?.tabId === sender.tab?.id) pendingFullPageDownloads.delete(message.jobId);
      return { ok: true };
    }
    if (message.type === "finish-full-page-download") {
      const pending = pendingFullPageDownloads.get(message.jobId);
      if (!pending || pending.tabId !== sender.tab?.id) throw new Error("長圖下載工作已逾時，請重新截圖。");
      pendingFullPageDownloads.delete(message.jobId);
      const dataUrl = pending.chunks.join("");
      if (!/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) throw new Error("完整網頁圖片資料無效，無法下載。");
      const downloadId = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error("圖片下載逾時；請重新執行完整頁面截圖。")); }
        }, 30000);
        try {
          chrome.downloads.download({ url: dataUrl, filename: pending.filename, saveAs: false, conflictAction: "uniquify" }, (id) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const apiError = chrome.runtime.lastError;
            if (apiError) reject(new Error(apiError.message || "完整網頁圖片下載失敗。"));
            else resolve(id);
          });
        } catch (error) {
          if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        }
      });
      return { ok: true, downloadId };
    }
  })().then(sendResponse).catch((error) => {
    console.error(error);
    sendResponse({ ok: false, message: error?.message || String(error) });
  });
  return true;
});
