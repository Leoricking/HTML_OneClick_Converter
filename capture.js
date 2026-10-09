(() => {
  if (globalThis.__htmlConverterCaptureListener) return;
  globalThis.__htmlConverterCaptureListener = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sendProgress = (jobId, progress, status, statusType = "") => {
    chrome.runtime.sendMessage({
      type: "full-page-capture-progress",
      jobId,
      progress,
      status,
      statusType
    }).catch(() => {});
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "start-full-page-capture") return false;
    if (globalThis.__htmlConverterCaptureRunning) {
      sendResponse({ ok: false, message: "目前已有一個完整頁面截圖正在執行。" });
      return false;
    }
    globalThis.__htmlConverterCaptureRunning = true;
    sendResponse({ ok: true });
    runFullPageCapture(message)
      .catch((error) => {
        const reason = error?.message || String(error);
        sendProgress(message.jobId, null, `完整頁面截圖失敗：${reason}`, "error");
      })
      .finally(() => { globalThis.__htmlConverterCaptureRunning = false; });
    return false;
  });

  async function runFullPageCapture(job) {
    const { jobId, windowId, title, imageOptions } = job;
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) throw new Error("網頁內容尚未載入完成。");

    const original = {
      x: window.scrollX,
      y: window.scrollY,
      behavior: root.style.scrollBehavior,
      overflow: root.style.overflow
    };
    const hidden = [];
    let activeScroller = null;
    let scrollerOriginal = null;
    let canvas = null;
    try {
      sendProgress(jobId, { done: 0, total: 1, message: "分析頁面尺寸…" }, `正在準備完整網頁截圖（${imageOptions.label}）…`);
      root.style.scrollBehavior = "auto";
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const pageWidth = Math.max(root.scrollWidth, body.scrollWidth || 0, root.clientWidth);
      const pageHeight = Math.max(root.scrollHeight, body.scrollHeight || 0, root.clientHeight);
      const windowRange = Math.max(0, pageHeight - viewportHeight);

      // Detect the main nested scroller used by SPA pages and dashboards.
      let scroller = null;
      let bestScore = 0;
      for (const el of document.querySelectorAll("body *")) {
        const style = getComputedStyle(el);
        // Some SPA dashboards keep the page visually clipped with
        // overflow:hidden and move the content by setting scrollTop from JS.
        // Such containers are still programmatically scrollable, so include
        // them and verify the actual scroll position before every capture.
        if (!/(auto|scroll|overlay|hidden)/.test(style.overflowY)) continue;
        const range = el.scrollHeight - el.clientHeight;
        if (range < 32 || el.clientHeight < viewportHeight * 0.3 || el.clientWidth < viewportWidth * 0.3) continue;
        const rect = el.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
        if (visibleWidth < viewportWidth * 0.25 || visibleHeight < viewportHeight * 0.25) continue;
        const visibleAreaRatio = visibleWidth * visibleHeight / (viewportWidth * viewportHeight);
        const score = range * (0.5 + visibleAreaRatio);
        if (score > bestScore) { bestScore = score; scroller = el; }
      }

      const elementRange = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
      activeScroller = scroller && (windowRange < 32 || elementRange > windowRange * 1.15) ? scroller : null;
      const scrollRange = activeScroller ? elementRange : windowRange;
      const captureStepHeight = activeScroller ? activeScroller.clientHeight : viewportHeight;
      const width = activeScroller ? viewportWidth : pageWidth;
      const height = activeScroller ? viewportHeight + scrollRange : pageHeight;
      scrollerOriginal = activeScroller ? {
        x: activeScroller.scrollLeft,
        y: activeScroller.scrollTop,
        behavior: activeScroller.style.scrollBehavior
      } : null;
      if (activeScroller) {
        activeScroller.style.scrollBehavior = "auto";
        activeScroller.scrollTo(0, 0);
      } else window.scrollTo(0, 0);

      const dpr = window.devicePixelRatio || 1;
      const outputWidth = Math.round(width * dpr);
      const outputHeight = Math.round(height * dpr);
      if (outputWidth > 32767 || outputHeight > 32767 || outputWidth * outputHeight > 268435456) {
        throw new Error("頁面尺寸過大，超出瀏覽器 Canvas 可輸出的長圖限制。請縮小頁面縮放比例後再試。");
      }

      const steps = [];
      for (let y = 0; y <= scrollRange; y += captureStepHeight) steps.push(Math.min(y, scrollRange));
      if (!steps.length || steps.at(-1) !== scrollRange) steps.push(scrollRange);
      const uniqueSteps = [...new Set(steps)];
      const scrollDescription = activeScroller ? "內部捲動區" : "整個頁面";
      sendProgress(jobId, { done: 0, total: uniqueSteps.length, message: `已偵測${scrollDescription}，可捲動 ${Math.round(scrollRange)} px，共 ${uniqueSteps.length} 段…` },
        `已啟動完整頁面截圖：${scrollDescription}，${uniqueSteps.length} 段（${imageOptions.label}）；可關閉擴充功能視窗。`);

      canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("無法建立截圖拼接畫布。");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outputWidth, outputHeight);

      const setScrollY = (value) => activeScroller ? activeScroller.scrollTo(0, value) : window.scrollTo(0, value);
      const getScrollY = () => activeScroller ? activeScroller.scrollTop : window.scrollY;
      const scrollToAndWait = async (value) => {
        const maxY = activeScroller
          ? Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight)
          : Math.max(0, Math.max(root.scrollHeight, body.scrollHeight || 0, root.clientHeight) - viewportHeight);
        const requestedY = Math.max(0, value);
        if (requestedY > maxY + 3) {
          throw new Error(`頁面捲動範圍在擷取途中改變（要求 ${Math.round(requestedY)} px，目前上限 ${Math.round(maxY)} px），為避免輸出不完整圖片，已停止擷取。`);
        }
        const targetY = Math.min(requestedY, maxY);
        if (activeScroller) activeScroller.scrollTo({ top: targetY, behavior: "smooth" });
        else window.scrollTo({ top: targetY, behavior: "smooth" });
        const start = performance.now();
        let settledFrames = 0;
        while (performance.now() - start < 5000) {
          await sleep(50);
          if (Math.abs(getScrollY() - targetY) <= 3) {
            if (++settledFrames >= 3) break;
          } else settledFrames = 0;
        }
        if (Math.abs(getScrollY() - targetY) > 3) {
          throw new Error(`網頁沒有捲動到第 ${Math.round(targetY)} px（目前 ${Math.round(getScrollY())} px），已停止以免重複截取同一畫面。`);
        }
        await sleep(100);
      };
      const isVisible = (el, rect = el.getBoundingClientRect()) => {
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 &&
          rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 &&
          rect.left < viewportWidth && rect.top < viewportHeight;
      };
      const canHide = (el) => !activeScroller || (el !== activeScroller && !el.contains(activeScroller));

      for (let i = 0; i < uniqueSteps.length; i++) {
        const y = uniqueSteps[i];
        sendProgress(jobId, { done: i, total: uniqueSteps.length, message: `擷取第 ${i + 1} / ${uniqueSteps.length} 段…` },
          `正在擷取完整網頁（${imageOptions.label}）…`);
        await scrollToAndWait(y);

        if (i > 0) {
          const nodes = [...document.querySelectorAll("body *")];
          const candidates = new Set();
          for (const el of nodes) {
            const rect = el.getBoundingClientRect();
            if (!isVisible(el, rect)) continue;
            const pos = getComputedStyle(el).position;
            if (canHide(el) && (pos === "fixed" || pos === "sticky")) candidates.add(el);
          }
          const maxScrollY = activeScroller
            ? Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight)
            : Math.max(root.scrollHeight, body.scrollHeight || 0, root.clientHeight) - viewportHeight;
          const baseY = getScrollY();
          const probeY = baseY + 64 <= maxScrollY ? baseY + 64 : Math.max(0, baseY - 64);
          if (Math.abs(probeY - baseY) >= 32) {
            const before = new Map();
            for (const el of nodes) {
              const rect = el.getBoundingClientRect();
              if (isVisible(el, rect)) before.set(el, { top: rect.top, left: rect.left });
            }
            setScrollY(probeY);
            await sleep(120);
            if (Math.abs(getScrollY() - baseY) >= 16) {
              for (const [el, firstRect] of before) {
                if (!el.isConnected) continue;
                const rect = el.getBoundingClientRect();
                if (isVisible(el, rect) && canHide(el) && Math.abs(rect.top - firstRect.top) <= 3 && Math.abs(rect.left - firstRect.left) <= 3) candidates.add(el);
              }
            }
            setScrollY(y);
            await sleep(180);
          }
          for (const el of document.querySelectorAll("body *")) {
            const rect = el.getBoundingClientRect();
            if (isVisible(el, rect) && canHide(el) && ["fixed", "sticky"].includes(getComputedStyle(el).position)) candidates.add(el);
          }
          const outermost = [...candidates].filter((el) => {
            for (let parent = el.parentElement; parent && parent !== body; parent = parent.parentElement) {
              if (candidates.has(parent)) return false;
            }
            return true;
          });
          for (const el of outermost) {
            if (!el.isConnected || hidden.some((item) => item[0] === el)) continue;
            hidden.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
            el.style.setProperty("visibility", "hidden", "important");
          }
          await sleep(120);
        }

        await sleep(550);
        const captureOptions = { format: imageOptions.captureFormat };
        if (imageOptions.captureFormat === "jpeg") captureOptions.quality = imageOptions.quality;
        const captured = await chrome.runtime.sendMessage({
          type: "capture-full-page-segment",
          jobId,
          windowId,
          options: captureOptions
        });
        if (!captured?.ok || !captured.dataUrl) throw new Error(captured?.message || "瀏覽器沒有回傳截圖片段。");
        const image = await loadImage(captured.dataUrl);
        const sourceCssHeight = image.height / dpr;
        const drawCssHeight = Math.min(sourceCssHeight, height - y);
        const sourcePixelHeight = Math.round(drawCssHeight * dpr);
        ctx.drawImage(image, 0, 0, image.width, sourcePixelHeight, 0, Math.round(y * dpr), outputWidth, sourcePixelHeight);
        image.close?.();
      }

      sendProgress(jobId, { done: uniqueSteps.length, total: uniqueSteps.length, message: `正在產生 ${imageOptions.label}…` }, "正在產生完整網頁圖片…");
      const blob = await canvasToBlob(canvas, imageOptions.mimeType,
        imageOptions.captureFormat === "jpeg" ? imageOptions.quality / 100 : undefined);
      const filename = `HTML轉圖片/${safeFilename(title)}_${timestamp()}_完整網頁.${imageOptions.extension}`;
      const dataUrl = await blobToDataUrl(blob);
      const result = await transferImageForDownload(jobId, filename, dataUrl);
      if (!result?.ok) throw new Error(result?.message || "完整頁面圖片下載失敗。");
      sendProgress(jobId, { done: uniqueSteps.length, total: uniqueSteps.length, message: "下載完成" },
        `完整網頁 ${imageOptions.label} 已自動下載，共拼接 ${uniqueSteps.length} 段。`, "ok");
    } finally {
      for (const [el, value, priority] of hidden) {
        if (!el?.style) continue;
        if (value) el.style.setProperty("visibility", value, priority || "");
        else el.style.removeProperty("visibility");
      }
      root.style.scrollBehavior = original.behavior || "";
      root.style.overflow = original.overflow || "";
      if (activeScroller && scrollerOriginal) {
        activeScroller.style.scrollBehavior = scrollerOriginal.behavior || "";
        activeScroller.scrollTo(scrollerOriginal.x || 0, scrollerOriginal.y || 0);
      }
      window.scrollTo(original.x || 0, original.y || 0);
      if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("截圖片段載入失敗。"));
      image.src = src;
    });
  }
  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("無法產生完整網頁圖片。")), type, quality));
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("圖片轉換失敗。"));
      reader.readAsDataURL(blob);
    });
  }
  async function transferImageForDownload(jobId, filename, dataUrl) {
    const chunkSize = 512 * 1024;
    const started = await chrome.runtime.sendMessage({ type: "begin-full-page-download", jobId, filename });
    if (!started?.ok) throw new Error(started?.message || "無法準備長圖下載。");
    try {
      for (let offset = 0; offset < dataUrl.length; offset += chunkSize) {
        const appended = await chrome.runtime.sendMessage({
          type: "append-full-page-download", jobId, chunk: dataUrl.slice(offset, offset + chunkSize)
        });
        if (!appended?.ok) throw new Error(appended?.message || "長圖資料傳送失敗。");
      }
      const result = await chrome.runtime.sendMessage({ type: "finish-full-page-download", jobId });
      if (!result?.ok) throw new Error(result?.message || "完整網頁圖片下載失敗。");
      return result;
    } catch (error) {
      await chrome.runtime.sendMessage({ type: "abort-full-page-download", jobId }).catch(() => {});
      throw error;
    }
  }
  function safeFilename(value) {
    return String(value || "webpage").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 150) || "webpage";
  }
  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
})();
