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
    let activeScroller = null;
    let scrollerOriginal = null;
    let canvas = null;
    let persistentSidePanelRegions = [];
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
      // Capture small, frequent steps. Virtualized tables often render rows
      // only as they enter the viewport; large jumps can skip rows entirely.
      // Each screenshot contributes only the next uncovered page strip, so a
      // later capture cannot overwrite already stitched data with a blank row.
      const captureStepStride = Math.max(80, Math.min(180, Math.floor(captureStepHeight * 0.16)));
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
      for (let y = 0; y < scrollRange; y += captureStepStride) steps.push(y);
      if (!steps.length || steps.at(-1) !== scrollRange) steps.push(scrollRange);
      const uniqueSteps = [...new Set(steps)];
      const scrollDescription = activeScroller ? "內部捲動區" : "整個頁面";
      sendProgress(jobId, { done: 0, total: uniqueSteps.length, message: `已偵測${scrollDescription}，可捲動 ${Math.round(scrollRange)} px，共 ${uniqueSteps.length} 段…` },
        `已啟動完整頁面截圖：${scrollDescription}，${uniqueSteps.length} 段（${imageOptions.label}）；可關閉擴充功能視窗。`);

      const isVisible = (el, rect = el.getBoundingClientRect()) => {
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 &&
          rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 &&
          rect.left < viewportWidth && rect.top < viewportHeight;
      };
      // Detect the complete edge sidebar, not just its outer fixed element.
      // Frameworks may mark inner controls/containers fixed or sticky too; if
      // those descendants are hidden independently, labels remain but inputs
      // disappear in stitched segments.
      const isSidebarIdentity = (el) => {
        const identity = `${el.id || ""} ${el.className?.baseVal || el.className || ""} ${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("data-testid") || ""}`;
        return /sidebar|side[-_ ]?panel|sidenav/i.test(identity);
      };
      const isPersistentSidePanel = (el, rect = el.getBoundingClientRect()) => {
        const style = getComputedStyle(el);
        const edge = rect.left <= 8 || rect.right >= viewportWidth - 8;
        const narrow = rect.width <= Math.max(520, viewportWidth * 0.42);
        const tall = rect.height >= viewportHeight * 0.35;
        return edge && narrow && tall && (isSidebarIdentity(el) || style.position === "fixed" || style.position === "sticky");
      };
      const sidebarCandidates = [...document.querySelectorAll("body *")]
        .filter((el) => isVisible(el) && isPersistentSidePanel(el));
      const persistentSidePanelRoots = sidebarCandidates.filter((el) => {
        for (let parent = el.parentElement; parent && parent !== body; parent = parent.parentElement) {
          if (sidebarCandidates.includes(parent)) return false;
        }
        return true;
      });
      persistentSidePanelRegions = persistentSidePanelRoots.map((el) => {
        const rect = el.getBoundingClientRect();
        let backgroundColor = "#ffffff";
        for (let node = el; node && node !== body; node = node.parentElement) {
          const candidate = getComputedStyle(node).backgroundColor;
          if (candidate && candidate !== "transparent" && !/^rgba\([^)]*,\s*0\s*\)$/i.test(candidate)) {
            backgroundColor = candidate;
            break;
          }
        }
        const panelLeft = Math.max(0, rect.left);
        const panelRight = Math.min(viewportWidth, rect.right);
        const scrollCandidates = [el, ...el.querySelectorAll("*")].filter((node) => {
          if (node === activeScroller) return false;
          const style = getComputedStyle(node);
          const range = node.scrollHeight - node.clientHeight;
          return /(auto|scroll|overlay|hidden)/.test(style.overflowY) && range > 32 &&
            node.clientHeight >= viewportHeight * 0.3 && node.clientWidth >= (panelRight - panelLeft) * 0.55;
        });
        scrollCandidates.sort((a, b) =>
          (b.scrollHeight - b.clientHeight) * b.clientWidth - (a.scrollHeight - a.clientHeight) * a.clientWidth
        );
        const panelScroller = scrollCandidates[0] || null;
        return {
          left: panelLeft,
          right: panelRight,
          backgroundColor,
          scroller: panelScroller,
          scrollRange: panelScroller ? Math.max(0, panelScroller.scrollHeight - panelScroller.clientHeight) : 0,
          contentHeight: panelScroller ? panelScroller.scrollHeight : viewportHeight,
          originalScrollTop: panelScroller ? panelScroller.scrollTop : 0,
          originalScrollBehavior: panelScroller?.style.scrollBehavior || ""
        };
      }).filter((panel) => panel.right > panel.left);
      const isRelatedToPersistentSidePanel = (el) => persistentSidePanelRoots.some((rootEl) =>
        rootEl === el || rootEl.contains(el) || el.contains(rootEl)
      );
      canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("無法建立截圖拼接畫布。");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outputWidth, outputHeight);
      const outputScaleX = outputWidth / Math.max(1, viewportWidth);
      for (const panel of persistentSidePanelRegions) {
        ctx.fillStyle = panel.backgroundColor;
        ctx.fillRect(panel.left * outputScaleX, 0, (panel.right - panel.left) * outputScaleX, outputHeight);
      }

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
      // Protect the panel and its ancestor chain. Some SPA frameworks put a
      // fixed sidebar inside a fixed application shell; hiding that shell also
      // removes every navigation label even though the sidebar itself was
      // correctly classified and excluded from the page crop.
      for (const panel of persistentSidePanelRegions) {
        if (!panel.scroller) continue;
        panel.scroller.style.scrollBehavior = "auto";
        panel.scroller.scrollTop = 0;
      }

      let outputCoveredCss = 0;
      for (let i = 0; i < uniqueSteps.length; i++) {
        const y = uniqueSteps[i];
        sendProgress(jobId, { done: i, total: uniqueSteps.length, message: `擷取第 ${i + 1} / ${uniqueSteps.length} 段…` },
          `正在擷取完整網頁（${imageOptions.label}）…`);
        await scrollToAndWait(y);
        // Never hide page elements while capturing. Position-based filtering
        // can classify virtualized table rows or charts as floating chrome,
        // which permanently removes real content from the exported image.
        // Repeated fixed UI is preferable to missing page data.

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
        const sourceScaleY = image.height / Math.max(1, viewportHeight);
        const sourceTopCss = i === 0 ? 0 : outputCoveredCss - y;
        if (sourceTopCss < -2 || sourceTopCss >= viewportHeight) {
          image.close?.();
          throw new Error(`拼接位置不連續（第 ${i + 1} 段），已停止以免輸出缺列。`);
        }
        const firstTileLimit = i === 0
          ? (uniqueSteps.length === 1 ? height : Math.max(1, captureStepHeight - captureStepStride))
          : viewportHeight - sourceTopCss;
        const drawCssHeight = Math.min(firstTileLimit, viewportHeight - sourceTopCss, height - outputCoveredCss);
        if (drawCssHeight <= 0) { image.close?.(); break; }
        const sourcePixelTop = Math.round(Math.max(0, sourceTopCss) * sourceScaleY);
        const sourcePixelHeight = Math.min(image.height - sourcePixelTop, Math.round(drawCssHeight * sourceScaleY));
        const destinationY = Math.round(outputCoveredCss * dpr);
        const destinationPixelHeight = Math.round(drawCssHeight * dpr);
        if (sourcePixelHeight <= 0 || destinationPixelHeight <= 0) {
          image.close?.();
          throw new Error(`第 ${i + 1} 段截圖高度無效，已停止以免下載不完整長圖。`);
        }
        if (persistentSidePanelRegions.length === 0) {
          ctx.drawImage(image, 0, sourcePixelTop, image.width, sourcePixelHeight, 0, destinationY, outputWidth, destinationPixelHeight);
        } else {
          // Keep fixed panels out of page segments. They are captured and
          // stitched in a separate pass below using their own scroll range.
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, destinationY, outputWidth, destinationPixelHeight);
          for (const panel of persistentSidePanelRegions) {
            ctx.rect(panel.left * outputScaleX, destinationY, (panel.right - panel.left) * outputScaleX, destinationPixelHeight);
          }
          ctx.clip("evenodd");
          ctx.drawImage(image, 0, sourcePixelTop, image.width, sourcePixelHeight, 0, destinationY, outputWidth, destinationPixelHeight);
          ctx.restore();
        }
        outputCoveredCss += drawCssHeight;
        image.close?.();
      }

      if (outputCoveredCss < height - 2) {
        throw new Error(`長圖只拼接到 ${Math.round(outputCoveredCss)} / ${Math.round(height)} px；已取消下載，請重試。`);
      }

      if (persistentSidePanelRegions.length) {
        const panelPassHeight = Math.max(...persistentSidePanelRegions.map((panel) => panel.contentHeight));
        const panelSteps = [];
        for (let y = 0; y < panelPassHeight; y += viewportHeight) panelSteps.push(y);
        await scrollToAndWait(0);
        sendProgress(jobId, { done: 0, total: panelSteps.length, message: `正在完整拼接左側欄（${panelSteps.length} 段）…` },
          "正在獨立擷取側欄內容；完成後會接續產生完整網頁圖片…");
        for (let index = 0; index < panelSteps.length; index++) {
          const panelY = panelSteps[index];
          for (const panel of persistentSidePanelRegions) {
            if (panel.scroller) panel.scroller.scrollTop = Math.min(panelY, panel.scrollRange);
          }
          if (persistentSidePanelRegions.some((panel) => panel.scroller)) await sleep(200);
          await sleep(550);
          const captureOptions = { format: imageOptions.captureFormat };
          if (imageOptions.captureFormat === "jpeg") captureOptions.quality = imageOptions.quality;
          const captured = await chrome.runtime.sendMessage({
            type: "capture-full-page-segment", jobId, windowId, options: captureOptions
          });
          if (!captured?.ok || !captured.dataUrl) throw new Error(captured?.message || "瀏覽器沒有回傳側欄截圖片段。");
          const image = await loadImage(captured.dataUrl);
          const sourceScaleX = image.width / Math.max(1, viewportWidth);
          const sourceScaleY = image.height / Math.max(1, viewportHeight);
          for (const panel of persistentSidePanelRegions) {
            const panelScrollTop = Math.min(panelY, panel.scrollRange);
            const sourceTopCss = panelY - panelScrollTop;
            const drawHeightCss = Math.min(viewportHeight - sourceTopCss, panel.contentHeight - panelY);
            if (drawHeightCss <= 0) continue;
            ctx.drawImage(
              image,
              panel.left * sourceScaleX, sourceTopCss * sourceScaleY,
              (panel.right - panel.left) * sourceScaleX, drawHeightCss * sourceScaleY,
              panel.left * outputScaleX, panelY * dpr,
              (panel.right - panel.left) * outputScaleX, drawHeightCss * dpr
            );
          }
          image.close?.();
          sendProgress(jobId, { done: index + 1, total: panelSteps.length, message: `側欄第 ${index + 1} / ${panelSteps.length} 段已拼接` },
            "正在拼接側欄內容…");
        }
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
      for (const panel of persistentSidePanelRegions) {
        if (!panel.scroller) continue;
        panel.scroller.style.scrollBehavior = panel.originalScrollBehavior;
        panel.scroller.scrollTop = panel.originalScrollTop;
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
