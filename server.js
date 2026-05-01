const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const GENERATED_DIR = path.join(DATA_DIR, "generated");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const LOG_FILE = path.join(DATA_DIR, "generations.jsonl");
const RECORD_FILE = path.join(DATA_DIR, "records.jsonl");
const PROMPT_RECORD_FILE = path.join(DATA_DIR, "prompt-records.jsonl");
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FEISHU_OAUTH_AUTHORIZE_URL = "https://open.feishu.cn/open-apis/authen/v1/authorize";
const FEISHU_TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_USER_ACCESS_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token";
const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";

const sessions = new Map();
let writeChain = Promise.resolve();

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    const salt = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        admin: { username: "admin", salt, hash: hashPassword("1596357", salt) },
        adminUsers: [],
        feishuAuth: {
          enabled: false,
          appId: "",
          appSecret: "",
          redirectUri: `http://localhost:${PORT}/api/admin/feishu/callback`
        },
        apis: []
      }, null, 2)
    );
  }
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
}

function sanitizeFeishuAuth(input = {}) {
  return {
    enabled: input.enabled === true,
    appId: String(input.appId || "").trim(),
    appSecret: String(input.appSecret || "").trim(),
    redirectUri: String(input.redirectUri || `http://localhost:${PORT}/api/admin/feishu/callback`).trim()
  };
}

function sanitizeAdminUser(input = {}) {
  return {
    openId: String(input.openId || input.open_id || "").trim(),
    userId: String(input.userId || input.user_id || "").trim(),
    unionId: String(input.unionId || input.union_id || "").trim(),
    name: String(input.name || input.en_name || input.display_name || "").trim(),
    email: String(input.email || "").trim(),
    avatarUrl: String(input.avatarUrl || input.avatar_url || input.avatar_big || "").trim(),
    isSuperAdmin: input.isSuperAdmin !== false,
    addedAt: input.addedAt || new Date().toISOString(),
    addedBy: String(input.addedBy || "system").trim()
  };
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object") config = {};
  if (!config.admin || typeof config.admin !== "object") {
    const salt = crypto.randomBytes(16).toString("hex");
    config.admin = { username: "admin", salt, hash: hashPassword("1596357", salt) };
  }
  if (!Array.isArray(config.apis)) config.apis = [];
  if (!Array.isArray(config.llmApis)) config.llmApis = [];
  if (!Array.isArray(config.adminUsers)) config.adminUsers = [];
  config.adminUsers = config.adminUsers
    .map(sanitizeAdminUser)
    .filter((user) => user.openId || user.userId || user.unionId);
  config.feishuAuth = sanitizeFeishuAuth(config.feishuAuth || {});
  return config;
}

function readConfig() {
  ensureData();
  return normalizeConfig(JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, "utf8"))));
}

function saveConfig(config) {
  writeChain = writeChain.then(() =>
    fs.promises.writeFile(CONFIG_FILE, JSON.stringify(normalizeConfig(config), null, 2))
  );
  return writeChain;
}

function compactRecord(entry) {
  return {
    time: entry.time,
    visitor: entry.visitor,
    requestMode: entry.requestMode,
    clientId: entry.clientId,
    model: entry.model,
    modelId: entry.modelId,
    prompt: entry.prompt,
    aspect: entry.aspect,
    referenceName: entry.referenceName,
    referencePreviews: entry.referencePreviews,
    count: entry.count,
    outputs: entry.outputs,
    status: entry.status,
    error: entry.error
  };
}

function appendLog(entry) {
  const full = `${JSON.stringify(entry)}\n`;
  const compact = `${JSON.stringify(compactRecord(entry))}\n`;
  writeChain = writeChain.then(async () => {
    await fs.promises.appendFile(LOG_FILE, full);
    await fs.promises.appendFile(RECORD_FILE, compact);
  });
  return writeChain;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(payload);
}

function sendJson(res, status, body, headers = {}) {
  send(res, status, body, headers);
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 30 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("JSON 格式不正确"));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function createSession(payload) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
    ...payload
  });
  return token;
}

function createCookieHeader(token) {
  return `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`;
}

const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const pendingOAuthStates = new Map();

function saveOAuthState(state, returnTo) {
  const id = crypto.randomBytes(16).toString("hex");
  pendingOAuthStates.set(id, { state, returnTo: returnTo || "/prompt.html", expiresAt: Date.now() + OAUTH_STATE_MAX_AGE_MS });
  return id;
}

function consumeOAuthState(id) {
  if (!id || !pendingOAuthStates.has(id)) return null;
  const entry = pendingOAuthStates.get(id);
  pendingOAuthStates.delete(id);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

function sanitizeFeishuError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "飞书服务响应超时，请稍后重试";
  if (message.includes("econnrefused") || message.includes("enotfound")) return "无法连接飞书服务，请检查网络";
  if (message.includes("invalid_grant") || message.includes("code")) return "飞书授权码已失效，请重新登录";
  if (message.includes("配置不完整") || message.includes("appid")) return "飞书登录配置不完整";
  if (message.includes("租户")) return "飞书租户令牌获取失败";
  if (message.includes("用户")) return "飞书用户信息获取失败";
  return "飞书登录失败，请稍后重试";
}

function getSession(req) {
  const token = parseCookies(req).admin_session;
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  return { token, ...session };
}

function clearSession(req) {
  const token = parseCookies(req).admin_session;
  if (token) sessions.delete(token);
}

function isAuthed(req) {
  return Boolean(getSession(req));
}

function isAdminSession(session) {
  return Boolean(session && session.adminUser && (session.adminUser.isAdmin || session.adminUser.isSuperAdmin));
}

function requireUserSession(req, res) {
  const session = getSession(req);
  if (session) return session;
  sendJson(res, 401, { error: "请先完成飞书登录" });
  return null;
}

function requireAdmin(req, res) {
  const session = getSession(req);
  if (isAdminSession(session)) return true;
  sendJson(res, session ? 403 : 401, { error: session ? "需要管理员权限" : "请先完成飞书登录" });
  return false;
}

function requireAdminSession(req, res) {
  const session = getSession(req);
  if (isAdminSession(session)) return session;
  sendJson(res, session ? 403 : 401, { error: session ? "需要管理员权限" : "请先完成飞书登录" });
  return null;
}

function requireSuperAdmin(req, res) {
  const session = requireAdminSession(req, res);
  if (!session) return null;
  if (session.adminUser && session.adminUser.isSuperAdmin !== false) return session;
  sendJson(res, 403, { error: "只有超级管理员可以执行此操作" });
  return null;
}

function isLegacyAdminLoginEnabled(config) {
  return !(config.feishuAuth && config.feishuAuth.enabled);
}

function publicFeishuAuth(config) {
  const auth = sanitizeFeishuAuth(config.feishuAuth || {});
  return {
    enabled: auth.enabled,
    appId: auth.appId,
    appSecret: auth.appSecret ? "********" : "",
    redirectUri: auth.redirectUri,
    configured: Boolean(auth.appId && auth.appSecret && auth.redirectUri)
  };
}

function matchAdminUser(adminUser, profile = {}) {
  return Boolean(
    (adminUser.openId && adminUser.openId === String(profile.open_id || profile.openId || "")) ||
    (adminUser.userId && adminUser.userId === String(profile.user_id || profile.userId || "")) ||
    (adminUser.unionId && adminUser.unionId === String(profile.union_id || profile.unionId || ""))
  );
}

function findAdminUser(config, profile) {
  return (config.adminUsers || []).find((item) => matchAdminUser(item, profile)) || null;
}

function apiRequestMode(endpoint) {
  const text = String(endpoint || "").toLowerCase();
  return /\/images?\/edits?\/?$/.test(text) ? "edit" : "generation";
}

function publicApis(config) {
  return (config.apis || [])
    .filter((api) => api.enabled !== false)
    .map((api) => ({
      id: api.id,
      name: api.name,
      model: api.model,
      size: api.size || "1024x1024",
      requestMode: apiRequestMode(api.endpoint)
    }));
}

function ensureLlmApis(config) {
  if (!Array.isArray(config.llmApis)) config.llmApis = [];
  return config.llmApis;
}

function publicLlmApis(config) {
  return ensureLlmApis(config)
    .filter((api) => api.enabled !== false)
    .map((api) => ({
      id: api.id,
      name: api.name,
      model: api.model,
      endpoint: api.endpoint,
      temperature: Number(api.temperature ?? 0.4)
    }));
}

function sanitizeApi(api) {
  return {
    id: api.id || crypto.randomUUID(),
    name: String(api.name || "").trim(),
    model: String(api.model || "").trim(),
    endpoint: String(api.endpoint || "").trim(),
    apiKey: String(api.apiKey || "").trim(),
    size: String(api.size || "1024x1024").trim(),
    enabled: api.enabled !== false
  };
}

function validateApi(api) {
  if (!api.name) return "模型显示名称不能为空";
  if (!api.model) return "模型 ID 不能为空";
  if (!api.endpoint) return "API 地址不能为空";
  if (!api.apiKey) return "API Key 不能为空";
  return "";
}

function sanitizeLlmApi(api) {
  return {
    id: api.id || crypto.randomUUID(),
    name: String(api.name || "").trim(),
    model: String(api.model || "").trim(),
    endpoint: String(api.endpoint || "").trim(),
    apiKey: String(api.apiKey || "").trim(),
    temperature: Number(api.temperature ?? 0.4),
    enabled: api.enabled !== false
  };
}

function validateLlmApi(api) {
  if (!api.name) return "LLM 显示名称不能为空";
  if (!api.model) return "LLM 模型 ID 不能为空";
  if (!api.endpoint) return "LLM API 地址不能为空";
  if (!api.apiKey) return "LLM API Key 不能为空";
  return "";
}

function valueList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return [String(value)];
}

function cleanHeaderValue(value, fieldName) {
  const text = String(value || "").normalize("NFKC").replace(/^Bearer\s+/i, "").trim();
  for (const char of text) {
    if (char.charCodeAt(0) > 255) {
      throw new Error(`${fieldName} 包含不能用于 HTTP 请求头的字符：${char}。请检查是否复制了中文括号、中文说明或多余空格。`);
    }
  }
  return text;
}

function authHeaders(api, extra = {}) {
  const apiKey = cleanHeaderValue(api.apiKey, "API Key");
  return {
    ...extra,
    Authorization: `Bearer ${apiKey}`
  };
}

function isGptImageModel(model) {
  return /^gpt-image-/i.test(String(model || ""));
}

function imageEndpointFor(endpoint, action) {
  try {
    const url = new URL(endpoint);
    const basePath = url.pathname.replace(/\/images?\/(?:generations|edits)\/?$/i, "").replace(/\/$/, "");
    url.pathname = `${basePath}/images/${action}`;
    return url.toString();
  } catch {
    const base = String(endpoint || "").replace(/\/images?\/(?:generations|edits)\/?$/i, "").replace(/\/$/, "");
    return `${base}/images/${action}`;
  }
}

function dataUrlToFile(dataUrl, index) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1] || "image/png";
  const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "png";
  return {
    bytes: Buffer.from(match[2], "base64"),
    mime,
    name: `reference-${index + 1}.${ext}`
  };
}

async function callGptImageEdit(api, prompt, refs, size) {
  const form = new FormData();
  form.append("model", api.model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);

  let imageCount = 0;
  refs.forEach((ref, index) => {
    const file = dataUrlToFile(ref, index);
    if (file) {
      form.append("image", new Blob([file.bytes], { type: file.mime }), file.name);
      imageCount += 1;
    } else if (/^https?:\/\//i.test(ref)) {
      form.append("image_url", ref);
      imageCount += 1;
    }
  });
  if (!imageCount) return [];

  const endpoint = imageEndpointFor(api.endpoint, "edits");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(api),
    body: form
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.message || text || `HTTP ${response.status}`);
  }
  const directImages = extractImages(payload);
  return directImages.length ? directImages : await pollGenerationTaskAt(api, payload, endpoint);
}

async function uploadReferenceImage(api, dataUrl, index) {
  const file = dataUrlToFile(dataUrl, index);
  if (!file) return "";
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.mime }), file.name);
  form.append("purpose", "generation");
  const response = await fetch(uploadEndpointFor(api.endpoint), {
    method: "POST",
    headers: authHeaders(api),
    body: form
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error?.message || payload.message || text || `上传参考图失败 HTTP ${response.status}`);
  }
  const url = payload.data?.url || payload.url || payload.image_url;
  if (!url) throw new Error("参考图上传成功，但未返回图片 URL");
  return url;
}

async function getReferenceImageUrls(api, refs) {
  const urls = [];
  for (const [index, ref] of refs.entries()) {
    if (/^https?:\/\//i.test(ref)) urls.push(ref);
    else if (/^data:image\//i.test(ref)) urls.push(await uploadReferenceImage(api, ref, index));
  }
  return urls;
}

function referencePreviews(names, references) {
  const nameList = String(names || "").split("、");
  return valueList(references).map((_, index) => ({
    name: nameList[index] || `参考图 ${index + 1}`,
    label: `参考图 ${index + 1}`,
    src: ""
  }));
}

function sanitizeReferencePreviews(value, names, references) {
  const fallback = referencePreviews(names, references);
  const previews = Array.isArray(value) ? value : [];
  return fallback.map((item, index) => {
    const incoming = previews[index] || {};
    const src = typeof incoming.src === "string" && incoming.src.length <= 200000 ? incoming.src : "";
    return {
      name: String(incoming.name || item.name || `参考图 ${index + 1}`),
      label: String(incoming.label || item.label || `参考图 ${index + 1}`),
      src
    };
  });
}

function extractImages(result) {
  const images = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      if (/^(https?:\/\/|data:image\/)/i.test(value)) images.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object") {
      ["url", "image", "image_url", "output_url", "b64_json"].forEach((key) => {
        if (key === "b64_json" && value[key]) images.push(`data:image/png;base64,${value[key]}`);
        else visit(value[key]);
      });
      ["data", "images", "output", "outputs", "result"].forEach((key) => visit(value[key]));
    }
  };
  visit(result);
  return [...new Set(images)];
}

function taskIdFromPayload(payload) {
  return payload.id || payload.task_id || payload.data?.id || payload.data?.task_id || payload.data?.[0]?.task_id || "";
}

async function pollGenerationTask(api, payload) {
  return pollGenerationTaskAt(api, payload, api.endpoint);
}

async function pollGenerationTaskAt(api, payload, endpoint) {
  const taskId = taskIdFromPayload(payload);
  if (!taskId) return [];
  const statusUrl = `${String(endpoint).replace(/\/$/, "")}/${encodeURIComponent(taskId)}`;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(statusUrl, { headers: authHeaders(api) });
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = { raw: text };
    }
    if (!response.ok) throw new Error(result.error?.message || result.message || text || `查询任务失败 HTTP ${response.status}`);
    const images = extractImages(result);
    if (images.length) return images;
    if (result.status === "failed") {
      throw new Error(result.error?.message || result.fail_reason || result.message || "生成任务失败");
    }
  }
  throw new Error("生成任务超时，请稍后在记录中查看或重试");
}

async function persistGeneratedImages(images) {
  ensureData();
  const saved = [];
  for (const [index, src] of images.entries()) {
    const match = String(src || "").match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) {
      saved.push(src);
      continue;
    }
    const mime = match[1] || "image/png";
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
    const fileName = `${Date.now()}-${crypto.randomUUID()}-${index + 1}.${ext}`;
    await fs.promises.writeFile(path.join(GENERATED_DIR, fileName), Buffer.from(match[2], "base64"));
    saved.push(`/generated/${fileName}`);
  }
  return saved;
}

async function callImageApi(api, prompt, references, count) {
  const outputs = [];
  const refs = valueList(references);
  const total = Math.max(1, Math.min(9, Number(count) || 1));
  const gptImage = isGptImageModel(api.model);
  const requestSize = api.size || "1024x1024";

  for (let i = 1; i <= total; i += 1) {
    const promptToSend = total > 1
      ? `${prompt}\n生成第 ${i} 张图：保持同一主题和比例，构图、细节和镜头语言做自然变化。`
      : prompt;
    if (gptImage && refs.length) {
      outputs.push(...await callGptImageEdit(api, promptToSend, refs, requestSize));
      continue;
    }
    const body = {
      model: api.model,
      prompt: promptToSend,
      n: 1,
      size: requestSize
    };
    if (!gptImage) {
      body.response_format = "url";
      body.stream = false;
      body.watermark = true;
      body.sequential_image_generation = "disabled";
    }
    if (!gptImage) {
      if (refs.length === 1) body.image = refs[0];
      if (refs.length > 1) body.image = refs;
    }

    const endpoint = gptImage ? imageEndpointFor(api.endpoint, "generations") : api.endpoint;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: authHeaders(api, { "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.message || text || `HTTP ${response.status}`);
    }
    const directImages = extractImages(payload);
    outputs.push(...(directImages.length ? directImages : await pollGenerationTaskAt(api, payload, endpoint)));
  }

  if (!outputs.length) throw new Error("API 返回成功，但未找到图片 URL 或 base64 图片字段");
  return outputs;
}

function chatEndpointFor(endpoint) {
  const text = String(endpoint || "").trim();
  if (!text) return "";
  if (/\/responses\/?$/i.test(text)) return text;
  if (/\/chat\/completions\/?$/i.test(text)) return text;
  if (/\/v1\/?$/i.test(text)) return `${text.replace(/\/$/, "")}/chat/completions`;
  return `${text.replace(/\/$/, "")}/chat/completions`;
}

function promptSystemText(mode) {
  if (mode === "edit") {
    return `你是图像任务 Prompt 编排器。你不会生成图片，只输出结构化 prompt 文本。当前模式是 edit。必须只输出 1 张卡片，内容为自然语言 Prompt，用于直接改图。输出必须是严格 JSON：{"cards":[{"title":"","subtitle":"","content":""}]}。不要输出 markdown 代码块，不要输出额外解释。卡片 content 只能是自然语言 Prompt，不要输出 JSON，不要输出字段名。Prompt 要清楚表达基于上传原图进行局部修改、保留什么、修改什么、未提及区域不变、光影材质边缘自然融合、负向约束。`;
  }
  if (mode === "reference") {
    return `你是图像任务 Prompt 编排器。你不会生成图片，只输出结构化 prompt 文本。当前模式是 reference。必须只输出 1 张卡片，内容为自然语言 Prompt，用于参考图生图。输出必须是严格 JSON：{"cards":[{"title":"","subtitle":"","content":""}]}。不要输出 markdown 代码块，不要输出额外解释。卡片 content 只能是自然语言 Prompt，不要输出 JSON，不要输出字段名。Prompt 要清楚表达参考图如何使用、主体、风格、构图、材质、特效和负向约束。`;
  }
  return `你是图像任务 Prompt 编排器。你不会生成图片，只输出结构化 prompt 文本。当前模式是 text。必须只输出 1 张卡片，内容为自然语言 Prompt，用于纯文生图。输出必须是严格 JSON：{"cards":[{"title":"","subtitle":"","content":""}]}。不要输出 markdown 代码块，不要输出额外解释。卡片 content 只能是自然语言 Prompt，不要输出 JSON，不要输出字段名。`;
}

function assistantContentText(payload) {
  if (payload?.output_text) return String(payload.output_text);
  if (Array.isArray(payload?.output)) {
    const parts = [];
    for (const output of payload.output) {
      for (const item of output.content || []) {
        if (item.text) parts.push(String(item.text));
        else if (item.content) parts.push(String(item.content));
      }
    }
    if (parts.length) return parts.join("\n").trim();
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text || part.content || "").filter(Boolean).join("\n").trim();
  return "";
}

function parsePromptCards(text) {
  let raw = String(text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [{ title: "模型返回 Prompt", subtitle: "模型未返回标准 JSON，已保留原始文本", content: String(text || "").trim() }];
  }
  return (payload.cards || [])
    .filter((card) => card.title && card.content)
    .map((card) => ({ title: String(card.title), subtitle: String(card.subtitle || ""), content: String(card.content) }));
}

async function callPromptLlm(api, body) {
  const endpoint = chatEndpointFor(api.endpoint);
  if (!endpoint) throw new Error("LLM API 地址不能为空");
  const isResponsesApi = /\/responses\/?$/i.test(endpoint);
  const content = [{
    type: "text",
    text: [
      `mode: ${body.mode || "text"}`,
      `aspectRatio: ${body.aspectRatio || "16:9"}`,
      `styleTone: ${body.styleTone || ""}`,
      `description: ${body.description || ""}`,
      `preserve: ${valueList(body.preserve).join(" | ") || "无"}`,
      `negative: ${valueList(body.negative).join(" | ") || "无"}`,
      `imageCount: ${valueList(body.imageDataUrls).length || (body.imageDataUrl ? 1 : 0)}`
    ].join("\n")
  }];
  const imageUrls = valueList(body.imageDataUrls).length ? valueList(body.imageDataUrls) : valueList(body.imageDataUrl);
  imageUrls.forEach((imageUrl) => {
    content.push({ type: "image_url", image_url: { url: String(imageUrl) } });
  });
  let requestBody;
  if (isResponsesApi) {
    const responseContent = [{
      type: "input_text",
      text: `${promptSystemText(body.mode)}\n\n用户输入：\n${content[0].text}`
    }];
    imageUrls.forEach((imageUrl) => {
      responseContent.push({ type: "input_image", image_url: String(imageUrl) });
    });
    requestBody = {
      model: api.model,
      input: [{ role: "user", content: responseContent }]
    };
  } else {
    requestBody = {
      model: api.model,
      temperature: Number(api.temperature ?? 0.4),
      messages: [
        { role: "system", content: promptSystemText(body.mode) },
        { role: "user", content }
      ],
      response_format: { type: "json_object" }
    };
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(api, { "Content-Type": "application/json; charset=utf-8" }),
    body: JSON.stringify(requestBody)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(payload.error?.message || payload.message || text || `HTTP ${response.status}`);
  const cards = parsePromptCards(assistantContentText(payload));
  if (!cards.length) throw new Error("LLM 已返回结果，但未能解析出有效 Prompt 卡片");
  return cards;
}

function readRecords() {
  if (!fs.existsSync(RECORD_FILE)) return [];
  const lines = stripBom(fs.readFileSync(RECORD_FILE, "utf8")).trim().split(/\r?\n/).filter(Boolean).slice(-100);
  return lines.map((line) => {
    if (line.length > 200000) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function readClientRecords(clientId) {
  return readRecords().filter((record) => record.clientId && record.clientId === clientId);
}

function appendPromptRecord(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  writeChain = writeChain.then(() => fs.promises.appendFile(PROMPT_RECORD_FILE, line));
  return writeChain;
}

function readPromptRecords() {
  if (!fs.existsSync(PROMPT_RECORD_FILE)) return [];
  const lines = stripBom(fs.readFileSync(PROMPT_RECORD_FILE, "utf8")).trim().split(/\r?\n/).filter(Boolean).slice(-200);
  return lines.map((line) => {
    if (line.length > 300000) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function readClientPromptRecords(clientId) {
  return readPromptRecords().filter((record) => record.clientId && record.clientId === clientId);
}

function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const safePath = path.normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");

  fs.readFile(filePath, (err, content) => {
    if (err) return send(res, 404, "Not found");
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(content);
  });
}

function serveGenerated(urlPath, res) {
  ensureData();
  const filePath = path.join(GENERATED_DIR, path.basename(urlPath));
  if (!filePath.startsWith(GENERATED_DIR) || !fs.existsSync(filePath)) return send(res, 404, "Not found");
  const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "public, max-age=604800",
    "Content-Length": content.length
  });
  res.end(content);
}

async function downloadImage(url, name, res) {
  if (/^\/generated\//i.test(String(url || ""))) {
    const filePath = path.join(GENERATED_DIR, path.basename(url));
    if (!filePath.startsWith(GENERATED_DIR) || !fs.existsSync(filePath)) return sendJson(res, 404, { error: "图片不存在" });
    const safeName = String(name || path.basename(filePath)).replace(/[\\/:*?"<>|]/g, "_");
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(safeName)}"`,
      "Cache-Control": "no-store",
      "Content-Length": content.length
    });
    return res.end(content);
  }
  if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: "下载地址无效" });
  const response = await fetch(url);
  if (!response.ok) return sendJson(res, 502, { error: `图片下载失败：HTTP ${response.status}` });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const safeName = String(name || "ai-image.png").replace(/[\\/:*?"<>|]/g, "_");
  res.writeHead(200, {
    "Content-Type": response.headers.get("content-type") || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(safeName)}"`,
    "Cache-Control": "no-store",
    "Content-Length": buffer.length
  });
  res.end(buffer);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.msg || data.message || data.error || `请求失败：${response.status}`);
  return data;
}

async function getFeishuTenantAccessToken(auth) {
  const data = await jsonRequest(FEISHU_TENANT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: auth.appId, app_secret: auth.appSecret })
  });
  if (data.code && data.code !== 0) throw new Error(data.msg || "飞书租户令牌获取失败");
  return data.tenant_access_token;
}

async function exchangeFeishuCode(auth, code) {
  const tenantAccessToken = await getFeishuTenantAccessToken(auth);
  const data = await jsonRequest(FEISHU_USER_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${tenantAccessToken}`
    },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: auth.redirectUri })
  });
  if (data.code && data.code !== 0) throw new Error(data.msg || "飞书授权码换取令牌失败");
  return data.data || {};
}

async function getFeishuUserInfo(userAccessToken) {
  const data = await jsonRequest(FEISHU_USER_INFO_URL, {
    headers: { Authorization: `Bearer ${userAccessToken}` }
  });
  if (data.code && data.code !== 0) throw new Error(data.msg || "飞书用户信息获取失败");
  return data.data || {};
}

function buildFeishuAuthorizeUrl(auth, state) {
  const url = new URL(FEISHU_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("app_id", auth.appId);
  url.searchParams.set("redirect_uri", auth.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "contact:user.id:readonly contact:user.email:readonly");
  url.searchParams.set("state", state);
  return url.toString();
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname.startsWith("/generated/")) {
      return serveGenerated(url.pathname, res);
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      return sendJson(res, 200, { models: publicApis(readConfig()) });
    }

    if (req.method === "GET" && url.pathname === "/api/llm-models") {
      return sendJson(res, 200, { models: publicLlmApis(readConfig()) });
    }

    if (req.method === "GET" && url.pathname === "/api/download") {
      if (!requireUserSession(req, res)) return;
      return downloadImage(url.searchParams.get("url"), url.searchParams.get("name"), res);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/session") {
      const session = getSession(req);
      if (!session) return sendJson(res, 200, { authed: false });
      return sendJson(res, 200, {
        authed: true,
        authType: session.authType || "legacy",
        adminUser: session.adminUser || null
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      clearSession(req);
      return sendJson(res, 200, { ok: true }, {
        "Set-Cookie": "admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/feishu/meta") {
      const config = readConfig();
      return sendJson(res, 200, { feishuAuth: publicFeishuAuth(config) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/feishu/login") {
      const config = readConfig();
      const auth = sanitizeFeishuAuth(config.feishuAuth);
      if (!auth.enabled) return sendJson(res, 400, { error: "管理员飞书登录尚未启用。" });
      if (!auth.appId || !auth.appSecret || !auth.redirectUri) {
        return sendJson(res, 400, { error: "飞书登录配置不完整，请先在管理员配置中补全。" });
      }
      const state = crypto.randomBytes(16).toString("hex");
      const returnTo = String(url.searchParams.get("returnTo") || "/prompt.html").trim();
      const stateId = saveOAuthState(state, returnTo);
      return sendJson(res, 200, { url: buildFeishuAuthorizeUrl(auth, state), stateId });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/feishu/callback") {
      const config = readConfig();
      const auth = sanitizeFeishuAuth(config.feishuAuth);
      const code = String(url.searchParams.get("code") || "").trim();
      const errorText = String(url.searchParams.get("error") || "").trim();
      const returnedState = String(url.searchParams.get("state") || "").trim();
      const stateId = String(url.searchParams.get("state_id") || "").trim();
      if (errorText) {
        return send(res, 302, "", { Location: "/prompt.html?admin_login_error=" + encodeURIComponent(errorText) });
      }
      if (!auth.enabled || !auth.appId || !auth.appSecret || !auth.redirectUri) {
        return send(res, 302, "", { Location: "/prompt.html?admin_login_error=" + encodeURIComponent("飞书登录配置不完整") });
      }
      if (!code) {
        return send(res, 302, "", { Location: "/prompt.html?admin_login_error=" + encodeURIComponent("缺少飞书授权码") });
      }
      const stateEntry = consumeOAuthState(stateId);
      if (stateId && !stateEntry) {
        return send(res, 302, "", { Location: "/prompt.html?admin_login_error=" + encodeURIComponent("登录状态已失效，请重新登录") });
      }
      const returnTo = stateEntry?.returnTo || "/prompt.html";
      if (stateEntry && returnedState !== stateEntry.state) {
        return send(res, 302, "", { Location: returnTo + "?admin_login_error=" + encodeURIComponent("登录状态校验失败，请重新登录") });
      }
      try {
        const tokenData = await exchangeFeishuCode(auth, code);
        const profile = await getFeishuUserInfo(tokenData.access_token || tokenData.user_access_token);
        let adminUser = findAdminUser(config, profile);
        if (!adminUser && config.adminUsers.length === 0) {
          adminUser = sanitizeAdminUser({
            openId: profile.open_id,
            userId: profile.user_id,
            unionId: profile.union_id,
            name: profile.name || profile.en_name || "首位飞书管理员",
            email: profile.email || "",
            avatarUrl: profile.avatar_big || profile.avatar_url || "",
            isAdmin: true,
            isSuperAdmin: true,
            addedBy: "first-feishu-login"
          });
          config.adminUsers.push(adminUser);
          await saveConfig(config);
        }
        const isAdmin = Boolean(adminUser);
        const displayUser = adminUser || sanitizeAdminUser({
          openId: profile.open_id,
          userId: profile.user_id,
          unionId: profile.union_id,
          name: profile.name || profile.en_name || "飞书用户",
          email: profile.email || "",
          avatarUrl: profile.avatar_big || profile.avatar_url || "",
          isSuperAdmin: false
        });
        const token = createSession({
          authType: "feishu",
          adminUser: {
            openId: displayUser.openId,
            userId: displayUser.userId,
            unionId: displayUser.unionId,
            name: displayUser.name || profile.name || profile.en_name || "飞书用户",
            email: displayUser.email || profile.email || "",
            avatarUrl: displayUser.avatarUrl || profile.avatar_big || profile.avatar_url || "",
            isAdmin,
            isSuperAdmin: isAdmin && displayUser.isSuperAdmin !== false
          }
        });
        return send(res, 302, "", {
          Location: returnTo + "?admin_login_success=1",
          "Set-Cookie": createCookieHeader(token)
        });
      } catch (error) {
        return send(res, 302, "", { Location: returnTo + "?admin_login_error=" + encodeURIComponent(sanitizeFeishuError(error)) });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      if (!requireUserSession(req, res)) return;
      const body = await getBody(req);
      const visitor = String(body.visitor || "").trim();
      const clientId = String(body.clientId || "").trim();
      const prompt = String(body.prompt || "").trim();
      const originalPrompt = String(body.originalPrompt || "").trim();
      const modelId = String(body.modelId || "").trim();
      const references = valueList(body.reference);
      const referenceName = String(body.referenceName || "").trim();
      const refPreviews = sanitizeReferencePreviews(body.referencePreviews, referenceName, references);
      const aspect = String(body.aspect || "").trim();
      const count = Math.max(1, Math.min(9, Number(body.count) || 1));
      if (!visitor) return sendJson(res, 400, { error: "请先填写访问者身份" });
      if (!prompt) return sendJson(res, 400, { error: "Prompt 不能为空" });

      const config = readConfig();
      const api = (config.apis || []).find((item) => item.id === modelId && item.enabled !== false);
      if (!api) return sendJson(res, 400, { error: "请选择可用的生图模型" });

      const startedAt = new Date().toISOString();
      try {
        const rawImages = await callImageApi(api, prompt, references, count);
        const images = await persistGeneratedImages(rawImages);
        await appendLog({
          time: startedAt,
          visitor,
          requestMode: apiRequestMode(api.endpoint),
          clientId,
          model: api.name,
          modelId: api.id,
          prompt: originalPrompt || prompt,
          aspect,
          referenceName: referenceName || "无",
          referencePreviews: refPreviews,
          count: images.length,
          outputs: images,
          status: "success"
        });
        return sendJson(res, 200, { images, image: images[0] });
      } catch (error) {
        await appendLog({
          time: startedAt,
          visitor,
          requestMode: apiRequestMode(api.endpoint),
          clientId,
          model: api.name,
          modelId: api.id,
          prompt: originalPrompt || prompt,
          aspect,
          referenceName: referenceName || "无",
          referencePreviews: refPreviews,
          count,
          outputs: [],
          status: "failed",
          error: error.message
        });
        return sendJson(res, 502, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/prompt-orchestrator/generate") {
      if (!requireUserSession(req, res)) return;
      const body = await getBody(req);
      const visitor = String(body.visitor || "").trim();
      const clientId = String(body.clientId || "").trim();
      const mode = String(body.mode || "text").trim();
      const modelId = String(body.modelId || "").trim();
      const description = String(body.description || "").trim();
      const styleTone = String(body.styleTone || "").trim();
      const aspectRatio = String(body.aspectRatio || "16:9").trim();
      const preserve = valueList(body.preserve);
      const negative = valueList(body.negative);
      const imageDataUrls = valueList(body.imageDataUrls);
      if (!imageDataUrls.length && body.imageDataUrl) imageDataUrls.push(String(body.imageDataUrl).trim());
      const imageDataUrl = imageDataUrls[0] || "";
      if (!visitor) return sendJson(res, 400, { error: "请先填写使用者名称" });
      if (!description) return sendJson(res, 400, { error: "请先填写需求描述" });
      if (!modelId) return sendJson(res, 400, { error: "请选择一个可用的 LLM 模型" });
      const config = readConfig();
      const api = ensureLlmApis(config).find((item) => item.id === modelId && item.enabled !== false);
      if (!api) return sendJson(res, 400, { error: "所选 LLM 模型不存在或已停用" });
      const startedAt = new Date().toISOString();
      try {
        const cards = await callPromptLlm(api, { mode, description, preserve, negative, styleTone, aspectRatio, imageDataUrls, imageDataUrl });
        await appendPromptRecord({
          time: startedAt,
          visitor,
          clientId,
          mode,
          model: api.name,
          modelId: api.id,
          description,
          styleTone,
          aspectRatio,
          preserve,
          negative,
          inputImagePreview: imageDataUrl.length <= 200000 ? imageDataUrl : "",
          inputImagePreviews: imageDataUrls.filter((item) => String(item).length <= 200000),
          cards,
          status: "success"
        });
        return sendJson(res, 200, { cards });
      } catch (error) {
        await appendPromptRecord({
          time: startedAt,
          visitor,
          clientId,
          mode,
          model: api.name,
          modelId: api.id,
          description,
          styleTone,
          aspectRatio,
          preserve,
          negative,
          inputImagePreview: imageDataUrl.length <= 200000 ? imageDataUrl : "",
          inputImagePreviews: imageDataUrls.filter((item) => String(item).length <= 200000),
          cards: [],
          status: "failed",
          error: error.message
        });
        return sendJson(res, 502, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await getBody(req);
      const config = readConfig();
      if (!isLegacyAdminLoginEnabled(config)) {
        return sendJson(res, 400, { error: "当前已启用飞书登录，请使用飞书登录管理员。" });
      }
      const ok = body.username === config.admin.username &&
        hashPassword(String(body.password || ""), config.admin.salt) === config.admin.hash;
      if (!ok) return sendJson(res, 401, { error: "管理员账号或密码错误" });
      const token = createSession({
        authType: "legacy",
        adminUser: { name: config.admin.username, isSuperAdmin: true }
      });
      return sendJson(res, 200, { ok: true }, {
        "Set-Cookie": createCookieHeader(token)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/config") {
      const session = requireAdminSession(req, res);
      if (!session) return;
      const config = readConfig();
      return sendJson(res, 200, {
        username: config.admin.username,
        feishuAuth: publicFeishuAuth(config),
        adminUsers: config.adminUsers,
        currentAdmin: session.adminUser || null,
        apis: (config.apis || []).map((api) => ({ ...api, apiKey: api.apiKey ? "********" : "" }))
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/llm-config") {
      const session = requireAdminSession(req, res);
      if (!session) return;
      const config = readConfig();
      return sendJson(res, 200, {
        username: config.admin.username,
        feishuAuth: publicFeishuAuth(config),
        adminUsers: config.adminUsers,
        currentAdmin: session.adminUser || null,
        llmApis: ensureLlmApis(config).map((api) => ({ ...api, apiKey: api.apiKey ? "********" : "" }))
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/records") {
      if (!requireAdmin(req, res)) return;
      return sendJson(res, 200, { records: readRecords().slice(-120) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/prompt-records") {
      if (!requireAdmin(req, res)) return;
      return sendJson(res, 200, { records: readPromptRecords().slice(-120) });
    }

    if (req.method === "GET" && url.pathname === "/api/records") {
      const clientId = String(url.searchParams.get("clientId") || "").trim();
      if (!clientId) return sendJson(res, 400, { error: "缺少本机记录标识" });
      return sendJson(res, 200, { records: readClientRecords(clientId) });
    }

    if (req.method === "GET" && url.pathname === "/api/prompt-records") {
      const clientId = String(url.searchParams.get("clientId") || "").trim();
      if (!clientId) return sendJson(res, 400, { error: "缺少本机记录标识" });
      return sendJson(res, 200, { records: readClientPromptRecords(clientId) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/apis") {
      if (!requireAdmin(req, res)) return;
      const body = await getBody(req);
      const config = readConfig();
      const incoming = sanitizeApi(body);
      const current = (config.apis || []).find((api) => api.id === incoming.id);
      if (incoming.apiKey === "********" && current) incoming.apiKey = current.apiKey;
      const problem = validateApi(incoming);
      if (problem) return sendJson(res, 400, { error: problem });
      config.apis = config.apis || [];
      const index = config.apis.findIndex((api) => api.id === incoming.id);
      if (index >= 0) config.apis[index] = incoming;
      else config.apis.push(incoming);
      await saveConfig(config);
      return sendJson(res, 200, { ok: true, api: { ...incoming, apiKey: "********" } });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/llm-apis") {
      if (!requireAdmin(req, res)) return;
      const body = await getBody(req);
      const config = readConfig();
      const incoming = sanitizeLlmApi(body);
      const current = ensureLlmApis(config).find((api) => api.id === incoming.id);
      if (incoming.apiKey === "********" && current) incoming.apiKey = current.apiKey;
      const problem = validateLlmApi(incoming);
      if (problem) return sendJson(res, 400, { error: problem });
      const index = config.llmApis.findIndex((api) => api.id === incoming.id);
      if (index >= 0) config.llmApis[index] = incoming;
      else config.llmApis.push(incoming);
      await saveConfig(config);
      return sendJson(res, 200, { ok: true, api: { ...incoming, apiKey: "********" } });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/apis/")) {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const config = readConfig();
      config.apis = (config.apis || []).filter((api) => api.id !== id);
      await saveConfig(config);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/llm-apis/")) {
      if (!requireAdmin(req, res)) return;
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const config = readConfig();
      config.llmApis = ensureLlmApis(config).filter((api) => api.id !== id);
      await saveConfig(config);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/password") {
      if (!requireAdmin(req, res)) return;
      const body = await getBody(req);
      const config = readConfig();
      if (!isLegacyAdminLoginEnabled(config)) {
        return sendJson(res, 400, { error: "已启用飞书登录后，不再支持修改本地管理员账号密码。" });
      }
      const ok = body.currentUsername === config.admin.username &&
        hashPassword(String(body.currentPassword || ""), config.admin.salt) === config.admin.hash;
      if (!ok) return sendJson(res, 401, { error: "当前管理员账号或密码错误" });
      const nextUsername = String(body.nextUsername || "").trim();
      const nextPassword = String(body.nextPassword || "");
      if (!nextUsername || nextPassword.length < 6) {
        return sendJson(res, 400, { error: "新账号不能为空，新密码至少 6 位" });
      }
      const salt = crypto.randomBytes(16).toString("hex");
      config.admin = { username: nextUsername, salt, hash: hashPassword(nextPassword, salt) };
      await saveConfig(config);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/feishu-config") {
      const session = requireSuperAdmin(req, res);
      if (!session) return;
      const body = await getBody(req);
      const config = readConfig();
      config.feishuAuth = sanitizeFeishuAuth({
        ...body,
        appSecret: body.appSecret === "********" ? config.feishuAuth.appSecret : body.appSecret
      });
      await saveConfig(config);
      return sendJson(res, 200, { ok: true, feishuAuth: publicFeishuAuth(config) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/admin-users") {
      const session = requireSuperAdmin(req, res);
      if (!session) return;
      const body = await getBody(req);
      const config = readConfig();
      const incoming = sanitizeAdminUser({ ...body, addedBy: session.adminUser?.name || "admin" });
      if (!incoming.openId && !incoming.userId && !incoming.unionId) {
        return sendJson(res, 400, { error: "请至少填写 open_id、user_id 或 union_id 之一。" });
      }
      const index = config.adminUsers.findIndex((item) => matchAdminUser(item, incoming));
      if (index >= 0) config.adminUsers[index] = { ...config.adminUsers[index], ...incoming };
      else config.adminUsers.push(incoming);
      await saveConfig(config);
      return sendJson(res, 200, { ok: true, adminUsers: config.adminUsers });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/admin-users/")) {
      const session = requireSuperAdmin(req, res);
      if (!session) return;
      const id = decodeURIComponent(url.pathname.split("/").pop() || "");
      const config = readConfig();
      config.adminUsers = config.adminUsers.filter((user) => ![user.openId, user.userId, user.unionId].includes(id));
      await saveConfig(config);
      return sendJson(res, 200, { ok: true, adminUsers: config.adminUsers });
    }

    if (req.method === "GET") return serveStatic(req, res);
    return send(res, 405, "Method not allowed");
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "服务器错误" });
  }
}

ensureData();
http.createServer(route).listen(PORT, "0.0.0.0", () => {
  console.log(`AI image admin site running at http://0.0.0.0:${PORT}`);
});
