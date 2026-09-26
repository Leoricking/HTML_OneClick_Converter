const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "onenote.js"), "utf8");
  const storage = {
    oneNoteAuth: {
      clientId: "11111111-1111-4111-8111-111111111111",
      accessToken: "test-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600000
    }
  };
  const requests = [];
  const context = {
    console,
    Blob,
    Uint8Array,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: require("crypto").webcrypto,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    chrome: {
      identity: { getRedirectURL: () => "https://test.chromiumapp.org/microsoft" },
      storage: { local: {
        get: async (key) => typeof key === "string" ? { [key]: storage[key] } : key,
        set: async (data) => Object.assign(storage, data),
        remove: async (key) => delete storage[key]
      } }
    },
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      const json = url.includes("/notebooks?")
        ? { value: [{ id: "nb1", displayName: "Rossi", isDefault: true }] }
        : url.includes("/sections?")
          ? { value: [{ id: "sec1", displayName: "運動" }] }
          : { id: "page1", title: "Test" };
      return { ok: true, status: url.includes("/pages") ? 201 : 200, json: async () => json };
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "onenote.js" });

  const notebooks = await vm.runInContext("OneNoteClient.listNotebooks()", context);
  assert.strictEqual(notebooks[0].displayName, "Rossi");
  const sections = await vm.runInContext('OneNoteClient.listSections("nb1")', context);
  assert.strictEqual(sections[0].displayName, "運動");
  await vm.runInContext('OneNoteClient.createHtmlPage("sec1", "<p>Hello</p>", "Page title")', context);
  await vm.runInContext('OneNoteClient.createImagePage("sec1", new Blob(["png"], {type:"image/png"}), {title:"Image",url:"https://example.com"})', context);

  const htmlRequest = requests.find((request) => request.init.headers?.["Content-Type"] === "text/html;charset=utf-8");
  assert(htmlRequest, "HTML page request missing");
  assert(String(htmlRequest.init.body).includes("<title>Page title</title>"), "page title wrapper missing");
  const imageRequest = requests.find((request) => String(request.init.headers?.["Content-Type"] || "").startsWith("multipart/form-data"));
  assert(imageRequest, "multipart image page request missing");
  const multipart = await imageRequest.init.body.text();
  assert(multipart.includes('name="Presentation"'), "Presentation part missing");
  assert(multipart.includes('name="image1"; filename="clip.png"'), "image part missing");
  assert.strictEqual((multipart.match(/name="image1"; filename=/g) || []).length, 1, "duplicate image disposition");

  console.log("OneNote client tests passed: notebook/section list, HTML page, multipart image page");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
