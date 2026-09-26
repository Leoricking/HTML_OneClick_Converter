importScripts("onenote.js");

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
  const format = options.imageFormat === "jpg" ? "jpeg" : "png";
  const captureOptions = { format };
  if (format === "jpeg") captureOptions.quality = 92;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOptions);
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
  const context = canvas.getContext("2d", { alpha: format !== "jpeg" });
  if (format === "jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, sw, sh);
  }
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const outputBlob = await canvas.convertToBlob({
    type: format === "jpeg" ? "image/jpeg" : "image/png",
    quality: format === "jpeg" ? 0.92 : undefined
  });
  const extension = format === "jpeg" ? "jpg" : "png";
  const title = safeFilename(options.title, tab.title || "selected-region");
  const stamp = timestamp();
  const filename = `${clipFolder(options)}/${title}_${stamp}_選取區域.${extension}`;
  const shouldDownload = options.target !== "onenote" || Boolean(message.forceDownload);
  const shouldCreateOneNote = options.target !== "download" && options.oneNoteMode === "direct" && !message.forceDownload;
  if (shouldDownload) {
    await downloadBlob(outputBlob, filename);
    const metadataBlob = new Blob(["\uFEFF", metadataText(options)], { type: "text/plain;charset=utf-8" });
    await downloadBlob(metadataBlob, `${clipFolder(options)}/${title}_${stamp}_剪藏資訊.txt`);
  }
  if (shouldCreateOneNote) {
    await OneNoteClient.createImagePage(options.oneNoteSectionId, outputBlob, options);
  }
  let clipboardDataUrl = "";
  if (options.target !== "download" && options.oneNoteMode !== "direct" && !message.forceDownload) {
    const clipboardBlob = format === "png"
      ? outputBlob
      : await canvas.convertToBlob({ type: "image/png" });
    clipboardDataUrl = await blobToDataUrl(clipboardBlob);
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
  if (!message || !["clip-selected-html", "clip-selected-region"].includes(message.type)) return false;
  (async () => {
    if (message.type === "clip-selected-html") return saveSelectedHtml(message);
    return saveSelectedRegion(message, sender);
  })().then(sendResponse).catch((error) => {
    console.error(error);
    sendResponse({ ok: false, message: error?.message || String(error) });
  });
  return true;
});
