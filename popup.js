const $ = (id) => document.getElementById(id);
const buttons = [...document.querySelectorAll("button")];
const statusEl = $("status");
const progressEl = $("progress");
const progressBar = $("progress-bar");
const progressText = $("progress-text");
const includeMeta = $("include-meta");
const imageFormatEl = $("image-format");
const copyOneNoteButton = $("copy-onenote-text");

chrome.storage.local.get({ includeMeta: true, imageFormat: "png" }).then(({ includeMeta: value, imageFormat }) => {
  includeMeta.checked = value;
  imageFormatEl.value = ["png", "jpg"].includes(imageFormat) ? imageFormat : "png";
});
includeMeta.addEventListener("change", () => {
  chrome.storage.local.set({ includeMeta: includeMeta.checked });
});
imageFormatEl.addEventListener("change", () => {
  chrome.storage.local.set({ imageFormat: imageFormatEl.value });
});

function setBusy(busy) {
  buttons.forEach((button) => { button.disabled = busy; });
  imageFormatEl.disabled = busy;
}
function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}
function setProgress(done, total, message) {
  progressEl.classList.remove("hidden");
  const percent = total ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  progressText.textContent = message || `${percent}%`;
}
function hideProgress() {
  progressEl.classList.add("hidden");
  progressBar.style.width = "0%";
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
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function getImageOptions() {
  const uiFormat = imageFormatEl.value === "jpg" ? "jpg" : "png";
  return {
    uiFormat,
    captureFormat: uiFormat === "jpg" ? "jpeg" : "png",
    extension: uiFormat,
    mimeType: uiFormat === "jpg" ? "image/jpeg" : "image/png",
    quality: uiFormat === "jpg" ? 92 : undefined,
    label: uiFormat.toUpperCase()
  };
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到目前分頁。");
  return tab;
}
function isRestrictedUrl(url = "") {
  return /^(chrome|edge|opera|about|devtools|chrome-extension|moz-extension):/i.test(url)
    || /^https?:\/\/chrome\.google\.com\/webstore/i.test(url)
    || /^https?:\/\/microsoftedge\.microsoft\.com\/addons/i.test(url);
}
async function ensurePageAccess(tab) {
  if (isRestrictedUrl(tab.url || "")) {
    throw new Error("瀏覽器系統頁、擴充功能商店及部分受保護頁面無法注入文字擷取腳本。");
  }
}
async function downloadDataUrl(dataUrl, filename) {
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("檔案轉換失敗。"));
    reader.readAsDataURL(blob);
  });
}
async function saveTextFile(text, filename) {
  const blob = new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" });
  const dataUrl = await blobToDataUrl(blob);
  await downloadDataUrl(dataUrl, filename);
}
function withMetadata(data) {
  if (!includeMeta.checked) return data.text.trim();
  return [
    `標題：${data.title || ""}`,
    `網址：${data.url || ""}`,
    `擷取時間：${new Date().toLocaleString("zh-TW", { hour12: false })}`,
    "",
    data.text.trim()
  ].join("\r\n");
}
async function extractText(mode) {
  const tab = await getActiveTab();
  await ensurePageAccess(tab);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [mode],
    func: (requestedMode) => {
      const normalize = (text) => String(text || "")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      let node = document.body;
      if (requestedMode === "main") {
        const candidates = [
          document.querySelector("article"),
          document.querySelector("main"),
          document.querySelector('[role="main"]'),
          document.querySelector(".article"),
          document.querySelector(".post"),
          document.querySelector(".entry-content"),
          document.querySelector(".post-content"),
          document.querySelector("#content")
        ].filter(Boolean);
        if (candidates.length) {
          candidates.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length);
          node = candidates[0];
        }
      }
      return {
        text: normalize(node?.innerText || ""),
        title: document.title,
        url: location.href
      };
    }
  });
  if (!result?.text) throw new Error("此頁面沒有可擷取的文字。");
  return { tab, data: result };
}
function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function textToOneNoteHtml(text) {
  const lines = String(text || "").split(/\r?\n/);
  const body = lines.map((line) => line ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>").join("");
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Calibri, Arial, Microsoft JhengHei, sans-serif;font-size:20pt;line-height:1.45;">${body}</body></html>`;
}
async function copyRichTextForOneNote(text) {
  const html = textToOneNoteHtml(text);
  if (window.ClipboardItem && navigator.clipboard?.write) {
    const item = new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" })
    });
    await navigator.clipboard.write([item]);
    return true;
  }
  return false;
}
async function run(task) {
  setBusy(true);
  setStatus("");
  try {
    await task();
  } catch (error) {
    console.error(error);
    setStatus(error?.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

$("capture-visible").addEventListener("click", () => run(async () => {
  const tab = await getActiveTab();
  const imageOptions = getImageOptions();
  setStatus(`正在擷取目前畫面（${imageOptions.label}）…`);
  const captureOptions = { format: imageOptions.captureFormat };
  if (imageOptions.captureFormat === "jpeg") captureOptions.quality = imageOptions.quality;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOptions);
  const filename = `HTML轉圖片/${safeFilename(tab.title)}_${timestamp()}_目前畫面.${imageOptions.extension}`;
  await downloadDataUrl(dataUrl, filename);
  setStatus(`目前畫面 ${imageOptions.label} 已下載。`, "ok");
}));


$("save-page-pdf").addEventListener("click", () => run(async () => {
  const tab = await getActiveTab();
  await ensurePageAccess(tab);
  setStatus("正在開啟 PDF 列印視窗…");
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.print()
  });
  setStatus("請在列印視窗將目的地設為「另存為 PDF」。", "ok");
}));

$("save-main-text").addEventListener("click", () => run(async () => {
  setStatus("正在擷取主要內容…");
  const { tab, data } = await extractText("main");
  const filename = `HTML轉文字/${safeFilename(tab.title)}_${timestamp()}_主要內容.txt`;
  await saveTextFile(withMetadata(data), filename);
  setStatus("主要內容 TXT 已下載。", "ok");
}));

$("save-all-text").addEventListener("click", () => run(async () => {
  setStatus("正在擷取全部文字…");
  const { tab, data } = await extractText("all");
  const filename = `HTML轉文字/${safeFilename(tab.title)}_${timestamp()}_全部文字.txt`;
  await saveTextFile(withMetadata(data), filename);
  setStatus("全部文字 TXT 已下載。", "ok");
}));

$("copy-main-text").addEventListener("click", () => run(async () => {
  setStatus("正在複製主要內容…");
  const { data } = await extractText("main");
  await navigator.clipboard.writeText(withMetadata(data));
  setStatus("主要內容已複製到剪貼簿。", "ok");
}));

copyOneNoteButton.addEventListener("click", () => run(async () => {
  setStatus("正在複製 OneNote 20pt 文字…");
  const { data } = await extractText("main");
  const text = withMetadata(data);
  const richCopied = await copyRichTextForOneNote(text);
  if (!richCopied) {
    await navigator.clipboard.writeText(text);
    setStatus("瀏覽器不支援 HTML 剪貼簿，已改用一般純文字複製。", "ok");
    return;
  }
  setStatus("OneNote 20pt 內容已複製到剪貼簿。", "ok");
}));

$("capture-full").addEventListener("click", () => run(async () => {
  const tab = await getActiveTab();
  await ensurePageAccess(tab);
  const imageOptions = getImageOptions();
  setStatus(`正在準備完整網頁截圖（${imageOptions.label}）…`);
  setProgress(0, 1, "分析頁面尺寸…");

  const [{ result: info }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const root = document.documentElement;
      const body = document.body;
      const original = {
        x: window.scrollX,
        y: window.scrollY,
        behavior: root.style.scrollBehavior,
        overflow: root.style.overflow
      };
      root.style.scrollBehavior = "auto";
      const width = Math.max(root.scrollWidth, body?.scrollWidth || 0, root.clientWidth);
      const height = Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight);
      window.__htmlConverterCaptureState = { original, hidden: [] };
      window.scrollTo(0, 0);
      return {
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1
      };
    }
  });

  const maxCanvasDimension = 32767;
  const maxCanvasArea = 268435456;
  const outputWidth = Math.round(info.width * info.dpr);
  const outputHeight = Math.round(info.height * info.dpr);
  if (outputWidth > maxCanvasDimension || outputHeight > maxCanvasDimension ||
      outputWidth * outputHeight > maxCanvasArea) {
    await restoreCaptureState(tab.id);
    throw new Error("頁面尺寸過大，超出瀏覽器 Canvas 可輸出的長圖限制。請縮小頁面縮放比例後再試。");
  }

  const steps = [];
  for (let y = 0; y < info.height; y += info.viewportHeight) {
    steps.push(Math.min(y, Math.max(0, info.height - info.viewportHeight)));
  }
  const uniqueSteps = [...new Set(steps)];
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  try {
    for (let i = 0; i < uniqueSteps.length; i++) {
      const y = uniqueSteps[i];
      setProgress(i, uniqueSteps.length, `擷取第 ${i + 1} / ${uniqueSteps.length} 段…`);

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [y, i],
        func: async (targetY, index) => {
          window.scrollTo(0, targetY);
          await new Promise((resolve) => setTimeout(resolve, 350));
          if (index === 1) {
            const state = window.__htmlConverterCaptureState;
            if (state) {
              const nodes = [...document.querySelectorAll("body *")];
              for (const el of nodes) {
                const style = getComputedStyle(el);
                if ((style.position === "fixed" || style.position === "sticky") &&
                    el.offsetWidth > 0 && el.offsetHeight > 0) {
                  state.hidden.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
                  el.style.setProperty("visibility", "hidden", "important");
                }
              }
            }
          }
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 550));
      const captureOptions = { format: imageOptions.captureFormat };
      if (imageOptions.captureFormat === "jpeg") captureOptions.quality = imageOptions.quality;
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOptions);
      const image = await loadImage(dataUrl);
      const sourceCssHeight = image.height / info.dpr;
      const remainingCssHeight = info.height - y;
      const drawCssHeight = Math.min(sourceCssHeight, remainingCssHeight);
      const sourcePixelHeight = Math.round(drawCssHeight * info.dpr);
      ctx.drawImage(
        image,
        0, 0, image.width, sourcePixelHeight,
        0, Math.round(y * info.dpr), outputWidth, sourcePixelHeight
      );
    }

    setProgress(uniqueSteps.length, uniqueSteps.length, `正在產生 ${imageOptions.label}…`);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error(`無法產生完整網頁 ${imageOptions.label}。`)),
        imageOptions.mimeType,
        imageOptions.captureFormat === "jpeg" ? imageOptions.quality / 100 : undefined
      );
    });
    const dataUrl = await blobToDataUrl(blob);
    const filename = `HTML轉圖片/${safeFilename(tab.title)}_${timestamp()}_完整網頁.${imageOptions.extension}`;
    await downloadDataUrl(dataUrl, filename);
    setStatus(`完整網頁 ${imageOptions.label} 已下載，共拼接 ${uniqueSteps.length} 段。`, "ok");
  } finally {
    await restoreCaptureState(tab.id);
    hideProgress();
  }
}));

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("截圖片段載入失敗。"));
    image.src = src;
  });
}
async function restoreCaptureState(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const state = window.__htmlConverterCaptureState;
        if (!state) return;
        for (const item of state.hidden || []) {
          const [el, value, priority] = item;
          if (!el?.style) continue;
          if (value) el.style.setProperty("visibility", value, priority || "");
          else el.style.removeProperty("visibility");
        }
        document.documentElement.style.scrollBehavior = state.original.behavior || "";
        document.documentElement.style.overflow = state.original.overflow || "";
        window.scrollTo(state.original.x || 0, state.original.y || 0);
        delete window.__htmlConverterCaptureState;
      }
    });
  } catch (error) {
    console.warn("還原頁面狀態失敗：", error);
  }
}
