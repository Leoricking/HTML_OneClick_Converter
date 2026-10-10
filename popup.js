const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const progressEl = $("progress");
const progressBar = $("progress-bar");
const progressText = $("progress-text");
const includeMeta = $("include-meta");
const imageFormatEl = $("image-format");
const copyOneNoteButton = $("copy-onenote-text");
const clipTitleEl = $("clip-title");
const clipModeEl = $("clip-mode");
const clipTargetEl = $("clip-target");
const clipNotebookEl = $("clip-notebook");
const clipTagsEl = $("clip-tags");
const clipNoteEl = $("clip-note");
const clipModeHelpEl = $("clip-mode-help");
const oneNoteSettingsEl = $("onenote-settings");
const oneNoteModeEl = $("onenote-mode");
const oneNoteModeHelpEl = $("onenote-mode-help");
const oneNoteDirectPanelEl = $("onenote-direct-panel");
const oneNoteClientIdEl = $("onenote-client-id");
const oneNoteRedirectUriEl = $("onenote-redirect-uri");
const oneNoteNotebookEl = $("onenote-notebook");
const oneNoteSectionEl = $("onenote-section");
const oneNoteAuthStatusEl = $("onenote-auth-status");

const clipModeHelp = {
  article: "自動找出主要文章，保留圖片、連結與基本排版。",
  simplified: "顯示可選字、可複製、可直接儲存的乾淨閱讀預覽。",
  "full-mhtml": "使用瀏覽器 MHTML 封裝頁面及可取得的圖片、CSS 等資源。",
  "full-html": "保存目前 DOM 快照；外部圖片與樣式仍以原網址連結。",
  bookmark: "保存標題、網址、圖示、標籤與備註的書籤卡片。",
  element: "點一下鎖定元素，再用網頁上方工具列儲存、重新選擇或取消。",
  region: "回到網頁後拖曳選取範圍並輸出 PNG/JPG；Esc 取消。"
};

chrome.storage.local.get({
  includeMeta: true,
  imageFormat: "png",
  clipMode: "article",
  clipTarget: "both",
  oneNoteMode: "clipboard",
  oneNoteClientId: "",
  oneNoteNotebookId: "",
  oneNoteSectionId: "",
  clipNotebook: "未分類",
  clipTags: ""
}).then((settings) => {
  includeMeta.checked = settings.includeMeta;
  imageFormatEl.value = ["png", "jpg"].includes(settings.imageFormat) ? settings.imageFormat : "png";
  clipModeEl.value = Object.hasOwn(clipModeHelp, settings.clipMode) ? settings.clipMode : "article";
  clipTargetEl.value = ["download", "onenote", "both"].includes(settings.clipTarget) ? settings.clipTarget : "both";
  oneNoteModeEl.value = ["clipboard", "direct"].includes(settings.oneNoteMode) ? settings.oneNoteMode : "clipboard";
  oneNoteClientIdEl.value = settings.oneNoteClientId || "";
  oneNoteNotebookEl.dataset.savedValue = settings.oneNoteNotebookId || "";
  oneNoteSectionEl.dataset.savedValue = settings.oneNoteSectionId || "";
  oneNoteRedirectUriEl.value = OneNoteClient.redirectUri();
  clipNotebookEl.value = settings.clipNotebook || "未分類";
  clipTagsEl.value = settings.clipTags || "";
  updateClipModeHelp();
  updateOneNoteUi();
  refreshOneNoteConnection(false).catch(() => {});
});
getActiveTab().then((tab) => { clipTitleEl.value = tab.title || ""; }).catch(() => {});
includeMeta.addEventListener("change", () => {
  chrome.storage.local.set({ includeMeta: includeMeta.checked });
});
imageFormatEl.addEventListener("change", () => {
  chrome.storage.local.set({ imageFormat: imageFormatEl.value });
});
clipModeEl.addEventListener("change", () => {
  chrome.storage.local.set({ clipMode: clipModeEl.value });
  updateClipModeHelp();
  previewCurrentMode(true).then(() => {
    if (clipModeEl.value === "simplified") window.close();
  }).catch(() => {});
});
clipTargetEl.addEventListener("change", () => {
  chrome.storage.local.set({ clipTarget: clipTargetEl.value });
  updateOneNoteUi();
});
oneNoteModeEl.addEventListener("change", () => {
  chrome.storage.local.set({ oneNoteMode: oneNoteModeEl.value });
  updateOneNoteUi();
  if (oneNoteModeEl.value === "direct") refreshOneNoteConnection(false).catch(() => {});
});
oneNoteClientIdEl.addEventListener("change", () => {
  chrome.storage.local.set({ oneNoteClientId: oneNoteClientIdEl.value.trim() });
});
oneNoteNotebookEl.addEventListener("change", () => run(async () => {
  await chrome.storage.local.set({ oneNoteNotebookId: oneNoteNotebookEl.value, oneNoteSectionId: "" });
  oneNoteSectionEl.dataset.savedValue = "";
  await loadOneNoteSections(oneNoteNotebookEl.value);
}));
oneNoteSectionEl.addEventListener("change", () => {
  chrome.storage.local.set({ oneNoteSectionId: oneNoteSectionEl.value });
});
clipNotebookEl.addEventListener("change", () => {
  chrome.storage.local.set({ clipNotebook: clipNotebookEl.value.trim() || "未分類" });
});
clipTagsEl.addEventListener("change", () => {
  chrome.storage.local.set({ clipTags: clipTagsEl.value.trim() });
});

function updateClipModeHelp() {
  clipModeHelpEl.textContent = clipModeHelp[clipModeEl.value] || "";
}

function updateOneNoteUi() {
  const enabled = clipTargetEl.value !== "download";
  oneNoteSettingsEl.classList.toggle("hidden", !enabled);
  const direct = enabled && oneNoteModeEl.value === "direct";
  oneNoteDirectPanelEl.classList.toggle("hidden", !direct);
  oneNoteModeHelpEl.textContent = direct
    ? "登入後直接在指定筆記本／節區建立新頁面。"
    : "剪藏完成後切換到 OneNote，按 Ctrl+V 貼上。";
}

function setOneNoteAuthStatus(message, type = "") {
  oneNoteAuthStatusEl.textContent = message;
  oneNoteAuthStatusEl.className = `auth-status ${type}`.trim();
}

function fillSelect(select, items, placeholder, savedValue = "") {
  select.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = placeholder;
  select.append(first);
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.displayName || "未命名"}${item.isDefault ? "（預設）" : ""}`;
    select.append(option);
  }
  if (savedValue && items.some((item) => item.id === savedValue)) select.value = savedValue;
}

async function loadOneNoteSections(notebookId) {
  if (!notebookId) {
    fillSelect(oneNoteSectionEl, [], "請先選擇筆記本");
    return;
  }
  setOneNoteAuthStatus("正在讀取 OneNote 節區…");
  const sections = await OneNoteClient.listSections(notebookId);
  const saved = oneNoteSectionEl.dataset.savedValue || "";
  fillSelect(oneNoteSectionEl, sections, "選擇要建立頁面的節區", saved);
  if (oneNoteSectionEl.value) await chrome.storage.local.set({ oneNoteSectionId: oneNoteSectionEl.value });
  setOneNoteAuthStatus("已連接 Microsoft OneNote。", "ok");
}

async function refreshOneNoteConnection(forceLoad = true) {
  const status = await OneNoteClient.status();
  if (!status.signedIn) {
    setOneNoteAuthStatus("尚未登入 Microsoft。");
    fillSelect(oneNoteNotebookEl, [], "請先登入 Microsoft");
    fillSelect(oneNoteSectionEl, [], "請先選擇筆記本");
    return false;
  }
  setOneNoteAuthStatus("正在讀取 OneNote 筆記本…");
  const notebooks = await OneNoteClient.listNotebooks();
  const savedNotebook = oneNoteNotebookEl.dataset.savedValue || "";
  fillSelect(oneNoteNotebookEl, notebooks, "選擇 OneNote 筆記本", savedNotebook);
  if (!oneNoteNotebookEl.value) {
    const defaultNotebook = notebooks.find((item) => item.isDefault) || notebooks[0];
    if (defaultNotebook) oneNoteNotebookEl.value = defaultNotebook.id;
  }
  if (oneNoteNotebookEl.value) {
    await chrome.storage.local.set({ oneNoteNotebookId: oneNoteNotebookEl.value });
    await loadOneNoteSections(oneNoteNotebookEl.value);
  } else {
    setOneNoteAuthStatus("帳號內找不到 OneNote 筆記本。", "error");
  }
  return true;
}

$("copy-redirect-uri").addEventListener("click", () => run(async () => {
  await navigator.clipboard.writeText(oneNoteRedirectUriEl.value);
  setStatus("Redirect URI 已複製。", "ok");
}));
$("onenote-sign-in").addEventListener("click", () => run(async () => {
  const clientId = oneNoteClientIdEl.value.trim();
  await chrome.storage.local.set({ oneNoteClientId: clientId });
  setOneNoteAuthStatus("正在開啟 Microsoft 登入…");
  await OneNoteClient.signIn(clientId);
  setOneNoteAuthStatus("登入成功，正在讀取筆記本…", "ok");
  await refreshOneNoteConnection(true);
  setStatus("Microsoft OneNote 已連接。", "ok");
}));
$("onenote-refresh").addEventListener("click", () => run(async () => {
  await refreshOneNoteConnection(true);
  setStatus("OneNote 筆記本與節區已重新整理。", "ok");
}));
$("onenote-sign-out").addEventListener("click", () => run(async () => {
  await OneNoteClient.signOut();
  await refreshOneNoteConnection(false);
  setStatus("已清除本機 Microsoft 登入權杖。", "ok");
}));

function setBusy(busy) {
  document.querySelectorAll("button, input, select, textarea").forEach((control) => {
    control.disabled = busy;
  });
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
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "full-capture-progress-update") return;
  if (message.progress) setProgress(message.progress.done, message.progress.total, message.progress.message);
  if (message.status) setStatus(message.status, message.statusType || "");
});
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
  const tabs = await callExtensionApi(
    (callback) => chrome.tabs.query({ active: true, currentWindow: true }, callback),
    "讀取目前分頁",
    10000
  );
  const [tab] = tabs || [];
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
function callExtensionApi(invoke, label, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`${label}逾時。請重新開啟擴充功能後再試。`)), timeoutMs);
    const callback = (value) => {
      const apiError = chrome.runtime?.lastError;
      if (apiError) finish(reject, new Error(apiError.message || `${label}失敗。`));
      else finish(resolve, value);
    };
    try {
      const result = invoke(callback);
      if (result && typeof result.then === "function") result.then((value) => finish(resolve, value), (error) => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}
async function captureVisibleTabCompat(windowId, options) {
  if (!Number.isInteger(windowId)) throw new Error("無法確認目前分頁所在的瀏覽器視窗。");
  let dataUrl;
  try {
    dataUrl = await callExtensionApi(
      (callback) => chrome.tabs.captureVisibleTab(windowId, options, callback),
      "瀏覽器截圖",
      25000
    );
  } catch (error) {
    const message = error?.message || String(error);
    if (/permission|activeTab|host permission|許可權|權限/i.test(message)) {
      throw new Error("瀏覽器沒有授予此分頁截圖權限。請關閉擴充功能面板，再點工具列圖示重新開啟後截圖。");
    }
    throw new Error(`目前畫面截圖失敗：${message}`);
  }
  if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) {
    throw new Error("瀏覽器沒有回傳有效的截圖資料；請確認 ChatGPT 分頁仍在前景後重試。");
  }
  return dataUrl;
}
async function downloadDataUrl(dataUrl, filename) {
  await callExtensionApi((callback) => chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  }, callback), "截圖下載", 25000);
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
async function saveBlobFile(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}
async function saveHtmlFile(html, filename) {
  const blob = new Blob(["\uFEFF", html], { type: "text/html;charset=utf-8" });
  await saveBlobFile(blob, filename);
}
function clipFolder(options) {
  return `HTML網頁剪藏/${safeFilename(options.notebook, "未分類")}`;
}
function getClipOptions(tab) {
  const tags = clipTagsEl.value.split(/[,，;；\n]+/).map((tag) => tag.trim()).filter(Boolean);
  const selectedNotebook = oneNoteNotebookEl.selectedOptions?.[0];
  const selectedSection = oneNoteSectionEl.selectedOptions?.[0];
  return {
    title: clipTitleEl.value.trim() || tab.title || "webpage",
    notebook: clipNotebookEl.value.trim() || "未分類",
    tags,
    note: clipNoteEl.value.trim(),
    target: ["download", "onenote", "both"].includes(clipTargetEl.value) ? clipTargetEl.value : "both",
    oneNoteMode: oneNoteModeEl.value === "direct" ? "direct" : "clipboard",
    oneNoteNotebookId: oneNoteNotebookEl.value || "",
    oneNoteNotebookName: selectedNotebook?.value ? selectedNotebook.textContent.replace(/（預設）$/, "") : "",
    oneNoteSectionId: oneNoteSectionEl.value || "",
    oneNoteSectionName: selectedSection?.value ? selectedSection.textContent : "",
    url: tab.url || "",
    favicon: tab.favIconUrl || "",
    imageFormat: imageFormatEl.value === "jpg" ? "jpg" : "png"
  };
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
  return copyHtmlForOneNote(html, text);
}
function htmlToPlainText(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  return (parsed.body?.innerText || parsed.body?.textContent || "").trim();
}
async function copyHtmlForOneNote(html, plainText = "") {
  const text = plainText || htmlToPlainText(html);
  if (!window.ClipboardItem || !navigator.clipboard?.write) return false;
  try {
    const item = new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" })
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}
async function deliverHtmlToOneNote(html, options, plainText = "") {
  if (options.oneNoteMode === "direct") {
    if (!options.oneNoteSectionId) throw new Error("請先登入 Microsoft 並選擇 OneNote 筆記本與節區。");
    const page = await OneNoteClient.createHtmlPage(options.oneNoteSectionId, html, options.title);
    return { mode: "direct", page };
  }
  const richCopied = await copyHtmlForOneNote(html, plainText);
  if (!richCopied) await navigator.clipboard.writeText(plainText || htmlToPlainText(html));
  return { mode: "clipboard" };
}
function clipCompletionMessage(label, downloaded, delivery) {
  if (delivery?.mode === "direct") {
    const destination = delivery.sectionName ? `「${delivery.sectionName}」` : "指定節區";
    return downloaded ? `${label}已下載，並在 OneNote ${destination}建立新頁面。` : `${label}已在 OneNote ${destination}建立新頁面。`;
  }
  if (downloaded && delivery?.mode === "clipboard") return `${label}已下載並複製；請到 OneNote 按 Ctrl+V。`;
  if (delivery?.mode === "clipboard") return `${label}已複製；請到 OneNote 按 Ctrl+V。`;
  return `${label}已下載。`;
}

function buildBookmarkHtml(options) {
  const tags = options.tags.length
    ? options.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")
    : '<span class="muted">無標籤</span>';
  const favicon = options.favicon
    ? `<img class="favicon" src="${escapeHtml(options.favicon)}" alt="">`
    : '<div class="favicon placeholder">🔖</div>';
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)}</title><style>
body{margin:0;padding:40px;background:#f3f5f7;color:#172033;font:16px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif}
.card{max-width:760px;margin:auto;padding:30px;border:1px solid #dfe4ea;border-radius:18px;background:#fff;box-shadow:0 12px 36px #18223018}
.head{display:flex;gap:16px;align-items:center}.favicon{width:52px;height:52px;object-fit:contain;border-radius:10px}.placeholder{display:grid;place-items:center;background:#eef2f6;font-size:28px}
h1{margin:0;font-size:26px;line-height:1.3}a{color:#1769aa;word-break:break-all}.meta{margin-top:22px;padding-top:18px;border-top:1px solid #e6e9ee}.label{color:#697386;font-size:13px}.tag{display:inline-block;margin:4px 6px 0 0;padding:3px 9px;border-radius:999px;background:#e8f7ed;color:#087a2d;font-size:13px}.note{margin-top:18px;padding:14px;border-left:4px solid #00a82d;background:#f6fbf7;white-space:pre-wrap}.muted{color:#8a94a5}
</style></head><body><article class="card"><div class="head">${favicon}<div><h1>${escapeHtml(options.title)}</h1><a href="${escapeHtml(options.url)}">${escapeHtml(options.url)}</a></div></div>
<div class="meta"><div><span class="label">下載分類：</span>${escapeHtml(options.notebook)}</div>${options.oneNoteMode === "direct" && options.oneNoteSectionName ? `<div><span class="label">OneNote：</span>${escapeHtml(options.oneNoteNotebookName)} / ${escapeHtml(options.oneNoteSectionName)}</div>` : ""}<div><span class="label">標籤：</span>${tags}</div><div><span class="label">剪藏時間：</span>${escapeHtml(new Date().toLocaleString("zh-TW", { hour12: false }))}</div></div>
${options.note ? `<div class="note">${escapeHtml(options.note)}</div>` : ""}</article></body></html>`;
}

function buildClipSidecar(options) {
  return [
    `標題：${options.title}`,
    `網址：${options.url}`,
    `下載分類：${options.notebook}`,
    `OneNote 位置：${options.oneNoteNotebookName && options.oneNoteSectionName ? `${options.oneNoteNotebookName} / ${options.oneNoteSectionName}` : "剪貼簿模式"}`,
    `標籤：${options.tags.join(", ")}`,
    `剪藏時間：${new Date().toLocaleString("zh-TW", { hour12: false })}`,
    "",
    "備註：",
    options.note || ""
  ].join("\r\n");
}

function savePageAsMhtml(tabId) {
  return new Promise((resolve, reject) => {
    chrome.pageCapture.saveAsMHTML({ tabId }, (blob) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!blob) reject(new Error("瀏覽器沒有回傳 MHTML 內容。"));
      else resolve(blob);
    });
  });
}

async function extractWebClip(tab, mode, options) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [mode, options],
    func: (requestedMode, clipOptions) => {
      const escape = (value) => String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
      const absolute = (value) => {
        try { return new URL(value, location.href).href; } catch { return value; }
      };
      const normalizeTree = (root, simplified = false) => {
        root.querySelectorAll("script,noscript,iframe,object,embed,form").forEach((node) => node.remove());
        for (const el of [root, ...root.querySelectorAll("*")]) {
          for (const attr of [...el.attributes]) {
            if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
          }
          for (const name of ["href", "src", "poster"]) {
            const value = el.getAttribute?.(name);
            if (value && !/^(data:|blob:|javascript:|#)/i.test(value)) el.setAttribute(name, absolute(value));
          }
          if (el.tagName === "IMG") {
            const lazy = el.getAttribute("data-src") || el.getAttribute("data-original") || el.getAttribute("data-lazy-src");
            if (lazy && (!el.getAttribute("src") || /^data:image\/(gif|svg\+xml)/i.test(el.getAttribute("src")))) {
              el.setAttribute("src", absolute(lazy));
            }
            el.setAttribute("loading", "eager");
          }
          if (simplified) {
            ["class", "id", "style", "width", "height", "hidden"].forEach((name) => el.removeAttribute?.(name));
          }
        }
        return root;
      };
      const findArticle = () => {
        const selectors = [
          "article", "main", '[role="main"]', '[itemprop="articleBody"]',
          ".article", ".article-content", ".entry-content", ".post-content", ".post",
          ".content", "#content", "#main-content"
        ];
        const candidates = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
          .filter((el) => (el.innerText || "").trim().length >= 80);
        if (!candidates.length) return document.body;
        candidates.sort((a, b) => {
          const score = (el) => (el.innerText || "").trim().length + el.querySelectorAll("img,table,figure").length * 220;
          return score(b) - score(a);
        });
        return candidates[0];
      };
      const metaBlock = () => {
        const tags = (clipOptions.tags || []).map((tag) => `<span class="clip-tag">${escape(tag)}</span>`).join("");
        const oneNoteDestination = clipOptions.oneNoteMode === "direct" && clipOptions.oneNoteSectionName
          ? `<div><b>OneNote：</b>${escape(clipOptions.oneNoteNotebookName)} / ${escape(clipOptions.oneNoteSectionName)}</div>` : "";
        return `<aside class="clip-meta"><div><b>來源：</b><a href="${escape(location.href)}">${escape(location.href)}</a></div><div><b>下載分類：</b>${escape(clipOptions.notebook)}</div>${oneNoteDestination}<div><b>標籤：</b>${tags || "無"}</div><div><b>剪藏時間：</b>${escape(new Date().toLocaleString("zh-TW", { hour12: false }))}</div>${clipOptions.note ? `<div class="clip-note"><b>備註：</b><br>${escape(clipOptions.note).replace(/\n/g, "<br>")}</div>` : ""}</aside>`;
      };
      const commonCss = `
html{background:#eef1f4}body{max-width:920px;margin:0 auto;padding:36px;background:#fff;color:#20242a;font:17px/1.75 system-ui,-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{line-height:1.35;color:#15181d}img,video{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse;display:block;overflow:auto}th,td{padding:8px;border:1px solid #dfe3e8}a{color:#1769aa}blockquote{margin:1em 0;padding:.6em 1em;border-left:4px solid #00a82d;background:#f6f8f7}pre{padding:14px;overflow:auto;background:#f3f5f7;border-radius:8px}.clip-meta{margin:0 0 28px;padding:16px;border:1px solid #dce3df;border-left:5px solid #00a82d;border-radius:9px;background:#f7fbf8;font-size:14px}.clip-meta>div{margin:4px 0}.clip-tag{display:inline-block;margin:2px 5px 2px 0;padding:2px 8px;border-radius:999px;background:#e3f6e8;color:#087a2d}.clip-note{margin-top:10px;padding-top:10px;border-top:1px solid #dce3df}`;

      if (requestedMode === "full-html") {
        const clone = document.documentElement.cloneNode(true);
        normalizeTree(clone, false);
        clone.querySelectorAll('meta[http-equiv="Content-Security-Policy"],base').forEach((node) => node.remove());
        const head = clone.querySelector("head") || clone.insertBefore(document.createElement("head"), clone.firstChild);
        const base = document.createElement("base");
        base.href = location.href;
        head.prepend(base);
        const marker = document.createElement("div");
        marker.innerHTML = metaBlock();
        clone.querySelector("body")?.prepend(marker.firstElementChild);
        return { html: `<!doctype html>\n${clone.outerHTML}`, detectedTitle: document.title };
      }

      const source = findArticle();
      const clone = source.cloneNode(true);
      const simplified = requestedMode === "simplified";
      normalizeTree(clone, simplified);
      if (simplified) {
        clone.querySelectorAll("nav,aside,footer,button,[role='navigation'],[aria-hidden='true']").forEach((node) => node.remove());
      }
      const bodyClass = simplified ? "simplified" : "article";
      const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${escape(location.href)}"><title>${escape(clipOptions.title || document.title)}</title><style>${commonCss}${simplified ? ".simplified{font-family:Georgia,'Noto Serif TC','Microsoft JhengHei',serif}.simplified p{margin:1.05em 0}" : ""}</style></head><body class="${bodyClass}">${metaBlock()}<main>${clone.outerHTML}</main></body></html>`;
      return { html, detectedTitle: document.title };
    }
  });
  if (!result?.html) throw new Error("無法從此頁面建立剪藏內容。");
  return result;
}

async function previewCurrentMode(silent = false) {
  const tab = await getActiveTab();
  await ensurePageAccess(tab);
  const mode = clipModeEl.value;
  const options = getClipOptions(tab);
  if (mode === "element") {
    await startElementSelection(tab, options);
    if (!silent) setStatus("請在網頁點選元素；鎖定後使用網頁上方的「儲存剪藏」。", "ok");
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [mode, options],
    func: (requestedMode, clipOptions) => {
      const previous = document.getElementById("__html_converter_clip_preview__");
      if (previous?._cleanup) previous._cleanup();
      previous?.remove();

      const host = document.createElement("div");
      host.id = "__html_converter_clip_preview__";
      Object.assign(host.style, { all: "initial", position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: requestedMode === "simplified" ? "auto" : "none", userSelect: "text", webkitUserSelect: "text" });
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>
        *{box-sizing:border-box}.frame{position:fixed;border:4px solid #315efb;border-radius:10px;box-shadow:0 0 0 9999px #0b16382e;pointer-events:none;transition:all .12s}
        .bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);padding:10px 12px;border-radius:10px;background:#172033;color:white;font:600 14px/1.35 system-ui,"Microsoft JhengHei",sans-serif;box-shadow:0 8px 28px #0006;pointer-events:auto}
        .bar small{font-weight:400;color:#d7dfed}.bar button{border:0;border-radius:7px;background:#fff;color:#172033;padding:6px 10px;cursor:pointer;font-weight:700}
        .card{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(620px,calc(100vw - 60px));padding:24px;border:4px solid #315efb;border-radius:16px;background:white;color:#172033;box-shadow:0 0 0 9999px #0b163852,0 18px 60px #0006;font:15px/1.55 system-ui,"Microsoft JhengHei",sans-serif;pointer-events:none}
        .card h3{margin:0 0 9px;font-size:23px}.card a{color:#1769aa;overflow-wrap:anywhere}.card .meta{margin-top:14px;color:#667085;font-size:13px}.region{position:fixed;left:12vw;top:22vh;width:55vw;height:48vh;border:4px dashed #315efb;border-radius:10px;background:#315efb12;box-shadow:0 0 0 9999px #0b16382e}
        .reader{position:fixed;inset:18px 7vw;display:flex;flex-direction:column;border:1px solid #d7dfeb;border-radius:14px;background:#f4f6f9;color:#20242a;box-shadow:0 0 0 9999px #0b16386b,0 18px 70px #0008;pointer-events:auto;overflow:hidden;font-family:system-ui,"Microsoft JhengHei",sans-serif}
        .reader-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;background:#172033;color:#fff}.reader-toolbar .reader-title{min-width:220px;flex:1;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.reader-toolbar button{border:0;border-radius:7px;padding:7px 11px;background:#fff;color:#172033;cursor:pointer;font-weight:700;white-space:nowrap}.reader-toolbar button.primary{background:#315efb;color:#fff}.reader-toolbar button.full{background:#0e9f6e;color:#fff}.reader-status{padding:6px 16px;background:#e8edff;color:#2448c9;font-size:12px;min-height:29px}
        .reader-scroll{flex:1;overflow:auto;padding:28px;user-select:text;-webkit-user-select:text}.reader-article{max-width:850px;margin:0 auto;padding:32px 42px;background:#fff;border-radius:10px;box-shadow:0 2px 12px #17203314;font:18px/1.8 Georgia,"Noto Serif TC","Microsoft JhengHei",serif;user-select:text !important;-webkit-user-select:text !important;cursor:text;overflow-wrap:anywhere}.reader-article::selection,.reader-article *::selection{background:#b8cbff;color:#10182a}.reader-article img,.reader-article video{max-width:100%;height:auto}.reader-article table{max-width:100%;display:block;overflow:auto;border-collapse:collapse}.reader-article th,.reader-article td{border:1px solid #dfe3e8;padding:7px}.reader-article a{color:#1769aa}.reader-article pre{overflow:auto;background:#f3f5f7;padding:12px}.reader-article button,.reader-article form{display:none}
      </style><div class="frame"></div><div class="bar"><div class="message"></div><button type="button">關閉預覽</button></div><div class="content"></div>`;
      const frame = shadow.querySelector(".frame");
      const message = shadow.querySelector(".message");
      const content = shadow.querySelector(".content");
      let target = null;
      let hoverHandler = null;

      const findArticle = () => {
        const selectors = ["article", "main", '[role="main"]', '[itemprop="articleBody"]', ".article", ".article-content", ".entry-content", ".post-content", ".post", ".content", "#content", "#main-content"];
        const candidates = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
          .filter((el) => (el.innerText || "").trim().length >= 80);
        candidates.sort((a, b) => ((b.innerText || "").length + b.querySelectorAll("img,table,figure").length * 220) - ((a.innerText || "").length + a.querySelectorAll("img,table,figure").length * 220));
        return candidates[0] || document.body;
      };
      const paint = () => {
        if (!target?.isConnected) return;
        const rect = target.getBoundingClientRect();
        Object.assign(frame.style, {
          display: "block", left: `${Math.max(3, rect.left)}px`, top: `${Math.max(3, rect.top)}px`,
          width: `${Math.max(8, Math.min(innerWidth - Math.max(3, rect.left) - 3, rect.width))}px`,
          height: `${Math.max(8, Math.min(innerHeight - Math.max(3, rect.top) - 3, rect.height))}px`
        });
      };
      const cleanup = () => {
        if (hoverHandler) document.removeEventListener("mousemove", hoverHandler, true);
        window.removeEventListener("scroll", paint, true);
        window.removeEventListener("resize", paint, true);
        host.remove();
      };
      host._cleanup = cleanup;
      shadow.querySelector("button").addEventListener("click", cleanup);
      document.documentElement.append(host);

      const labels = {
        article: "整篇文章：藍框是將擷取的主要內容",
        simplified: "簡化文章：藍框內容會移除選單、廣告與多餘樣式",
        "full-mhtml": "完整頁面 MHTML：將封裝整個頁面與可取得的資源",
        "full-html": "完整頁面 HTML：將保存目前整個 DOM 快照",
        bookmark: "書籤卡片：將保存標題、網址、標籤與備註",
        element: "元素選取：移動滑鼠可預覽要剪藏的元素",
        region: "區域截圖：開始剪藏後可拖曳實際截圖範圍"
      };
      message.innerHTML = `${labels[requestedMode] || "剪藏預覽"}<br><small>${clipOptions.title || document.title}</small>`;

      if (requestedMode === "article") {
        target = findArticle();
        paint();
      } else if (requestedMode === "simplified") {
        frame.style.display = "none";
        shadow.querySelector(".bar").style.display = "none";
        const source = findArticle();
        const clone = source.cloneNode(true);
        clone.querySelectorAll("script,noscript,iframe,object,embed,form,nav,aside,footer,button,[role='navigation'],[aria-hidden='true']").forEach((node) => node.remove());
        const absolute = (value) => { try { return new URL(value, location.href).href; } catch { return value; } };
        for (const el of [clone, ...clone.querySelectorAll("*")]) {
          for (const attr of [...el.attributes]) {
            if (/^on/i.test(attr.name) || ["class", "id", "style", "width", "height", "hidden"].includes(attr.name)) el.removeAttribute(attr.name);
          }
          for (const name of ["href", "src", "poster"]) {
            const value = el.getAttribute?.(name);
            if (value && !/^(data:|blob:|javascript:|#)/i.test(value)) el.setAttribute(name, absolute(value));
          }
          if (el.tagName === "IMG") {
            const lazy = el.getAttribute("data-src") || el.getAttribute("data-original") || el.getAttribute("data-lazy-src");
            if (lazy && !el.getAttribute("src")) el.setAttribute("src", absolute(lazy));
            el.setAttribute("loading", "eager");
          }
          if (el.tagName === "A") el.setAttribute("target", "_blank");
        }
        const safe = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const clipHtml = (contentHtml) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><base href="${safe(location.href)}"><title>${safe(clipOptions.title || document.title)}</title><style>body{max-width:900px;margin:auto;padding:36px;color:#20242a;font:18px/1.8 Georgia,'Noto Serif TC','Microsoft JhengHei',serif;overflow-wrap:anywhere}img,video{max-width:100%;height:auto}table{max-width:100%;display:block;overflow:auto;border-collapse:collapse}th,td{border:1px solid #dfe3e8;padding:7px}a{color:#1769aa}pre{overflow:auto;background:#f3f5f7;padding:12px}.meta{margin-bottom:25px;padding:14px;border-left:5px solid #315efb;background:#f4f7ff;font:14px/1.6 system-ui}</style></head><body><aside class="meta"><b>來源：</b><a href="${safe(location.href)}">${safe(location.href)}</a>${clipOptions.note ? `<br><b>備註：</b>${safe(clipOptions.note)}` : ""}</aside>${contentHtml}</body></html>`;
        const reader = document.createElement("section");
        reader.className = "reader";
        reader.innerHTML = `<div class="reader-toolbar"><div class="reader-title">簡化閱讀預覽｜${safe(clipOptions.title || document.title)}</div><button type="button" class="copy">複製選取內容</button><button type="button" class="save primary">儲存選取內容</button><button type="button" class="save-full full">剪藏整篇文章</button><button type="button" class="close">關閉</button></div><div class="reader-status">請先反白選取內容；選取按鈕只處理反白範圍，也可另行剪藏整篇文章。</div><div class="reader-scroll"><article class="reader-article"></article></div>`;
        const readerArticle = reader.querySelector(".reader-article");
        readerArticle.append(clone);
        const readerStatus = reader.querySelector(".reader-status");
        const getSelection = () => {
          const candidates = [typeof shadow.getSelection === "function" ? shadow.getSelection() : null, window.getSelection()];
          const selection = candidates.find((item) => item && item.rangeCount && !item.isCollapsed && item.toString().trim());
          if (!selection) throw new Error("請先在閱讀預覽中反白選取要剪藏的內容。");
          const range = selection.getRangeAt(0);
          const parentOf = (node) => node?.nodeType === 1 ? node : node?.parentElement;
          if (!readerArticle.contains(parentOf(range.startContainer)) || !readerArticle.contains(parentOf(range.endContainer))) throw new Error("請只選取閱讀預覽內的內容。");
          const holder = document.createElement("div");
          holder.append(range.cloneContents());
          return { html: holder.innerHTML, text: selection.toString().trim() };
        };
        const copyHtmlText = async (html, text) => {
          if (window.ClipboardItem && navigator.clipboard?.write) {
            try {
              await navigator.clipboard.write([new window.ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
            } catch {
              await navigator.clipboard.writeText(text);
            }
          } else await navigator.clipboard.writeText(text);
        };
        let rememberedSelection = null;
        const rememberSelection = () => {
          try { rememberedSelection = getSelection(); } catch { rememberedSelection = null; }
        };
        const takeSelection = () => {
          const selected = rememberedSelection;
          rememberedSelection = null;
          return selected || getSelection();
        };
        const copyContent = async () => {
          const selected = takeSelection();
          await copyHtmlText(clipHtml(selected.html), selected.text);
          readerStatus.textContent = "已複製反白選取內容；可到 OneNote 按 Ctrl+V。";
        };
        const saveContent = async (html, text, suffix, button, whole = false) => {
          const wantsDownload = clipOptions.target !== "onenote";
          const wantsOneNote = clipOptions.target !== "download";
          const needsBackground = wantsDownload || (wantsOneNote && clipOptions.oneNoteMode === "direct");
          let response = { ok: true };
          if (needsBackground) response = await chrome.runtime.sendMessage({ type: "clip-selected-html", html, options: clipOptions, suffix });
          if (!response?.ok) throw new Error(response?.message || "內容儲存失敗。");
          if (wantsOneNote && clipOptions.oneNoteMode !== "direct") await copyHtmlText(html, text);
          readerStatus.textContent = response?.oneNoteCreated
            ? (wantsDownload ? `${whole ? "整篇文章" : "選取內容"}已下載，並在 OneNote 建立新頁面。` : `已在 OneNote 建立${whole ? "整篇文章" : "選取內容"}頁面。`)
            : wantsDownload && wantsOneNote ? `${whole ? "整篇文章" : "選取內容"}已下載並複製；請到 OneNote 按 Ctrl+V。`
            : wantsDownload ? `${whole ? "整篇文章" : "選取內容"} HTML 已下載。` : `${whole ? "整篇文章" : "選取內容"}已複製；請到 OneNote 按 Ctrl+V。`;
        };
        const copyButton = reader.querySelector(".copy");
        const saveButtonEl = reader.querySelector(".save");
        copyButton.addEventListener("pointerdown", rememberSelection, true);
        saveButtonEl.addEventListener("pointerdown", rememberSelection, true);
        copyButton.addEventListener("click", () => copyContent().catch((error) => { readerStatus.textContent = error?.message || String(error); }));
        saveButtonEl.addEventListener("click", async (event) => {
          const saveButton = event.currentTarget;
          saveButton.disabled = true;
          saveButton.textContent = "處理中…";
          try {
            const selected = takeSelection();
            await saveContent(clipHtml(selected.html), selected.text, "簡化文章_選取內容", saveButton);
          } catch (error) { readerStatus.textContent = error?.message || String(error); }
          finally { saveButton.disabled = false; saveButton.textContent = "儲存選取內容"; }
        });
        reader.querySelector(".save-full").addEventListener("click", async (event) => {
          const saveButton = event.currentTarget;
          saveButton.disabled = true;
          saveButton.textContent = "處理中…";
          try {
            const text = (clone.innerText || clone.textContent || "").trim();
            await saveContent(clipHtml(clone.outerHTML), text, "簡化文章_整篇", saveButton, true);
          } catch (error) { readerStatus.textContent = error?.message || String(error); }
          finally { saveButton.disabled = false; saveButton.textContent = "剪藏整篇文章"; }
        });
        reader.querySelector(".close").addEventListener("click", cleanup);
        content.append(reader);
      } else if (["full-mhtml", "full-html"].includes(requestedMode)) {
        Object.assign(frame.style, { display: "block", left: "6px", top: "6px", width: "calc(100vw - 12px)", height: "calc(100vh - 12px)" });
      } else if (requestedMode === "bookmark") {
        frame.style.display = "none";
        const card = document.createElement("div");
        card.className = "card";
        const safe = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        card.innerHTML = `<h3>${safe(clipOptions.title || document.title)}</h3><a>${safe(location.href)}</a><div class="meta">下載分類：${safe(clipOptions.notebook || "未分類")}<br>標籤：${safe((clipOptions.tags || []).join(", ") || "無")} ${clipOptions.note ? `<br>備註：${safe(clipOptions.note)}` : ""}</div>`;
        content.append(card);
      } else if (requestedMode === "region") {
        frame.style.display = "none";
        const region = document.createElement("div");
        region.className = "region";
        content.append(region);
      } else if (requestedMode === "element") {
        target = document.body;
        paint();
        hoverHandler = (event) => {
          const found = document.elementFromPoint(event.clientX, event.clientY);
          if (found && found !== host && !host.contains(found)) { target = found; paint(); }
        };
        document.addEventListener("mousemove", hoverHandler, true);
      }
      window.addEventListener("scroll", paint, true);
      window.addEventListener("resize", paint, true);
      setTimeout(cleanup, requestedMode === "simplified" ? 300000 : 45000);
    }
  });
  if (!silent) setStatus("已在原網頁顯示剪藏預覽；可按預覽列的「關閉預覽」。", "ok");
}

$("preview-web-clip").addEventListener("click", () => run(async () => {
  await previewCurrentMode(false);
  if (clipModeEl.value === "simplified") window.close();
}));

async function clearClipPreview(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const preview = document.getElementById("__html_converter_clip_preview__");
      if (preview?._cleanup) preview._cleanup();
      preview?.remove();
    }
  });
}

async function startElementSelection(tab, options) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [options],
    func: (clipOptions) => {
      const preview = document.getElementById("__html_converter_clip_preview__");
      if (preview?._cleanup) preview._cleanup();
      preview?.remove();
      document.getElementById("__html_converter_element_picker__")?.remove();
      const escape = (value) => String(value || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      const absolute = (value) => { try { return new URL(value, location.href).href; } catch { return value; } };
      const showToast = (message, ok) => {
        const toast = document.createElement("div");
        toast.textContent = message;
        Object.assign(toast.style, { position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%)", zIndex: "2147483647", padding: "12px 18px", borderRadius: "8px", color: "white", background: ok ? "#087a2d" : "#bd2c2c", font: "14px system-ui", boxShadow: "0 6px 24px #0005" });
        document.documentElement.append(toast);
        setTimeout(() => toast.remove(), 3500);
      };
      const overlay = document.createElement("div");
      overlay.id = "__html_converter_element_picker__";
      Object.assign(overlay.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483646", border: "3px solid #00a82d", background: "#00a82d18", boxSizing: "border-box", display: "none" });
      const hint = document.createElement("div");
      Object.assign(hint.style, { position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", zIndex: "2147483647", padding: "10px 14px", borderRadius: "10px", color: "white", background: "#172033", font: "14px system-ui", boxShadow: "0 8px 30px #0006", pointerEvents: "auto", display: "flex", alignItems: "center", gap: "10px", maxWidth: "calc(100vw - 24px)" });
      document.documentElement.append(overlay, hint);
      let current = null;
      let locked = false;
      const cleanup = () => { overlay.remove(); hint.remove(); document.removeEventListener("mousemove", move, true); document.removeEventListener("click", choose, true); document.removeEventListener("keydown", key, true); };
      const button = (label, background = "#fff", color = "#172033") => {
        const item = document.createElement("button");
        item.type = "button";
        item.textContent = label;
        Object.assign(item.style, { border: "0", borderRadius: "7px", padding: "7px 11px", background, color, font: "700 13px system-ui", cursor: "pointer", whiteSpace: "nowrap" });
        return item;
      };
      const renderSeeking = () => {
        hint.replaceChildren();
        const text = document.createElement("span");
        text.textContent = "移動滑鼠預覽，點一下鎖定元素；↑ 擴大／↓ 縮小；Esc 取消";
        const cancel = button("取消", "#dfe5ef");
        cancel.addEventListener("click", (event) => { event.stopPropagation(); cleanup(); });
        hint.append(text, cancel);
      };
      const paint = (target) => {
        if (!target) return;
        current = target;
        const rect = target.getBoundingClientRect();
        Object.assign(overlay.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      };
      const move = (event) => {
        if (locked || hint.contains(event.target)) return;
        const target = document.elementFromPoint(event.clientX, event.clientY);
        if (!target || target === overlay || target === hint) return;
        paint(target);
      };
      const key = (event) => {
        if (event.key === "Escape") { cleanup(); showToast("已取消元素剪藏。", false); return; }
        if (event.key === "ArrowUp" && current?.parentElement && current.parentElement !== document.documentElement) {
          event.preventDefault(); paint(current.parentElement);
        } else if (event.key === "ArrowDown" && current?.children?.length) {
          event.preventDefault();
          const children = [...current.children].filter((child) => child.getBoundingClientRect().width > 0 && child.getBoundingClientRect().height > 0);
          children.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length);
          paint(children[0]);
        }
      };
      const buildSelectedHtml = (selected) => {
        const clone = selected.cloneNode(true);
        clone.querySelectorAll("script,noscript,iframe,object,embed,form").forEach((node) => node.remove());
        for (const el of [clone, ...clone.querySelectorAll("*")]) {
          for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
          for (const name of ["href", "src", "poster"]) {
            const value = el.getAttribute?.(name);
            if (value && !/^(data:|blob:|javascript:|#)/i.test(value)) el.setAttribute(name, absolute(value));
          }
          if (el.tagName === "IMG") el.setAttribute("loading", "eager");
        }
        const tags = (clipOptions.tags || []).map((tag) => `<span class="tag">${escape(tag)}</span>`).join("") || "無";
        const directDestination = clipOptions.oneNoteMode === "direct" && clipOptions.oneNoteSectionName
          ? `<br><b>OneNote：</b>${escape(clipOptions.oneNoteNotebookName)} / ${escape(clipOptions.oneNoteSectionName)}` : "";
        return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${escape(location.href)}"><title>${escape(clipOptions.title)}</title><style>body{max-width:960px;margin:auto;padding:32px;color:#20242a;font:16px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif}img,video{max-width:100%;height:auto}a{color:#1769aa}.meta{margin-bottom:24px;padding:14px;border-left:5px solid #315efb;background:#f4f7ff}.tag{display:inline-block;margin-right:5px;padding:2px 8px;border-radius:999px;background:#e7edff;color:#2448c9}</style></head><body><aside class="meta"><b>來源：</b><a href="${escape(location.href)}">${escape(location.href)}</a><br><b>下載分類：</b>${escape(clipOptions.notebook)}${directDestination}<br><b>標籤：</b>${tags}${clipOptions.note ? `<br><b>備註：</b>${escape(clipOptions.note)}` : ""}</aside>${clone.outerHTML}</body></html>`;
      };
      const saveSelected = async () => {
        if (!current) return;
        const selected = current;
        const html = buildSelectedHtml(selected);
        try {
          const wantsDownload = clipOptions.target !== "onenote";
          const wantsOneNote = clipOptions.target !== "download";
          let response = { ok: true };
          const needsBackground = wantsDownload || (wantsOneNote && clipOptions.oneNoteMode === "direct");
          if (needsBackground) response = await chrome.runtime.sendMessage({ type: "clip-selected-html", html, options: clipOptions, suffix: "選取元素" });
          if (!response?.ok) throw new Error(response?.message || "元素儲存失敗。");
          let copied = false;
          if (wantsOneNote && clipOptions.oneNoteMode !== "direct") {
            const text = (selected.innerText || selected.textContent || "").trim();
            if (window.ClipboardItem && navigator.clipboard?.write) {
              await navigator.clipboard.write([new ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([text], { type: "text/plain" })
              })]);
            } else await navigator.clipboard.writeText(text);
            copied = true;
          }
          const message = response?.oneNoteCreated
            ? (wantsDownload ? "選取元素已下載，並在 OneNote 建立新頁面。" : "選取元素已在 OneNote 建立新頁面。")
            : wantsDownload && copied ? "選取元素已下載並複製；請到 OneNote 按 Ctrl+V。"
            : copied ? "選取元素已複製；請到 OneNote 按 Ctrl+V。" : response.message;
          cleanup();
          showToast(message || "元素剪藏完成。", true);
        } catch (error) { showToast(error?.message || String(error), false); }
      };
      const renderLocked = () => {
        hint.replaceChildren();
        const text = document.createElement("span");
        text.innerHTML = `<b>元素已鎖定</b><br><small>選取框會保留，直接在這裡儲存，不必重開套件。</small>`;
        const save = button("儲存剪藏", "#315efb", "#fff");
        const again = button("重新選擇");
        const cancel = button("取消", "#dfe5ef");
        save.addEventListener("click", (event) => { event.stopPropagation(); save.disabled = true; save.textContent = "處理中…"; saveSelected().finally(() => { save.disabled = false; save.textContent = "儲存剪藏"; }); });
        again.addEventListener("click", (event) => { event.stopPropagation(); locked = false; current = null; overlay.style.display = "none"; renderSeeking(); });
        cancel.addEventListener("click", (event) => { event.stopPropagation(); cleanup(); });
        hint.append(text, save, again, cancel);
      };
      const choose = (event) => {
        if (hint.contains(event.target) || locked) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        if (!current) return;
        locked = true;
        renderLocked();
      };
      renderSeeking();
      document.addEventListener("mousemove", move, true);
      document.addEventListener("click", choose, true);
      document.addEventListener("keydown", key, true);
    }
  });
}

async function startRegionSelection(tab, options) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [options],
    func: (clipOptions) => {
      document.getElementById("__html_converter_region_picker__")?.remove();
      const showToast = (message, ok) => {
        const toast = document.createElement("div");
        toast.textContent = message;
        Object.assign(toast.style, { position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%)", zIndex: "2147483647", padding: "12px 18px", borderRadius: "8px", color: "white", background: ok ? "#087a2d" : "#bd2c2c", font: "14px system-ui", boxShadow: "0 6px 24px #0005" });
        document.documentElement.append(toast);
        setTimeout(() => toast.remove(), 3500);
      };
      const layer = document.createElement("div");
      layer.id = "__html_converter_region_picker__";
      Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "2147483646", cursor: "crosshair", background: "#0002", touchAction: "none" });
      const box = document.createElement("div");
      Object.assign(box.style, { position: "absolute", display: "none", border: "3px solid #00a82d", background: "#00a82d18", boxSizing: "border-box" });
      const hint = document.createElement("div");
      hint.textContent = "拖曳選取截圖區域；按 Esc 取消";
      Object.assign(hint.style, { position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)", padding: "10px 16px", borderRadius: "8px", color: "white", background: "#00a82d", font: "14px system-ui", boxShadow: "0 6px 24px #0005", pointerEvents: "none" });
      layer.append(box, hint);
      document.documentElement.append(layer);
      let start = null;
      const cleanup = () => { layer.remove(); document.removeEventListener("keydown", key, true); };
      const key = (event) => { if (event.key === "Escape") { cleanup(); showToast("已取消區域截圖。", false); } };
      const update = (event) => {
        if (!start) return;
        const x = Math.min(start.x, event.clientX), y = Math.min(start.y, event.clientY);
        const width = Math.abs(event.clientX - start.x), height = Math.abs(event.clientY - start.y);
        Object.assign(box.style, { display: "block", left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
      };
      layer.addEventListener("pointerdown", (event) => { start = { x: event.clientX, y: event.clientY }; layer.setPointerCapture(event.pointerId); update(event); });
      layer.addEventListener("pointermove", update);
      layer.addEventListener("pointerup", async (event) => {
        if (!start) return;
        const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) };
        start = null;
        if (rect.width < 8 || rect.height < 8) { box.style.display = "none"; return; }
        cleanup();
        await new Promise((resolve) => setTimeout(resolve, 180));
        try {
          const response = await chrome.runtime.sendMessage({ type: "clip-selected-region", rect, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, options: clipOptions });
          if (!response?.ok) throw new Error(response?.message || "區域截圖失敗。");
          let copied = false;
          if (clipOptions.target !== "download" && response.clipboardDataUrl) {
            try {
              const imageBlob = await (await fetch(response.clipboardDataUrl)).blob();
              await navigator.clipboard.write([new ClipboardItem({ "image/png": imageBlob })]);
              copied = true;
            } catch (clipboardError) {
              if (clipOptions.target === "onenote") {
                const fallback = await chrome.runtime.sendMessage({ type: "clip-selected-region", rect, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, options: clipOptions, forceDownload: true });
                showToast(fallback?.ok ? "瀏覽器無法複製圖片，已改為下載 PNG/JPG。" : (clipboardError?.message || String(clipboardError)), Boolean(fallback?.ok));
                return;
              }
              showToast("圖片已下載，但瀏覽器拒絕寫入圖片剪貼簿。", false);
              return;
            }
          }
          const downloaded = clipOptions.target !== "onenote";
          const message = downloaded && copied
            ? "區域截圖已下載並複製；請到 OneNote 按 Ctrl+V。"
            : copied ? "區域截圖已複製；請到 OneNote 按 Ctrl+V。" : response.message;
          showToast(message || "區域截圖完成。", true);
        } catch (error) { showToast(error?.message || String(error), false); }
      });
      document.addEventListener("keydown", key, true);
    }
  });
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

$("save-web-clip").addEventListener("click", () => run(async () => {
  const tab = await getActiveTab();
  await ensurePageAccess(tab);
  const mode = clipModeEl.value;
  const options = getClipOptions(tab);
  const wantsDownload = options.target !== "onenote";
  const wantsOneNote = options.target !== "download";
  const folder = clipFolder(options);
  const baseName = `${folder}/${safeFilename(options.title)}_${timestamp()}`;
  await clearClipPreview(tab);
  if (wantsOneNote && options.oneNoteMode === "direct") {
    if (!options.oneNoteSectionId) throw new Error("請先登入 Microsoft 並選擇 OneNote 筆記本與節區。");
    await OneNoteClient.getAccessToken();
  }

  if (mode === "element") {
    setStatus("元素選取模式已啟動，請回到網頁點選內容；Esc 可取消。", "ok");
    await startElementSelection(tab, options);
    return;
  }
  if (mode === "region") {
    setStatus("區域截圖模式已啟動，請回到網頁拖曳選取；Esc 可取消。", "ok");
    await startRegionSelection(tab, options);
    return;
  }
  if (mode === "simplified") {
    setStatus("正在開啟簡化閱讀預覽；請反白選取內容，或選擇剪藏整篇文章。", "ok");
    await previewCurrentMode(false);
    window.close();
    return;
  }
  if (mode === "bookmark") {
    setStatus("正在建立書籤卡片…");
    const html = buildBookmarkHtml(options);
    if (wantsDownload) await saveHtmlFile(html, `${baseName}_書籤.html`);
    const delivery = wantsOneNote
      ? await deliverHtmlToOneNote(html, options, `${options.title}\n${options.url}\n${options.note}`.trim())
      : null;
    if (delivery) delivery.sectionName = options.oneNoteSectionName;
    setStatus(clipCompletionMessage("書籤卡片", wantsDownload, delivery), "ok");
    return;
  }
  if (mode === "full-mhtml") {
    setStatus("正在封裝完整頁面 MHTML…");
    if (wantsDownload) {
      const blob = await savePageAsMhtml(tab.id);
      await saveBlobFile(blob, `${baseName}_完整頁面.mhtml`);
      await saveTextFile(buildClipSidecar(options), `${baseName}_剪藏資訊.txt`);
    }
    let delivery = null;
    if (wantsOneNote) {
      const editableFullPage = await extractWebClip(tab, "full-html", options);
      delivery = await deliverHtmlToOneNote(editableFullPage.html, options);
      delivery.sectionName = options.oneNoteSectionName;
    }
    const label = wantsDownload ? "完整頁面 MHTML（OneNote 使用可編輯完整頁面版）" : "可編輯完整頁面版";
    setStatus(clipCompletionMessage(label, wantsDownload, delivery), "ok");
    return;
  }

  const suffix = mode === "full-html" ? "完整頁面快照" : "整篇文章";
  setStatus(`正在建立${suffix}…`);
  const clip = await extractWebClip(tab, mode, options);
  if (wantsDownload) await saveHtmlFile(clip.html, `${baseName}_${suffix}.html`);
  const delivery = wantsOneNote ? await deliverHtmlToOneNote(clip.html, options) : null;
  if (delivery) delivery.sectionName = options.oneNoteSectionName;
  setStatus(clipCompletionMessage(`${suffix} HTML`, wantsDownload, delivery), "ok");
}));

$("capture-visible").addEventListener("click", () => run(async () => {
  const tab = await getActiveTab();
  const imageOptions = getImageOptions();
  setStatus(`正在擷取目前畫面（${imageOptions.label}）…`);
  const captureOptions = { format: imageOptions.captureFormat };
  if (imageOptions.captureFormat === "jpeg") captureOptions.quality = imageOptions.quality;
  const dataUrl = await captureVisibleTabCompat(tab.windowId, captureOptions);
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
  setStatus("正在連接目前網頁…");
  const tab = await getActiveTab();
  await ensurePageAccess(tab);
  const imageOptions = getImageOptions();
  const jobId = crypto.randomUUID();
  setStatus("正在啟動完整頁面截圖…");
  await callExtensionApi(
    (callback) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture.js"] }, callback),
    "載入截圖程式",
    15000
  );
  const response = await callExtensionApi(
    (callback) => chrome.tabs.sendMessage(tab.id, {
      type: "start-full-page-capture",
      jobId,
      windowId: tab.windowId,
      title: tab.title,
      imageOptions
    }, callback),
    "啟動完整頁面截圖",
    15000
  );
  if (!response?.ok) throw new Error(response?.message || "無法啟動背景完整頁面截圖。");
  setStatus("完整頁面截圖已在網頁背景開始；可關閉此視窗，完成後會自動下載。", "ok");
}));
