function evaluateCaptureScrollClamp(requestedY, maxY, actualY, bottomTolerance = 24, previousY = 0) {
  // Treat the request as a page-tail clamp only when it is just beyond the
  // current live maximum. This does not depend on the preflight estimate of
  // which tile is "last"; lazy-loaded layouts can change that estimate.
  const withinTailClamp = requestedY >= maxY && requestedY - maxY <= 64;
  const allowedRangeChange = withinTailClamp ? 64 : bottomTolerance;
  const overrun = requestedY > maxY + allowedRangeChange;
  // Some Chromium scroll containers report a max scroll position a few
  // dozen pixels beyond the position they can actually reach (Garmin SPA
  // pages reproduce this: request/max=4003, settled position=3972). The
  // scroll loop already verifies that actualY has settled across frames, so
  // accept a bounded discrepancy only when the request is at the live tail.
  const reachedBottom = requestedY >= maxY - bottomTolerance &&
    actualY >= maxY - allowedRangeChange &&
    requestedY - actualY <= allowedRangeChange;
  const targetY = Math.min(requestedY, maxY);
  const settledNearTarget = Math.abs(actualY - targetY) <= 64 &&
    (targetY <= previousY + 3 || actualY > previousY + 3);
  return { allowedRangeChange, overrun, reachedBottom, settledNearTarget };
}

// Pick each tile from the actual covered frontier instead of a precomputed
// scroll list. If a page clamps one scroll by a few pixels, this keeps that
// difference from accumulating across later tiles.
function getNextCaptureTarget(outputCoveredCss, viewportHeight, stride, afterFirstTile = false) {
  // The first tile is intentionally shortened to preserve a broad overlap.
  // Its next target is exactly one stride; subsequent tiles end at their real
  // scroll position plus one viewport, so the general frontier formula applies.
  if (afterFirstTile) return stride;
  return Math.max(0, outputCoveredCss - viewportHeight + stride);
}

function getPageCaptureTarget(frontierTarget, liveMaxY, isLastSegment) {
  // A page can shrink while lazy content settles. Never send the old planned
  // tail past the browser's current maximum; the live bottom is authoritative.
  return isLastSegment ? liveMaxY : Math.min(frontierTarget, liveMaxY);
}

function getCaptureDocumentHeight(root, body) {
  return Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight);
}

function isReverseCaptureScroller(element, styleReader = globalThis.getComputedStyle) {
  if (!element) return false;
  return element.scrollTop < -3 || (typeof styleReader === "function" && styleReader(element).flexDirection === "column-reverse");
}

function getCaptureLogicalScrollY(element, isReversed, maxY) {
  return isReversed ? element.scrollTop + maxY : element.scrollTop;
}

function getCapturePhysicalScrollY(logicalY, maxY, isReversed) {
  return isReversed ? logicalY - maxY : logicalY;
}

function mapCaptureRectToPixels(rect, imageWidth, imageHeight, viewportWidth, viewportHeight) {
  const scaleX = imageWidth / Math.max(1, viewportWidth);
  const scaleY = imageHeight / Math.max(1, viewportHeight);
  return {
    x: Math.round(rect.left * scaleX),
    y: Math.round(rect.top * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
    scaleX,
    scaleY
  };
}

function getChatGPTCaptureLayout(contentRect) {
  const sidebarWidth = Math.max(0, contentRect.left);
  const contentWidth = Math.max(1, contentRect.width);
  return { sidebarWidth, contentWidth, outputWidth: sidebarWidth + contentWidth };
}

function canTrimCaptureTail(preflightHeight, liveHeight, coveredHeight, scrollY, liveMaxY, bottomClampPx = 0) {
  const atLiveBottom = scrollY >= liveMaxY - 3 ||
    (bottomClampPx > 0 && bottomClampPx <= 64 && scrollY >= liveMaxY - bottomClampPx - 3);
  return liveHeight > 0 && liveHeight < preflightHeight &&
    coveredHeight >= liveHeight - 2 && atLiveBottom;
}

function isCoveredClampedTail(sourceTopCss, viewportHeight, coveredHeight, actualY, liveMaxY, bottomClampPx) {
  return sourceTopCss >= viewportHeight && bottomClampPx > 0 && bottomClampPx <= 64 &&
    actualY >= liveMaxY - 64 && Math.abs(coveredHeight - (actualY + viewportHeight)) <= 2;
}

async function probeCaptureScrollContainer(element, waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))) {
  const max = Math.max(0, element.scrollHeight - element.clientHeight);
  const before = element.scrollTop;
  const probe = before + 64 <= max ? before + 64 : Math.max(0, before - 64);
  if (Math.abs(probe - before) <= 3) return false;
  const oldBehavior = element.style.scrollBehavior;
  try {
    element.style.scrollBehavior = "auto";
    element.scrollTop = probe;
    await waitFrame();
    await waitFrame();
    const moved = Math.abs(element.scrollTop - before) > 3;
    element.scrollTop = before;
    await waitFrame();
    return moved;
  } finally {
    element.style.scrollBehavior = oldBehavior;
  }
}

async function probeCaptureWindowScroll(windowObject, maxY, waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))) {
  const before = windowObject.scrollY;
  const target = before + 64 <= maxY ? before + 64 : Math.max(0, before - 64);
  if (Math.abs(target - before) <= 3) return false;
  windowObject.scrollTo(0, target);
  await waitFrame();
  await waitFrame();
  const moved = Math.abs(windowObject.scrollY - before) > 3;
  windowObject.scrollTo(0, before);
  await waitFrame();
  return moved;
}

async function selectCaptureScrollContainer(windowObject, windowRange, candidates, documentScroller, body,
  waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))) {
  if (await probeCaptureWindowScroll(windowObject, windowRange, waitFrame)) return null;
  for (const candidate of candidates.slice(0, 24)) {
    if (await probeCaptureScrollContainer(candidate.element, waitFrame)) return candidate.element;
  }
  if (documentScroller && documentScroller !== body && await probeCaptureScrollContainer(documentScroller, waitFrame)) {
    return documentScroller;
  }
  return null;
}

async function probeCaptureWheelScrollContainer(windowObject, candidates, documentScroller, dispatchWheel,
  waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve)), documentObject = null) {
  const elements = [...new Set([
    ...candidates.map((candidate) => candidate.element || candidate),
    documentScroller,
    ...(documentObject ? collectLiveCaptureScrollers(documentObject) : [])
  ].filter(Boolean))];
  const beforeWindowY = windowObject.scrollY;
  const before = new Map(elements.map((element) => [element, element.scrollTop]));
  const scrollable = elements.filter((element) => element.scrollHeight - element.clientHeight > 32);
  if (!scrollable.length) return { attempted: false, dispatched: false, scroller: null, windowMoved: false, moved: false, movement: "沒有找到有捲動範圍的 DOM 元素" };

  // The first entries are the ancestors under a point in the main content
  // area, followed by other measured candidates. If the conversation is
  // already at its tail, probe upward so a wheel test can still identify it.
  const primary = candidates[0]?.element || candidates[0] || scrollable[0];
  const primaryMax = Math.max(0, primary.scrollHeight - primary.clientHeight);
  const reversed = isReverseCaptureScroller(primary);
  const atBottom = reversed ? primary.scrollTop >= -3 : primary.scrollTop >= primaryMax - 3;
  const direction = atBottom ? -1 : 1;
  const deltaY = direction * 160;
  let dispatched = false;
  let movedScroller = null;
  try {
    dispatched = Boolean(await dispatchWheel(deltaY));
    if (!dispatched) return { attempted: true, dispatched: false, scroller: null, windowMoved: false, moved: false, movement: "背景未送出滾輪事件" };
    await waitFrame();
    await waitFrame();
    movedScroller = documentObject
      ? findMovedCaptureScroller(documentObject, before, direction)
      : elements.map((element) => ({ element, delta: element.scrollTop - before.get(element) }))
        .filter((item) => item.delta * direction > 3)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null;
    const moved = movedScroller ? [movedScroller] : [];
    const windowMoved = Math.abs(windowObject.scrollY - beforeWindowY) > 3;
    const scroller = windowMoved ? null : (moved[0]?.element || null);
    const movement = windowMoved ? `window ${Math.round(windowObject.scrollY - beforeWindowY)}px`
      : movedScroller ? `${movedScroller.element.tagName?.toLowerCase?.() || "element"}${movedScroller.element.id ? `#${movedScroller.element.id}` : ""} ${Math.round(movedScroller.delta)}px`
      : "無 DOM 位移";
    return { attempted: true, dispatched: true, scroller, windowMoved, moved: Boolean(scroller || windowMoved), movement };
  } finally {
    for (const element of elements) {
      const originalY = before.get(element);
      if (Math.abs(element.scrollTop - originalY) > 3) element.scrollTop = originalY;
    }
    if (movedScroller && !elements.includes(movedScroller.element) && before.has(movedScroller.element)) {
      movedScroller.element.scrollTop = before.get(movedScroller.element);
    }
    if (Math.abs(windowObject.scrollY - beforeWindowY) > 3) windowObject.scrollTo(0, beforeWindowY);
    if (dispatched) {
      await waitFrame();
      await waitFrame();
    }
  }
}

// On virtualized SPA pages, the real scroll owner may be a nested element
// which was not among the initial size/visibility candidates. Only run this
// more expensive full DOM scan after a direct scroll has stalled.
function collectLiveCaptureScrollers(documentObject) {
  const result = [];
  const seen = new Set();
  const add = (element) => {
    if (!element || seen.has(element)) return;
    seen.add(element);
    if (element.scrollHeight - element.clientHeight > 32) result.push(element);
  };
  add(documentObject.scrollingElement);
  add(documentObject.documentElement);
  add(documentObject.body);
  for (const element of documentObject.querySelectorAll("body *")) add(element);
  return result;
}

function findMovedCaptureScroller(documentObject, beforePositions, direction = 1) {
  return collectLiveCaptureScrollers(documentObject)
    // Only compare nodes that were actually measured before dispatching the
    // wheel event. Treating an untracked node's existing scrollTop as a delta
    // from zero can mistake a scroller already at the bottom for one moved by
    // this wheel event (common on long SPA conversations).
    .filter((element) => beforePositions.has(element))
    .map((element) => ({ element, delta: element.scrollTop - beforePositions.get(element) }))
    .filter((item) => item.delta * direction > 3)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null;
}

(() => {
  if (globalThis.__htmlConverterCaptureListener) return;
  globalThis.__htmlConverterCaptureListener = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sendProgress = (jobId, progress, status, statusType = "", details = null) => {
    const entry = {
      time: new Date().toISOString(),
      progress: progress?.message || "",
      status: status || "",
      details: details || undefined
    };
    const log = globalThis.__htmlConverterCurrentDiagnostics || (globalThis.__htmlConverterCurrentDiagnostics = []);
    log.push(entry);
    if (log.length > 500) log.splice(0, log.length - 500);
    chrome.runtime.sendMessage({
      type: "full-page-capture-progress",
      jobId,
      progress,
      status,
      statusType,
      diagnostic: entry
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
        sendProgress(message.jobId, null, `完整頁面截圖失敗：${reason}`, "error", {
          event: "capture-error", message: reason, stack: error?.stack || ""
        });
      })
      .finally(() => { globalThis.__htmlConverterCaptureRunning = false; });
    return false;
  });

  async function runFullPageCapture(job) {
    const { jobId, windowId, title, imageOptions } = job;
    // Keep every scroll tile lossless. Encoding each tile as JPG and then
    // encoding the stitched canvas as JPG caused double compression blur.
    const segmentCaptureOptions = { format: "png" };
    globalThis.__htmlConverterCurrentDiagnostics = [];
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
    let activeScrollerIsReversed = false;
    let scrollerOriginal = null;
    let canvases = [];
    let persistentSidePanelRegions = [];
    let chatGPTHiddenUi = [];
    let debuggerSessionStarted = false;
    let zoomAdjustedForCapture = false;
    let bottomClampPx = 0;
    let scrollProbeDiagnostics = "尚未執行滾輪驗證";
    let captureScrollInputPoint = null;
    try {
      const debuggerStart = await chrome.runtime.sendMessage({ type: "begin-full-page-capture-session", jobId });
      if (!debuggerStart?.ok) throw new Error(debuggerStart?.message || "無法啟用來源分頁背景截圖。");
      debuggerSessionStarted = true;
      zoomAdjustedForCapture = debuggerStart.zoomAdjusted === true;
      const backgroundMode = debuggerStart.mode || "debugger";
      const zoomNotice = debuggerStart.zoomAdjusted
        ? "為提高小字清晰度，已暫時使用 100% 瀏覽器縮放；完成後會恢復原縮放。"
        : "";
      const modeNotice = backgroundMode === "visible"
        ? `瀏覽器不允許背景連接此分頁；截圖會暫停等待原網頁，切回後自動續跑。${zoomNotice}`
        : `${zoomNotice || `正在準備完整網頁截圖（${imageOptions.label}）…`}`;
      sendProgress(jobId, { done: 0, total: 1, message: "分析頁面尺寸…" }, modeNotice, backgroundMode === "visible" ? "warning" : "");
      sendProgress(jobId, null, "", "", { event: "capture-zoom", originalZoom: debuggerStart.originalZoom,
        normalizedTo100: debuggerStart.zoomAdjusted === true, effectiveZoom: debuggerStart.zoomAdjusted ? 1 : debuggerStart.originalZoom });
      root.style.scrollBehavior = "auto";
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const pageWidth = Math.max(root.scrollWidth, body.scrollWidth || 0, root.clientWidth);
      let pageHeight = getCaptureDocumentHeight(root, body);
      let windowRange = Math.max(0, pageHeight - viewportHeight);

      // Detect likely nested scrollers, then probe their actual scrollTop
      // behavior. ChatGPT and other SPAs can expose a large scrollHeight on a
      // wrapper that is not the element that owns user scrolling.
      const scrollCandidates = [];
      for (const el of document.querySelectorAll("body *")) {
        const style = getComputedStyle(el);
        // Do not rely on overflowY alone. ChatGPT and other SPAs can route
        // wheel events through a clipped/transformed shell whose computed
        // overflow value does not advertise it as the scroll owner.
        const range = el.scrollHeight - el.clientHeight;
        if (range < 32 || el.clientHeight < viewportHeight * 0.3 || el.clientWidth < viewportWidth * 0.3) continue;
        const rect = el.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
        if (visibleWidth < viewportWidth * 0.25 || visibleHeight < viewportHeight * 0.25) continue;
        const visibleAreaRatio = visibleWidth * visibleHeight / (viewportWidth * viewportHeight);
        const score = range * (0.5 + visibleAreaRatio);
        scrollCandidates.push({ element: el, range, score });
      }
      scrollCandidates.sort((a, b) => b.score - a.score);
      // Keep a second, less restrictive inventory for the trusted-wheel
      // probe. ChatGPT can place its conversation scroller inside a transformed
      // shell whose visible size/overflow styles fail the initial candidate
      // filters. If that happens, the old path saw windowRange=0, skipped the
      // real owner, and silently reported a successful 1/1 viewport capture.
      const allLiveScrollers = collectLiveCaptureScrollers(document);
      const describeScroller = (el) => {
        const rect = el.getBoundingClientRect();
        const className = typeof el.className === "string" ? el.className.trim().replace(/\s+/g, ".").slice(0, 180) : "";
        return {
          node: `${el.tagName?.toLowerCase() || "element"}${el.id ? `#${el.id}` : ""}${className ? `.${className}` : ""}`,
          connected: el.isConnected,
          scrollTop: Math.round(el.scrollTop),
          scrollLeft: Math.round(el.scrollLeft),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          range: Math.max(0, el.scrollHeight - el.clientHeight),
          overflowY: getComputedStyle(el).overflowY,
          flexDirection: getComputedStyle(el).flexDirection,
          scrollModel: isReverseCaptureScroller(el) ? "reverse-negative-scrollTop" : "normal-positive-scrollTop",
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
      };
      sendProgress(jobId, null, "", "", {
        event: "page-inventory",
        page: { origin: location.origin, path: location.pathname, title, viewport: { width: viewportWidth, height: viewportHeight, dpr: window.devicePixelRatio || 1 },
          document: { width: pageWidth, height: pageHeight, windowRange } },
        browser: navigator.userAgent,
        filteredCandidates: scrollCandidates.slice(0, 20).map((item) => describeScroller(item.element)),
        allScrollableElements: allLiveScrollers.slice(0, 80).map(describeScroller)
      });
      // Choose by observed behavior, not by comparing estimated document and
      // element heights. SPA shells such as ChatGPT can report similar ranges
      // for window and the real conversation scroller while only the latter
      // actually moves.
      activeScroller = await selectCaptureScrollContainer(window, windowRange, scrollCandidates, document.scrollingElement, body);
      if (!activeScroller) {
        const probeX = Math.min(viewportWidth - 1, Math.max(0, Math.round(viewportWidth * 0.68)));
        const probeY = Math.min(viewportHeight - 1, Math.max(0, Math.round(viewportHeight * 0.45)));
        const pointCandidates = [];
        for (let node = document.elementFromPoint(probeX, probeY); node && node !== body; node = node.parentElement) {
          if (node.scrollHeight - node.clientHeight > 32) pointCandidates.push(node);
        }
        const wheelCandidates = [...pointCandidates, ...scrollCandidates.map((candidate) => candidate.element), ...allLiveScrollers];
        const wheelProbe = await probeCaptureWheelScrollContainer(window, wheelCandidates, document.scrollingElement,
          async (deltaY) => {
            const response = await chrome.runtime.sendMessage({
              type: "scroll-capture-by-wheel", jobId,
              x: probeX, y: probeY, deltaY
            });
            if (response?.ok) await sleep(180);
            return response?.ok === true;
          },
          async () => sleep(60), document
        );
        if (wheelProbe.moved) captureScrollInputPoint = { x: probeX, y: probeY };
        const hit = document.elementFromPoint(probeX, probeY);
        scrollProbeDiagnostics = `wheel=${wheelProbe.dispatched ? "已送出" : "未送出"}；位置=${probeX},${probeY}；命中=${hit?.tagName?.toLowerCase() || "無"}${hit?.id ? `#${hit.id}` : ""}；位移=${wheelProbe.movement}；DOM可捲動元素=${allLiveScrollers.length}`;
        if (wheelProbe.scroller) {
          activeScroller = wheelProbe.scroller;
        } else if (wheelProbe.windowMoved) {
          // The first measurement may have happened while an SPA still had a
          // viewport-sized document shell. Once the wheel proves that the
          // window itself scrolls, refresh BOTH values used for canvas sizing;
          // updating only windowRange creates a viewport-height "full page".
          pageHeight = getCaptureDocumentHeight(root, body);
          windowRange = Math.max(0, pageHeight - viewportHeight);
        } else if (windowRange > 32 && wheelProbe.attempted && !wheelProbe.moved) {
          throw new Error(`找不到可驗證的頁面捲動來源；${scrollProbeDiagnostics}；候選數=${wheelCandidates.length}。為避免下載不完整圖片，已停止。`);
        }
        sendProgress(jobId, null, "", "", { event: "wheel-preflight", diagnostic: scrollProbeDiagnostics,
          selectedScroller: activeScroller ? describeScroller(activeScroller) : null,
          window: { scrollY: window.scrollY, range: windowRange }, inputPoint: captureScrollInputPoint });
      }
      // A successful programmatic scrollTop probe is not proof that a SPA
      // actually uses that node. In particular, ChatGPT can contain large
      // inert/clipped DIVs whose scrollTop accepts values but whose user scroll
      // is owned by another node. Verify every selected element with a real
      // browser wheel event before sizing or stitching the output.
      if (activeScroller) {
        const probeX = Math.min(viewportWidth - 1, Math.max(0, Math.round(viewportWidth * 0.68)));
        const probeY = Math.min(viewportHeight - 1, Math.max(0, Math.round(viewportHeight * 0.45)));
        const pointCandidates = [];
        for (let node = document.elementFromPoint(probeX, probeY); node && node !== body; node = node.parentElement) {
          if (node.scrollHeight - node.clientHeight > 32) pointCandidates.push(node);
        }
        const wheelProbe = await probeCaptureWheelScrollContainer(window, [
          ...pointCandidates,
          activeScroller,
          ...scrollCandidates.map((candidate) => candidate.element),
          ...allLiveScrollers
        ], document.scrollingElement, async (deltaY) => {
          const response = await chrome.runtime.sendMessage({
            type: "scroll-capture-by-wheel", jobId,
            x: probeX, y: probeY, deltaY
          });
          if (response?.ok) await sleep(180);
          return response?.ok === true;
        }, async () => sleep(60), document);
        if (wheelProbe.moved) captureScrollInputPoint = { x: probeX, y: probeY };
        const hit = document.elementFromPoint(probeX, probeY);
        scrollProbeDiagnostics = `已選容器=${activeScroller.tagName.toLowerCase()}${activeScroller.id ? `#${activeScroller.id}` : ""}；range=${Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight)}；wheel=${wheelProbe.dispatched ? "已送出" : "未送出"}；位置=${probeX},${probeY}；命中=${hit?.tagName?.toLowerCase() || "無"}${hit?.id ? `#${hit.id}` : ""}；位移=${wheelProbe.movement}；DOM可捲動元素=${allLiveScrollers.length}`;
        if (!wheelProbe.moved && windowRange > 32) {
          throw new Error(`捲動來源預檢未通過；${scrollProbeDiagnostics}；候選數=${scrollCandidates.length}。請將這段診斷回傳，以便精確修正；本次未產生長圖。`);
        }
        if (wheelProbe.scroller) activeScroller = wheelProbe.scroller;
        else if (wheelProbe.windowMoved) {
          activeScroller = null;
          pageHeight = getCaptureDocumentHeight(root, body);
          windowRange = Math.max(0, pageHeight - viewportHeight);
        }
        sendProgress(jobId, null, "", "", { event: "selected-scroller-verified", diagnostic: scrollProbeDiagnostics,
          selectedScroller: activeScroller ? describeScroller(activeScroller) : null,
          window: { scrollY: window.scrollY, range: windowRange }, inputPoint: captureScrollInputPoint });
      }
      activeScrollerIsReversed = isReverseCaptureScroller(activeScroller);
      sendProgress(jobId, null, "", "", { event: "scroll-model-detected",
        model: activeScrollerIsReversed ? "reverse-negative-scrollTop" : "normal-positive-scrollTop",
        scroller: activeScroller ? describeScroller(activeScroller) : { node: "window" } });
      const elementRange = activeScroller ? Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight) : 0;
      const scrollRange = activeScroller ? elementRange : windowRange;
      const captureStepHeight = activeScroller ? activeScroller.clientHeight : viewportHeight;
      // Unknown or data-heavy pages use the proven conservative stride. A
      // larger stride is selected only after a preflight confirms a static,
      // non-table page; see the mutation probe before the capture loop.
      const conservativeStride = Math.max(80, Math.min(180, Math.floor(captureStepHeight * 0.16)));
      let captureStepStride = conservativeStride;
      const chatGPTContentCapture = Boolean(activeScroller && /(^|\.)chatgpt\.com$/i.test(location.hostname));
      const scrollerRect = chatGPTContentCapture ? activeScroller.getBoundingClientRect() : null;
      const captureRect = chatGPTContentCapture ? {
        left: Math.max(0, scrollerRect.left),
        top: Math.max(0, scrollerRect.top),
        width: Math.max(1, Math.min(viewportWidth, scrollerRect.right) - Math.max(0, scrollerRect.left)),
        height: Math.max(1, Math.min(viewportHeight, scrollerRect.bottom) - Math.max(0, scrollerRect.top))
      } : { left: 0, top: 0, width: viewportWidth, height: viewportHeight };
      const captureViewportHeight = chatGPTContentCapture
        ? Math.min(activeScroller.clientHeight, captureRect.height)
        : viewportHeight;
      // Preserve the visible left rail once at the top of the finished image.
      // It is fixed UI, so copying it into every 125 px overlap tile caused
      // repeated navigation labels; omitting it entirely made the v2.5.32
      // content-only crop lose the user's left-column context.
      const chatGPTLayout = chatGPTContentCapture
        ? getChatGPTCaptureLayout(captureRect)
        : { sidebarWidth: 0, contentWidth: viewportWidth, outputWidth: activeScroller ? viewportWidth : pageWidth };
      const chatGPTSidebarWidth = chatGPTLayout.sidebarWidth;
      const width = chatGPTLayout.outputWidth;
      let height = activeScroller ? captureViewportHeight + scrollRange : pageHeight;
      scrollerOriginal = activeScroller ? {
        x: activeScroller.scrollLeft,
        y: activeScroller.scrollTop,
        behavior: activeScroller.style.scrollBehavior
      } : null;
      if (activeScroller) {
        activeScroller.style.scrollBehavior = "auto";
        activeScroller.scrollTo(0, getCapturePhysicalScrollY(0, scrollRange, activeScrollerIsReversed));
      } else window.scrollTo(0, 0);

      const dpr = window.devicePixelRatio || 1;
      const outputWidth = Math.round(width * dpr);
      const outputHeight = Math.round(height * dpr);
      if (outputWidth > 32767) {
        throw new Error(`頁面寬度 ${outputWidth} 像素超出瀏覽器單張圖片上限；請縮小瀏覽器縮放比例後重試。`);
      }
      const maxCanvasHeight = Math.min(16384, 32767, Math.floor(268435456 / outputWidth));
      const partCssHeight = Math.max(1, Math.floor(maxCanvasHeight / dpr));
      const partCount = Math.ceil(height / partCssHeight);
      if (partCount > 100) throw new Error(`頁面長度需要拆成 ${partCount} 張，超出安全下載數量。請改用「另存 PDF」。`);

      const scrollDescription = activeScroller ? "內部捲動區" : "整個頁面";

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
      const sidebarCandidates = chatGPTContentCapture ? [] : [...document.querySelectorAll("body *")]
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
      if (chatGPTContentCapture) {
        // The full page screenshot includes the ChatGPT sidebar, fixed composer,
        // and floating controls in every small overlap tile. Capture only the
        // measured conversation viewport and temporarily hide those controls.
        const candidates = new Set();
        for (const form of document.querySelectorAll("form,[data-testid*='composer'],[data-testid*='prompt']")) {
          const rect = form.getBoundingClientRect();
          if (isVisible(form, rect) && rect.bottom >= viewportHeight * 0.55 && rect.height <= 280 &&
              rect.width >= viewportWidth * 0.25) candidates.add(form);
        }
        for (const editor of document.querySelectorAll("textarea,[contenteditable]:not([contenteditable='false'])")) {
          const rect = editor.getBoundingClientRect();
          if (!isVisible(editor, rect) || rect.bottom < viewportHeight * 0.55 || rect.height > 180) continue;
          const form = editor.closest("form");
          let overlay = form || editor;
          // Some ChatGPT builds use nested DIVs instead of a FORM. Walk only
          // the compact bottom composer subtree, never the whole scroll pane.
          for (let parent = overlay.parentElement; parent && parent !== activeScroller && parent !== body; parent = parent.parentElement) {
            const parentRect = parent.getBoundingClientRect();
            if (parentRect.height > 280) break;
            if (parentRect.bottom >= viewportHeight * 0.55 && parentRect.width >= viewportWidth * 0.25) overlay = parent;
          }
          const overlayRect = overlay.getBoundingClientRect();
          if (overlayRect.height <= 280 && overlayRect.bottom >= viewportHeight * 0.55 &&
              overlayRect.width >= viewportWidth * 0.25) candidates.add(overlay);
        }
        for (const el of document.querySelectorAll("button,[role='button']")) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""}`;
          const centerX = captureRect.left + captureRect.width / 2;
          const centerControl = rect.width <= 100 && rect.height <= 100 && rect.top >= viewportHeight * 0.55 &&
            Math.abs((rect.left + rect.width / 2) - centerX) <= Math.max(80, captureRect.width * 0.08);
          const floatingControl = ["fixed", "sticky", "absolute"].includes(style.position) && rect.width <= 120 && rect.height <= 120 &&
            (rect.top >= viewportHeight * 0.62 || rect.right >= viewportWidth * 0.94 || centerControl);
          const scrollControl = /scroll.*bottom|bottom.*scroll|scroll-to-bottom|jump.*latest|latest.*message/i.test(label);
          if (isVisible(el, rect) && (floatingControl || scrollControl)) candidates.add(el);
        }
        const roots = [...candidates].filter((el) => ![...candidates].some((other) => other !== el && other.contains(el)));
        chatGPTHiddenUi = roots.map((element) => ({ element,
          visibility: element.style.getPropertyValue("visibility"),
          priority: element.style.getPropertyPriority("visibility") }));
        for (const item of chatGPTHiddenUi) item.element.style.setProperty("visibility", "hidden", "important");
        sendProgress(jobId, null, "", "", { event: "chatgpt-ui-filter", contentRect: captureRect,
          hiddenControls: chatGPTHiddenUi.map(({ element }) => {
            const rect = element.getBoundingClientRect();
            return { tag: element.tagName?.toLowerCase(), testId: element.getAttribute?.("data-testid") || "",
              label: element.getAttribute?.("aria-label") || "", position: getComputedStyle(element).position,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
          }) });
      }
      const outputScaleX = outputWidth / Math.max(1, chatGPTContentCapture ? width : viewportWidth);
      for (let partIndex = 0; partIndex < partCount; partIndex++) {
        const startCss = partIndex * partCssHeight;
        const heightCss = Math.min(partCssHeight, height - startCss);
        canvases.push({ canvas: null, ctx: null, mainBlob: null, startCss, heightCss });
      }
      const ensurePartCanvas = (part) => {
        if (part.canvas) return;
        const canvas = document.createElement("canvas");
        canvas.width = outputWidth;
        canvas.height = Math.max(1, Math.round(part.heightCss * dpr));
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("無法建立截圖拼接畫布。");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (const panel of persistentSidePanelRegions) {
          ctx.fillStyle = panel.backgroundColor;
          ctx.fillRect(panel.left * outputScaleX, 0, (panel.right - panel.left) * outputScaleX, canvas.height);
        }
        part.canvas = canvas;
        part.ctx = ctx;
      };
      const drawAcrossParts = (image, sourceX, sourceY, sourceWidth, sourceHeight, destXCss, destYCss, destWidthCss, destHeightCss, excludePanels = false) => {
        const destBottomCss = destYCss + destHeightCss;
        for (const part of canvases) {
          const overlapTop = Math.max(destYCss, part.startCss);
          const overlapBottom = Math.min(destBottomCss, part.startCss + part.heightCss);
          if (overlapBottom <= overlapTop) continue;
          ensurePartCanvas(part);
          const sourcePerCss = sourceHeight / Math.max(0.001, destHeightCss);
          const sourcePartY = sourceY + (overlapTop - destYCss) * sourcePerCss;
          const sourcePartHeight = (overlapBottom - overlapTop) * sourcePerCss;
          const destinationY = (overlapTop - part.startCss) * dpr;
          const destinationHeight = (overlapBottom - overlapTop) * dpr;
          const destinationX = destXCss * outputScaleX;
          const destinationWidth = destWidthCss * outputScaleX;
          if (excludePanels && persistentSidePanelRegions.length) {
            part.ctx.save();
            part.ctx.beginPath();
            part.ctx.rect(0, destinationY, outputWidth, destinationHeight);
            for (const panel of persistentSidePanelRegions) {
              part.ctx.rect(panel.left * outputScaleX, destinationY, (panel.right - panel.left) * outputScaleX, destinationHeight);
            }
            part.ctx.clip("evenodd");
          }
          part.ctx.drawImage(image, sourceX, sourcePartY, sourceWidth, sourcePartHeight,
            destinationX, destinationY, destinationWidth, destinationHeight);
          if (excludePanels && persistentSidePanelRegions.length) part.ctx.restore();
        }
      };

      const flushCompleteParts = async (coveredCss) => {
        for (let index = 0; index < canvases.length; index++) {
          const part = canvases[index];
          if (part.mainBlob || !part.canvas || part.startCss + part.heightCss > coveredCss + 2) continue;
          part.mainBlob = await canvasToBlob(part.canvas, imageOptions.mimeType,
            imageOptions.captureFormat === "jpeg" ? imageOptions.quality / 100 : undefined);
          part.canvas.width = 1;
          part.canvas.height = 1;
          part.canvas = null;
          part.ctx = null;
          sendProgress(jobId, { done: index + 1, total: canvases.length, message: `第 ${index + 1} / ${canvases.length} 張已拼接` },
            `已完成 ${index + 1} / ${canvases.length} 張頁面分段，繼續擷取…`);
        }
      };

      const setScrollY = (value) => activeScroller
        ? activeScroller.scrollTo(0, getCapturePhysicalScrollY(value,
          Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight), activeScrollerIsReversed))
        : window.scrollTo(0, value);
      const getScrollY = () => activeScroller
        ? getCaptureLogicalScrollY(activeScroller, activeScrollerIsReversed,
          Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight))
        : window.scrollY;
      const getMaxScrollY = () => activeScroller
        ? Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight)
        : Math.max(0, Math.max(root.scrollHeight, body.scrollHeight || 0, root.clientHeight) - viewportHeight);
      const scrollToAndWait = async (value) => {
        const requestedY = Math.max(0, value);
        const previousY = getScrollY();
        const maxY = getMaxScrollY();
        const bottomTolerance = 24;
        if (evaluateCaptureScrollClamp(requestedY, maxY, maxY, bottomTolerance).overrun) {
          throw new Error(`頁面捲動範圍在擷取途中改變（要求 ${Math.round(requestedY)} px，目前上限 ${Math.round(maxY)} px），為避免輸出不完整圖片，已停止擷取。`);
        }
        const targetY = Math.min(requestedY, maxY);
        // The popup no longer needs a visible animation. Instant positioning
        // avoids spending hundreds of milliseconds animating every small tile;
        // we still verify the settled position and wait for page rendering.
        if (activeScroller) setScrollY(targetY);
        else window.scrollTo(0, targetY);
        const start = performance.now();
        let settledFrames = 0;
        let wheelFallbackAttempts = 0;
        let lastWheelFallbackAt = 0;
        while (performance.now() - start < 5000) {
          await sleep(50);
          let observedY = getScrollY();
          const withinWheelSettleWindow = evaluateCaptureScrollClamp(
            requestedY, getMaxScrollY(), observedY, bottomTolerance, previousY
          ).settledNearTarget;
          if (targetY > previousY + 3 && !withinWheelSettleWindow &&
              performance.now() - start >= 350 && performance.now() - lastWheelFallbackAt >= 300 &&
              wheelFallbackAttempts < 6 && backgroundMode === "debugger") {
            wheelFallbackAttempts++;
            lastWheelFallbackAt = performance.now();
            const windowBeforeWheel = window.scrollY;
            const documentScroller = document.scrollingElement;
            const documentBeforeWheel = documentScroller?.scrollTop || 0;
            const liveScrollers = collectLiveCaptureScrollers(document);
            const candidatePositions = new Map(liveScrollers.map((element) => [element, element.scrollTop]));
            try {
              const wheelDeltaY = Math.max(160, targetY - getScrollY());
              const wheelResult = await chrome.runtime.sendMessage({
                type: "scroll-capture-by-wheel",
                jobId,
                // Use the exact point that the preflight proved scrollable.
                // The viewport center can hit a code block, toolbar, or a
                // different nested pane on ChatGPT and leave the main feed at 0.
                x: captureScrollInputPoint?.x ?? Math.round(viewportWidth * 0.68),
                y: captureScrollInputPoint?.y ?? Math.round(viewportHeight * 0.45),
                // ChatGPT may ignore scrollTop writes on its application shell.
                // Its verified wheel target can move by only ~2/3 of deltaY,
                // so send at least one full 160 px wheel quantum and retry
                // against the measured position until the requested overlap
                // is reached. Stitching always uses the resulting actualY.
                deltaY: wheelDeltaY
              });
              let movedCandidate = null;
              if (wheelResult?.ok) {
                await sleep(180);
                if (window.scrollY > windowBeforeWheel + 3) {
                  activeScroller = null;
                  activeScrollerIsReversed = false;
                } else if (documentScroller && documentScroller.scrollTop > documentBeforeWheel + 3) {
                  activeScroller = documentScroller;
                  activeScrollerIsReversed = isReverseCaptureScroller(activeScroller);
                } else {
                  movedCandidate = findMovedCaptureScroller(document, candidatePositions, 1);
                  if (movedCandidate) {
                    activeScroller = movedCandidate.element;
                    activeScrollerIsReversed = isReverseCaptureScroller(activeScroller);
                  }
                }
                observedY = getScrollY();
              }
              const largestChanges = [...candidatePositions.entries()]
                .map(([element, before]) => ({ element, before, after: element.scrollTop, delta: element.scrollTop - before }))
                .filter((item) => Math.abs(item.delta) > 2)
                .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8)
                .map((item) => ({ node: describeScroller(item.element), before: item.before, after: item.after, delta: item.delta }));
              sendProgress(jobId, null, "", "", { event: "wheel-fallback-attempt", attempt: wheelFallbackAttempts,
                responseOk: wheelResult?.ok === true, requestedY, beforeY: previousY, observedY,
                deltaY: wheelDeltaY, point: captureScrollInputPoint, windowBefore: windowBeforeWheel, windowAfter: window.scrollY,
                documentScrollerBefore: documentBeforeWheel, documentScrollerAfter: documentScroller?.scrollTop || 0,
                activeScrollerAfter: activeScroller ? describeScroller(activeScroller) : { node: "window", scrollY: window.scrollY },
                movedCandidate: movedCandidate ? describeScroller(movedCandidate.element) : null, changedNodes: largestChanges });
            } catch (error) {
              sendProgress(jobId, null, "", "", { event: "wheel-fallback-error", attempt: wheelFallbackAttempts,
                message: error?.message || String(error), stack: error?.stack || "" });
              console.warn("CDP 滾輪捲動備援失敗：", error);
            }
          }
          const currentPolicy = evaluateCaptureScrollClamp(
            requestedY, getMaxScrollY(), observedY, bottomTolerance, previousY
          );
          if (Math.abs(observedY - targetY) <= 3 || currentPolicy.settledNearTarget) {
            if (++settledFrames >= 3) break;
          } else settledFrames = 0;
        }
        const actualY = getScrollY();
        const currentMaxY = getMaxScrollY();
        sendProgress(jobId, null, "", "", { event: "scroll-settled", requestedY, targetY, actualY, currentMaxY,
          previousY, elapsedMs: Math.round(performance.now() - start), wheelFallbackAttempts,
          owner: activeScroller ? describeScroller(activeScroller) : { node: "window", scrollY: window.scrollY, range: currentMaxY },
          inputPoint: captureScrollInputPoint });
        // Browsers can clamp a requested final position by more than a fixed
        // pixel tolerance when lazy content changes the document height.
        // Accept the discrepancy only when the page really reached its live
        // maximum; a mid-page stall still fails closed.
        const scrollPolicy = evaluateCaptureScrollClamp(requestedY, currentMaxY, actualY, bottomTolerance, previousY);
        if (Math.abs(actualY - targetY) > 3 && !scrollPolicy.reachedBottom && !scrollPolicy.settledNearTarget) {
          const elementLabel = (element) => {
            const id = element?.id ? `#${element.id}` : "";
            const className = typeof element?.className === "string"
              ? `.${element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".")}` : "";
            return `${element?.tagName?.toLowerCase?.() || "element"}${id}${className}${element?.isConnected === false ? "（已脫離 DOM）" : ""}`;
          };
          const owner = activeScroller
            ? `${elementLabel(activeScroller)}（scrollTop ${Math.round(activeScroller.scrollTop)} / range ${Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight)}）`
            : `window（scrollY ${Math.round(window.scrollY)} / range ${Math.round(getMaxScrollY())}）`;
          throw new Error(`網頁沒有捲動到第 ${Math.round(targetY)} px（目前 ${Math.round(actualY)} px）；實際追蹤容器 ${owner}；滾輪重試 ${wheelFallbackAttempts}/6 次；背景模式 ${backgroundMode}；預檢：${scrollProbeDiagnostics}。已停止以免重複截取同一畫面。`);
        }
        if (scrollPolicy.reachedBottom || (requestedY > actualY + 3 && actualY >= currentMaxY - 3)) {
          bottomClampPx = Math.max(bottomClampPx, requestedY - actualY);
        }
        await sleep(100);
        return actualY;
      };

      // Fast path: take a short, reversible scroll probe. Only pages with no
      // table/grid/canvas content, no known Garmin app surface, and no DOM
      // mutations during the probe use the former ~70%-viewport stride.
      // All uncertain or data-heavy pages keep the conservative 180px stride
      // to protect virtualized rows and images from being skipped.
      const hasDataHeavyContent = Boolean(
        activeScroller || /(^|\.)garmin\.com$/i.test(location.hostname) ||
        document.querySelector("table,[role='grid'],[role='table'],canvas")
      );
      let fastStaticStride = false;
      if (!hasDataHeavyContent && scrollRange > captureStepHeight * 1.5 && "MutationObserver" in window) {
        const fastStride = Math.max(180, Math.floor(captureStepHeight * 0.7));
        let mutationSeen = false;
        const observer = new MutationObserver((records) => { if (records.length) mutationSeen = true; });
        // Ignore sticky-header style/class changes; they are not evidence that
        // article rows were virtualized. Text/node replacement still forces
        // the conservative stride.
        observer.observe(body, { subtree: true, childList: true, characterData: true });
        try {
          await scrollToAndWait(Math.min(fastStride, scrollRange));
        } finally {
          observer.disconnect();
        }
        await scrollToAndWait(0);
        if (!mutationSeen) {
          captureStepStride = fastStride;
          fastStaticStride = true;
        }
      }
      const steps = [];
      for (let y = 0; y < scrollRange; y += captureStepStride) steps.push(y);
      if (!steps.length || steps.at(-1) !== scrollRange) steps.push(scrollRange);
      const uniqueSteps = [...new Set(steps)];
      sendProgress(jobId, { done: 0, total: uniqueSteps.length, message: `已偵測${scrollDescription}，可捲動 ${Math.round(scrollRange)} px，共 ${uniqueSteps.length} 段…` },
        `已啟動完整頁面截圖：${scrollDescription}，${uniqueSteps.length} 段（${imageOptions.label}）；可關閉擴充功能視窗。`);
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
        const isLastPlannedSegment = i === uniqueSteps.length - 1;
        const frontierTarget = i === 0
          ? 0
          : getNextCaptureTarget(outputCoveredCss, captureViewportHeight, captureStepStride, i === 1);
        // Keep the preflight segment count as an estimate, but align every
        // interior capture to the pixels already covered. The last segment
        // still reaches the live page tail, including a page that expanded.
        const y = getPageCaptureTarget(frontierTarget, getMaxScrollY(), isLastPlannedSegment);
        sendProgress(jobId, { done: i, total: uniqueSteps.length, message: `擷取第 ${i + 1} / ${uniqueSteps.length} 段…` },
          `正在擷取完整網頁（${imageOptions.label}）…`);
        const actualY = await scrollToAndWait(y);
        // Never hide page elements while capturing. Position-based filtering
        // can classify virtualized table rows or charts as floating chrome,
        // which permanently removes real content from the exported image.
        // Repeated fixed UI is preferable to missing page data.

        // Static pages verified by the reversible probe need less paint time;
        // keep the longer delay on dynamic/unknown pages to avoid missing rows.
        await sleep(fastStaticStride ? 110 : 260);
        const captured = await captureSegmentWithRetry(jobId, windowId, segmentCaptureOptions, `第 ${i + 1} 段`);
        const image = await loadImage(captured.dataUrl);
        sendProgress(jobId, null, "", "", { event: "segment-captured", segment: i + 1, total: uniqueSteps.length,
          scrollY: actualY, image: { width: image.width, height: image.height }, outputCoveredCss,
          sourceOrigin: captured.source || "debugger-or-tab-capture", segmentFormat: "png-lossless" });
        const sourceRect = mapCaptureRectToPixels(captureRect, image.width, image.height, viewportWidth, viewportHeight);
        const sourceScaleY = sourceRect.scaleY;
        const sourceTopCss = i === 0 ? 0 : outputCoveredCss - actualY;
        if (isCoveredClampedTail(sourceTopCss, captureViewportHeight, outputCoveredCss, actualY, getMaxScrollY(), bottomClampPx)) {
          // At a short-clamped page tail this frame adds no pixels: the prior
          // tile already reaches the actual visible bottom. The reported max
          // may be a few pixels too large (e.g. 4099 vs 4068); skip this empty
          // overlap and let the verified tail-trim step use the covered edge.
          image.close?.();
          break;
        }
        if (sourceTopCss < -2 || sourceTopCss >= captureViewportHeight) {
          image.close?.();
          throw new Error(`拼接位置不連續（第 ${i + 1} 段：要求 ${Math.round(y)} px、實際 ${Math.round(actualY)} px、已覆蓋 ${Math.round(outputCoveredCss)} px、視窗 ${Math.round(captureViewportHeight)} px），已停止以免輸出缺列。`);
        }
        const firstTileLimit = i === 0
          ? (uniqueSteps.length === 1 || fastStaticStride ? Math.min(height, captureViewportHeight) : Math.max(1, captureViewportHeight - captureStepStride))
          : captureViewportHeight - sourceTopCss;
        const drawCssHeight = Math.min(firstTileLimit, captureViewportHeight - sourceTopCss, height - outputCoveredCss);
        if (drawCssHeight <= 0) { image.close?.(); break; }
        const sourcePixelTop = sourceRect.y + Math.round(Math.max(0, sourceTopCss) * sourceScaleY);
        const sourcePixelLeft = sourceRect.x;
        const sourcePixelWidth = Math.min(image.width - sourcePixelLeft, sourceRect.width);
        const sourcePixelHeight = Math.min(image.height - sourcePixelTop, Math.round(drawCssHeight * sourceScaleY));
        const destinationPixelHeight = Math.round(drawCssHeight * dpr);
        if (sourcePixelHeight <= 0 || destinationPixelHeight <= 0) {
          image.close?.();
          throw new Error(`第 ${i + 1} 段截圖高度無效，已停止以免下載不完整長圖。`);
        }
        if (chatGPTContentCapture && i === 0 && chatGPTSidebarWidth > 0) {
          const railHeightCss = Math.min(viewportHeight, height);
          const railWidthPixels = Math.min(image.width, Math.round(chatGPTSidebarWidth * sourceRect.scaleX));
          const railHeightPixels = Math.min(image.height, Math.round(railHeightCss * sourceScaleY));
          drawAcrossParts(image, 0, 0, railWidthPixels, railHeightPixels,
            0, 0, chatGPTSidebarWidth, railHeightCss, false);
          sendProgress(jobId, null, "", "", { event: "chatgpt-sidebar-preserved-once",
            width: chatGPTSidebarWidth, height: railHeightCss });
        }
        const mainDestinationX = chatGPTContentCapture ? chatGPTSidebarWidth : 0;
        drawAcrossParts(image, sourcePixelLeft, sourcePixelTop, sourcePixelWidth, sourcePixelHeight,
          mainDestinationX, outputCoveredCss, chatGPTContentCapture ? chatGPTLayout.contentWidth : width, drawCssHeight, true);
        outputCoveredCss += drawCssHeight;
        sendProgress(jobId, null, "", "", { event: "segment-stitched", segment: i + 1, total: uniqueSteps.length,
          drawCssHeight, outputCoveredCss, pageHeight: height, dimensions: { width: outputWidth, height: outputHeight } });
        image.close?.();
        await flushCompleteParts(outputCoveredCss);
        if (actualY >= getMaxScrollY() - 3 && outputCoveredCss >= captureViewportHeight + getMaxScrollY() - 2) {
          // The live page reached its bottom before the preflight segment
          // estimate. It has been fully covered, so do not revisit the same
          // viewport for the remaining stale planned tiles.
          break;
        }
      }

      // A page may report a taller preflight size, then settle to a shorter
      // live document as lazy/virtualized content finishes rendering. If the
      // final scroll was clamped at the actual document bottom and the height
      // delta matches that clamp, trim only the now-nonexistent tail. Keep the
      // captured pixels intact; do not synthesize or stretch image data.
      {
        const reportedLiveDocumentHeight = activeScroller
          ? captureViewportHeight + getMaxScrollY()
          : Math.max(root.scrollHeight, body.scrollHeight || 0, root.clientHeight);
        const nearClampedBottom = bottomClampPx > 0 && bottomClampPx <= 64 &&
          getScrollY() >= getMaxScrollY() - bottomClampPx - 3;
        const liveDocumentHeight = nearClampedBottom
          ? Math.min(reportedLiveDocumentHeight, getScrollY() + captureViewportHeight)
          : reportedLiveDocumentHeight;
        if (canTrimCaptureTail(height, liveDocumentHeight, outputCoveredCss, getScrollY(), getMaxScrollY(), bottomClampPx)) {
          height = liveDocumentHeight;
          const keepPartCount = Math.max(1, Math.ceil(height / partCssHeight));
          for (const droppedPart of canvases.splice(keepPartCount)) {
            if (droppedPart.canvas) { droppedPart.canvas.width = 1; droppedPart.canvas.height = 1; }
            droppedPart.canvas = null;
            droppedPart.ctx = null;
            droppedPart.mainBlob = null;
          }
          const lastPart = canvases.at(-1);
          if (lastPart && lastPart.startCss < height && lastPart.startCss + lastPart.heightCss > height) {
            const croppedCssHeight = height - lastPart.startCss;
            const croppedPixelHeight = Math.max(1, Math.round(croppedCssHeight * dpr));
            if (lastPart.canvas) {
              const croppedCanvas = document.createElement("canvas");
              croppedCanvas.width = outputWidth;
              croppedCanvas.height = croppedPixelHeight;
              const croppedContext = croppedCanvas.getContext("2d", { alpha: false });
              if (!croppedContext) throw new Error("無法整理頁尾截圖。");
              croppedContext.drawImage(lastPart.canvas, 0, 0, croppedCanvas.width, croppedCanvas.height,
                0, 0, croppedCanvas.width, croppedCanvas.height);
              lastPart.canvas.width = 1;
              lastPart.canvas.height = 1;
              lastPart.canvas = croppedCanvas;
              lastPart.ctx = croppedContext;
            } else if (lastPart.mainBlob) {
              const sourceBitmap = await createImageBitmap(lastPart.mainBlob);
              const croppedCanvas = document.createElement("canvas");
              croppedCanvas.width = outputWidth;
              croppedCanvas.height = croppedPixelHeight;
              const croppedContext = croppedCanvas.getContext("2d", { alpha: false });
              if (!croppedContext) throw new Error("無法整理頁尾截圖。");
              croppedContext.drawImage(sourceBitmap, 0, 0, outputWidth, croppedPixelHeight,
                0, 0, outputWidth, croppedPixelHeight);
              sourceBitmap.close?.();
              lastPart.mainBlob = await canvasToBlob(croppedCanvas, imageOptions.mimeType,
                imageOptions.captureFormat === "jpeg" ? imageOptions.quality / 100 : undefined);
              croppedCanvas.width = 1;
              croppedCanvas.height = 1;
            }
            lastPart.heightCss = croppedCssHeight;
          }
          bottomClampPx = 0;
        }
      }

      const bottomGap = height - outputCoveredCss;
      if (bottomGap > 2 && bottomClampPx > 0 && bottomGap <= bottomClampPx + 2) {
        if (activeScroller) throw new Error("內部捲動頁尾仍有像素未覆蓋；為避免裁掉資料，已取消下載。");
        const tailCapture = await captureSegmentWithRetry(jobId, windowId, {
          ...segmentCaptureOptions,
          ...(backgroundMode === "debugger" ? { clip: { x: 0, y: outputCoveredCss, width, height: bottomGap, scale: 1 } } : {})
        }, "頁尾補擷取");
        const tailImage = await loadImage(tailCapture.dataUrl);
        if (tailCapture.mode === "visible") {
          const sourceScale = tailImage.height / Math.max(1, viewportHeight);
          const sourceTop = Math.max(0, (outputCoveredCss - getScrollY()) * sourceScale);
          const sourceHeight = Math.min(tailImage.height - sourceTop, bottomGap * sourceScale);
          drawAcrossParts(tailImage, 0, sourceTop, tailImage.width, sourceHeight,
            0, outputCoveredCss, width, bottomGap, true);
        } else {
          drawAcrossParts(tailImage, 0, 0, tailImage.width, tailImage.height,
            0, outputCoveredCss, width, bottomGap, true);
        }
        outputCoveredCss += bottomGap;
        tailImage.close?.();
      }
      if (outputCoveredCss < height - 2) {
        throw new Error(`長圖只拼接到 ${Math.round(outputCoveredCss)} / ${Math.round(height)} px；已取消下載，請重試。`);
      }
      await flushCompleteParts(height);
      for (let index = 0; index < canvases.length; index++) {
        if (!canvases[index].mainBlob) throw new Error(`第 ${index + 1} 張長圖沒有內容，已停止避免輸出空白圖片。`);
      }
      const panelStrips = [];

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
          await sleep(fastStaticStride ? 110 : 260);
          const captured = await captureSegmentWithRetry(jobId, windowId, segmentCaptureOptions, `側欄第 ${index + 1} 段`);
          const image = await loadImage(captured.dataUrl);
          const sourceScaleX = image.width / Math.max(1, viewportWidth);
          const sourceScaleY = image.height / Math.max(1, viewportHeight);
          for (const panel of persistentSidePanelRegions) {
            const panelScrollTop = Math.min(panelY, panel.scrollRange);
            const sourceTopCss = panelY - panelScrollTop;
            const drawHeightCss = Math.min(viewportHeight - sourceTopCss, panel.contentHeight - panelY);
            if (drawHeightCss <= 0) continue;
            const stripCanvas = document.createElement("canvas");
            stripCanvas.width = Math.max(1, Math.round((panel.right - panel.left) * outputScaleX));
            stripCanvas.height = Math.max(1, Math.round(drawHeightCss * dpr));
            const stripContext = stripCanvas.getContext("2d", { alpha: false });
            if (!stripContext) throw new Error("無法建立側欄拼接畫布。");
            stripContext.fillStyle = panel.backgroundColor;
            stripContext.fillRect(0, 0, stripCanvas.width, stripCanvas.height);
            stripContext.drawImage(image,
              panel.left * sourceScaleX, sourceTopCss * sourceScaleY,
              (panel.right - panel.left) * sourceScaleX, drawHeightCss * sourceScaleY,
              0, 0, stripCanvas.width, stripCanvas.height);
            const stripBlob = await canvasToBlob(stripCanvas, "image/png");
            stripCanvas.width = 1;
            stripCanvas.height = 1;
            panelStrips.push({ panelIndex: persistentSidePanelRegions.indexOf(panel), y: panelY, heightCss: drawHeightCss, blob: stripBlob });
          }
          image.close?.();
          sendProgress(jobId, { done: index + 1, total: panelSteps.length, message: `側欄第 ${index + 1} / ${panelSteps.length} 段已拼接` },
            "正在拼接側欄內容…");
        }
      }

      const timestampLabel = timestamp();
      const downloads = [];
      for (let partIndex = 0; partIndex < canvases.length; partIndex++) {
        const part = canvases[partIndex];
        sendProgress(jobId, { done: partIndex, total: canvases.length, message: `正在產生第 ${partIndex + 1} / ${canvases.length} 張…` },
          canvases.length > 1 ? `完整頁面較長，將分成 ${canvases.length} 張圖片自動下載…` : "正在產生完整網頁圖片…");
        const finalCanvas = document.createElement("canvas");
        finalCanvas.width = outputWidth;
        finalCanvas.height = Math.max(1, Math.round(part.heightCss * dpr));
        const finalContext = finalCanvas.getContext("2d", { alpha: false });
        if (!finalContext) throw new Error(`無法整理第 ${partIndex + 1} 張長圖。`);
        const mainBitmap = await createImageBitmap(part.mainBlob);
        finalContext.drawImage(mainBitmap, 0, 0, finalCanvas.width, finalCanvas.height);
        mainBitmap.close?.();
        for (const strip of panelStrips) {
          const panel = persistentSidePanelRegions[strip.panelIndex];
          if (!panel) continue;
          const overlapTop = Math.max(strip.y, part.startCss);
          const overlapBottom = Math.min(strip.y + strip.heightCss, part.startCss + part.heightCss);
          if (overlapBottom <= overlapTop) continue;
          const stripBitmap = await createImageBitmap(strip.blob);
          const sourceScale = stripBitmap.height / strip.heightCss;
          const sourceY = (overlapTop - strip.y) * sourceScale;
          const sourceHeight = (overlapBottom - overlapTop) * sourceScale;
          finalContext.drawImage(stripBitmap, 0, sourceY, stripBitmap.width, sourceHeight,
            panel.left * outputScaleX, (overlapTop - part.startCss) * dpr,
            (panel.right - panel.left) * outputScaleX, (overlapBottom - overlapTop) * dpr);
          stripBitmap.close?.();
        }
        const blob = await canvasToBlob(finalCanvas, imageOptions.mimeType,
          imageOptions.captureFormat === "jpeg" ? imageOptions.quality / 100 : undefined);
        finalCanvas.width = 1;
        finalCanvas.height = 1;
        part.mainBlob = null;
        const partSuffix = canvases.length > 1 ? `_完整網頁_第${String(partIndex + 1).padStart(3, "0")}部分` : "_完整網頁";
        const filename = `HTML轉圖片/${safeFilename(title)}_${timestampLabel}${partSuffix}.${imageOptions.extension}`;
        const dataUrl = await blobToDataUrl(blob);
        const result = await transferImageForDownload(`${jobId}-${partIndex + 1}`, filename, dataUrl);
        sendProgress(jobId, null, "", "", { event: "download-started", filename, bytes: blob.size, downloadId: result?.downloadId });
        if (!result?.ok) throw new Error(result?.message || `第 ${partIndex + 1} 張圖片下載失敗。`);
        downloads.push(result);
        sendProgress(jobId, { done: partIndex + 1, total: canvases.length, message: `已下載第 ${partIndex + 1} / ${canvases.length} 張` },
          canvases.length > 1 ? `已下載 ${partIndex + 1} / ${canvases.length} 張完整頁面圖片…` : "正在完成下載…");
      }
      sendProgress(jobId, { done: canvases.length, total: canvases.length, message: "下載完成" },
        `完整網頁 ${imageOptions.label} 已自動下載${canvases.length > 1 ? ` ${canvases.length} 張分段圖片` : ""}，共拼接 ${uniqueSteps.length} 段。`, "ok");
    } finally {
      for (const panel of persistentSidePanelRegions) {
        if (!panel.scroller) continue;
        panel.scroller.style.scrollBehavior = panel.originalScrollBehavior;
      }
      for (const item of chatGPTHiddenUi) {
        if (!item.element?.style) continue;
        if (item.visibility) item.element.style.setProperty("visibility", item.visibility, item.priority || "");
        else item.element.style.removeProperty("visibility");
      }
      root.style.scrollBehavior = original.behavior || "";
      root.style.overflow = original.overflow || "";
      // Restore browser zoom before restoring the user's original scroll
      // coordinates; zoom can reflow the page and change its scroll range.
      if (debuggerSessionStarted) {
        try { await chrome.runtime.sendMessage({ type: "end-full-page-capture-session", jobId }); }
        catch (error) { console.warn("Could not release screenshot session:", error); }
        debuggerSessionStarted = false;
        if (zoomAdjustedForCapture) await sleep(220);
      }
      for (const panel of persistentSidePanelRegions) {
        if (panel.scroller) panel.scroller.scrollTop = panel.originalScrollTop;
      }
      if (activeScroller && scrollerOriginal) {
        activeScroller.style.scrollBehavior = scrollerOriginal.behavior || "";
        activeScroller.scrollTo(scrollerOriginal.x || 0, scrollerOriginal.y || 0);
      }
      window.scrollTo(original.x || 0, original.y || 0);
      for (const part of canvases) {
        if (part.canvas) { part.canvas.width = 1; part.canvas.height = 1; }
        part.mainBlob = null;
      }
      if (debuggerSessionStarted) {
        try { await chrome.runtime.sendMessage({ type: "end-full-page-capture-session", jobId }); }
        catch (error) { console.warn("Could not release screenshot session:", error); }
      }
    }
  }

  async function captureSegmentWithRetry(jobId, windowId, options, label) {
    let lastError = null;
    const maxAttempts = 6;
    let attempt = 1;
    while (true) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "capture-full-page-segment", jobId, windowId, options
        });
        if (!response?.ok || !response.dataUrl) throw new Error(response?.message || "瀏覽器沒有回傳截圖片段。");
        return response;
      } catch (error) {
        lastError = error;
        const reason = error?.message || String(error);
        if (reason.includes("[CAPTURE_WAITING_FOR_SOURCE_TAB]")) {
          sendProgress(jobId, null, "截圖暫停中：請切回原網頁；回到原分頁後會自動續跑並下載。", "warning");
          await sleep(1800);
          continue;
        }
        if (/請保持原網頁為目前分頁|權限|permission|受保護頁面/i.test(reason) || attempt === maxAttempts) break;
        const quotaLimited = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(reason);
        const delay = quotaLimited ? Math.min(8000, 1200 * attempt) : Math.min(5000, 700 * attempt);
        sendProgress(jobId, null, `${label}暫時無法擷取（${attempt}/${maxAttempts}），${Math.ceil(delay / 1000)} 秒後自動重試…`);
        await sleep(delay);
        attempt++;
      }
    }
    throw new Error(`${label}連續擷取失敗（已自動重試）：${lastError?.message || "瀏覽器未回傳截圖片段。"}`);
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
