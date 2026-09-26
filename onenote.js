/* Microsoft Graph / OneNote client shared by the popup and service worker. */
const OneNoteClient = (() => {
  const AUTH_KEY = "oneNoteAuth";
  const CLIENT_ID_KEY = "oneNoteClientId";
  const SCOPES = "openid profile offline_access Notes.ReadWrite";
  const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
  const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

  function base64Url(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function randomValue(byteLength = 48) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function sha256Base64Url(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return base64Url(new Uint8Array(digest));
  }

  function redirectUri() {
    return chrome.identity.getRedirectURL("microsoft");
  }

  function validateClientId(clientId) {
    const value = String(clientId || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error("請輸入 Microsoft Entra 應用程式的有效 Client ID。");
    }
    return value;
  }

  async function tokenRequest(parameters) {
    const response = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams(parameters)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `Microsoft 登入失敗（HTTP ${response.status}）。`);
    }
    return data;
  }

  async function saveToken(data, clientId) {
    const previous = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] || {};
    const auth = {
      clientId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || previous.refreshToken || "",
      expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
      scope: data.scope || SCOPES
    };
    await chrome.storage.local.set({ [AUTH_KEY]: auth, [CLIENT_ID_KEY]: clientId });
    return auth;
  }

  async function signIn(rawClientId) {
    const clientId = validateClientId(rawClientId);
    const verifier = randomValue(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomValue(24);
    const callback = redirectUri();
    const url = new URL(`${AUTH_BASE}/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: callback,
      response_mode: "query",
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account"
    }).toString();

    const redirected = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
    if (!redirected) throw new Error("Microsoft 登入視窗已關閉。");
    const result = new URL(redirected);
    if (result.searchParams.get("state") !== state) throw new Error("Microsoft 登入狀態驗證失敗，請重試。");
    if (result.searchParams.get("error")) {
      throw new Error(result.searchParams.get("error_description") || result.searchParams.get("error"));
    }
    const code = result.searchParams.get("code");
    if (!code) throw new Error("Microsoft 沒有回傳授權碼。");
    const token = await tokenRequest({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      code_verifier: verifier,
      scope: SCOPES
    });
    return saveToken(token, clientId);
  }

  async function getStoredAuth() {
    return (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] || null;
  }

  async function getAccessToken() {
    const auth = await getStoredAuth();
    if (!auth?.clientId) throw new Error("請先登入 Microsoft，再選擇 OneNote 筆記本與節區。");
    if (auth.accessToken && Number(auth.expiresAt) > Date.now() + 120000) return auth.accessToken;
    if (!auth.refreshToken) throw new Error("Microsoft 登入已過期，請重新登入。");
    const token = await tokenRequest({
      client_id: auth.clientId,
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      scope: SCOPES
    });
    return (await saveToken(token, auth.clientId)).accessToken;
  }

  async function graphFetch(path, init = {}) {
    const token = await getAccessToken();
    const response = await fetch(`${GRAPH_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) }
    });
    if (!response.ok) {
      const data = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));
      const message = data?.error?.message || data?.message || `OneNote API 錯誤（HTTP ${response.status}）。`;
      if (response.status === 401) await chrome.storage.local.remove(AUTH_KEY);
      throw new Error(message);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async function listNotebooks() {
    const data = await graphFetch("/me/onenote/notebooks?$select=id,displayName,isDefault&$orderby=displayName");
    return Array.isArray(data?.value) ? data.value : [];
  }

  async function listSections(notebookId) {
    if (!notebookId) return [];
    const data = await graphFetch(`/me/onenote/notebooks/${encodeURIComponent(notebookId)}/sections?$select=id,displayName&$orderby=displayName`);
    return Array.isArray(data?.value) ? data.value : [];
  }

  function ensurePageHtml(html, title) {
    let value = String(html || "").trim();
    const safeTitle = String(title || "網頁剪藏")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    if (!/<html[\s>]/i.test(value)) value = `<!doctype html><html><head><title>${safeTitle}</title></head><body>${value}</body></html>`;
    if (!/<title[\s>]/i.test(value)) {
      value = /<head[\s>][^>]*>/i.test(value)
        ? value.replace(/<head([^>]*)>/i, `<head$1><title>${safeTitle}</title>`)
        : value.replace(/<html([^>]*)>/i, `<html$1><head><title>${safeTitle}</title></head>`);
    }
    return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  }

  async function createHtmlPage(sectionId, html, title) {
    if (!sectionId) throw new Error("請先選擇 OneNote 節區。");
    return graphFetch(`/me/onenote/sections/${encodeURIComponent(sectionId)}/pages`, {
      method: "POST",
      headers: { "Content-Type": "text/html;charset=utf-8" },
      body: ensurePageHtml(html, title)
    });
  }

  async function createImagePage(sectionId, imageBlob, options = {}) {
    if (!sectionId) throw new Error("請先選擇 OneNote 節區。");
    const boundary = `HtmlConverter_${randomValue(18)}`;
    const title = String(options.title || "區域截圖").replace(/[<>]/g, "");
    const url = String(options.url || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const note = String(options.note || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    const presentation = `<!doctype html><html><head><title>${title}</title></head><body>${url ? `<p>來源：<a href="${url}">${url}</a></p>` : ""}${note ? `<p>${note}</p>` : ""}<img src="name:image1" alt="${title}"></body></html>`;
    const mime = imageBlob.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const extension = mime === "image/jpeg" ? "jpg" : "png";
    const body = new Blob([
      `--${boundary}\r\nContent-Disposition: form-data; name="Presentation"\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${presentation}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="image1"; filename="clip.${extension}"\r\nContent-Type: ${mime}\r\n\r\n`,
      imageBlob,
      `\r\n--${boundary}--\r\n`
    ]);
    return graphFetch(`/me/onenote/sections/${encodeURIComponent(sectionId)}/pages`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body
    });
  }

  async function signOut() {
    await chrome.storage.local.remove(AUTH_KEY);
  }

  async function status() {
    const auth = await getStoredAuth();
    return { signedIn: Boolean(auth?.refreshToken || (auth?.accessToken && auth.expiresAt > Date.now())), clientId: auth?.clientId || "" };
  }

  return { redirectUri, signIn, signOut, status, getAccessToken, listNotebooks, listSections, createHtmlPage, createImagePage };
})();
