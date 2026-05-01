const state = {
  visitor: "",
  clientId: getClientId(),
  allModels: [],
  models: [],
  editingApi: null,
  references: [],
  canClearReferences: false,
  lastImages: [],
  records: [],
  userRecords: [],
  requestMode: "generation",
  promptFormat: "plain",
  promptDrafts: {
    plain: "",
    json: ""
  },
  adminUsers: [],
  feishuAuth: null,
  currentAdmin: null
};
const adminSessionKey = "adminSessionActive";
const recordModeCacheKey = "previewRecordModeCache";
const navType = globalThis.performance?.getEntriesByType?.("navigation")?.[0]?.type || "";
if (navType === "reload") {
  sessionStorage.removeItem(adminSessionKey);
}

const $ = (id) => document.getElementById(id);
const promptPlaceholders = {
  plain: "描述你想生成的画面、风格、光线、构图等",
  json: "此处粘贴json字段，将转为合适的请求格式发送至模型"
};

function getClientId() {
  let id = localStorage.getItem("clientId");
  if (!id) {
    id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("clientId", id);
  }
  return id;
}

function setStatus(id, message, isError = false) {
  const node = $(id);
  node.textContent = message || "";
  node.style.color = isError ? "#c93636" : "#647084";
}

function readRecordModeCache() {
  try {
    const raw = localStorage.getItem(recordModeCacheKey);
    const payload = raw ? JSON.parse(raw) : {};
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function writeRecordModeCache(cache) {
  localStorage.setItem(recordModeCacheKey, JSON.stringify(cache));
}

function recordCacheId(record) {
  return [record.time || "", record.modelId || record.model || "", record.prompt || ""].join("|");
}

function applyRecordModeCache(records) {
  const cache = readRecordModeCache();
  return (records || []).map((record) => {
    if (record.requestMode) return record;
    const cachedMode = cache[recordCacheId(record)];
    return cachedMode ? { ...record, requestMode: cachedMode } : record;
  });
}

function rememberLatestRecordMode(records, mode) {
  const sorted = [...(records || [])].sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  const latest = sorted[0];
  if (!latest) return records;
  const cache = readRecordModeCache();
  cache[recordCacheId(latest)] = mode;
  writeRecordModeCache(cache);
  latest.requestMode = mode;
  return records.map((record) => record === latest ? latest : (record.time === latest.time && record.modelId === latest.modelId && record.prompt === latest.prompt ? { ...record, requestMode: mode } : record));
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json; charset=utf-8", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("参考图读取失败"));
    reader.readAsDataURL(file);
  });
}

async function loadModels() {
  const data = await request("/api/models");
  state.allModels = data.models || [];
  renderModelOptions();
}

function renderModelOptions() {
  state.models = state.allModels.filter((model) => getApiModes(model).includes(state.requestMode));
  const select = $("modelSelect");
  const currentValue = select.value;
  select.innerHTML = "";

  if (!state.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = state.requestMode === "edit"
      ? "当前没有可用于 edit 改图的模型，请在管理员中配置"
      : "当前没有可用于 generation 生图的模型，请联系管理员配置";
    select.append(option);
    $("generateBtn").disabled = true;
    $("modelHint").textContent = "未配置当前模式的模型";
    return;
  }

  state.models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name} (${model.model})`;
    select.append(option);
  });
  select.value = state.models.some((model) => model.id === currentValue) ? currentValue : state.models[0].id;
  $("generateBtn").disabled = false;
  updateModelHint();
}

function updateModelHint() {
  const selected = state.models.find((model) => model.id === $("modelSelect").value);
  $("modelHint").textContent = selected
    ? `当前模型：${selected.name} · ${selected.size} · ${state.requestMode === "edit" ? "edit 改图" : "generation 生图"}`
    : "等待选择模型";
}

function inferRequestMode(api) {
  const modes = getApiModes(api);
  if (modes.length === 1) {
    return modes[0];
  }
  if (modes.includes("generation")) {
    return "generation";
  }
  if (api?.requestMode === "edit" || api?.requestMode === "generation") {
    return api.requestMode;
  }
  const endpointText = String(api?.endpoint || "");
  if (/\/images?\/(edit|edits)\/?$/i.test(endpointText)) return "edit";
  const nameText = `${api?.name || ""} ${api?.model || ""}`.toLowerCase();
  if (/\bedit\b/.test(nameText) || /-edit\b/.test(nameText)) return "edit";
  if (/\bgeneration\b/.test(nameText) || /\bgenerations\b/.test(nameText) || /-generations\b/.test(nameText)) return "generation";
  return "generation";
}

function getApiModes(api) {
  if (Array.isArray(api?.requestModes)) {
    return api.requestModes.filter((mode) => mode === "generation" || mode === "edit");
  }
  if (api?.requestMode === "edit") return ["edit"];
  if (api?.requestMode === "generation") return ["generation"];
  const endpointText = String(api?.endpoint || "");
  if (/\/images?\/(edit|edits)\/?$/i.test(endpointText)) return ["edit"];
  return ["generation"];
}

function getApiModesFromForm() {
  const modes = [];
  if ($("apiModeGeneration").checked) modes.push("generation");
  if ($("apiModeEdit").checked) modes.push("edit");
  return modes;
}

function formatApiModes(api) {
  const modes = getApiModes(api);
  if (!modes.length) return "未启用";
  if (modes.length === 2) return "双模式通用";
  return modes[0] === "edit" ? "edit 改图" : "generation 生图";
}

function getSelectedAspect() {
  return $("aspectSelect").value || "16:9 横向宽银幕构图";
}

function syncPromptDraft() {
  state.promptDrafts[state.promptFormat] = $("promptInput").value;
}

function renderPromptInput() {
  const input = $("promptInput");
  input.value = state.promptDrafts[state.promptFormat] || "";
  input.placeholder = promptPlaceholders[state.promptFormat];
  $("plainPromptBtn").classList.toggle("is-active", state.promptFormat === "plain");
  $("jsonPromptBtn").classList.toggle("is-active", state.promptFormat === "json");
  $("promptFormatSwitch").classList.toggle("is-second-active", state.promptFormat === "json");
}

function setPromptFormat(format) {
  if (!["plain", "json"].includes(format) || format === state.promptFormat) return;
  syncPromptDraft();
  state.promptFormat = format;
  renderPromptInput();
}

function setRequestMode(mode) {
  if (!["generation", "edit"].includes(mode) || mode === state.requestMode) return;
  state.requestMode = mode;
  $("generationModeBtn").classList.toggle("is-active", mode === "generation");
  $("editModeBtn").classList.toggle("is-active", mode === "edit");
  $("requestModeSwitch").classList.toggle("is-second-active", mode === "edit");
  $("referenceNote").textContent = mode === "edit"
    ? "edit 改图模式下，请先上传至少一张原图或参考图。"
    : (state.references.length
      ? `已选择 ${state.references.length} 张参考图，可在 prompt 中按编号描述。`
      : '可选，可在 prompt 中描述"参考图 1"的主体或"参考图 2"的风格。');
  renderModelOptions();
}

function listText(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizePromptFromJson(rawText, aspect) {
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error("JSON 输入格式无效，请先检查字段和逗号。");
  }

  const parts = [];
  if (payload.plain_prompt) {
    parts.push(String(payload.plain_prompt).trim());
  } else if (payload.task === "image_edit") {
    parts.push(`基于上传的原图进行修改，目标：${payload.goal || payload.edit_area?.target || "按要求调整"}。`);
    const keep = listText(payload.keep_unchanged);
    if (keep.length) parts.push(`保持以下内容不变：${keep.join("、")}。`);
    if (payload.edit_area?.target) parts.push(`重点修改区域：${payload.edit_area.target}。`);
    const repair = listText(payload.repair_instruction?.fill_with);
    if (repair.length) parts.push(`修改后请自然补齐并保持：${repair.join("、")}。`);
    const negative = listText(payload.negative_prompt);
    if (negative.length) parts.push(`避免：${negative.join("、")}。`);
  } else {
    if (payload.generate_target?.subject) parts.push(`生成主体：${payload.generate_target.subject}。`);
    if (payload.generate_target?.theme) parts.push(`主题方向：${payload.generate_target.theme}。`);
    const features = listText(payload.design_requirements?.features);
    if (features.length) parts.push(`关键设计点：${features.join("、")}。`);
    const negative = listText(payload.negative_prompt);
    if (negative.length) parts.push(`避免：${negative.join("、")}。`);
  }

  if (!parts.length) {
    parts.push(rawText);
  }

  const merged = parts.join("\n");
  return merged.includes("画面比例要求")
    ? merged
    : `${merged}\n\n画面比例要求：${aspect}。`;
}

function getPromptPayload(aspect) {
  const rawPrompt = $("promptInput").value.trim();
  if (!rawPrompt) {
    throw new Error(state.promptFormat === "json" ? "请先粘贴 JSON 字段。" : "请先填写 prompt。");
  }

  if (state.promptFormat === "json") {
    return {
      prompt: normalizePromptFromJson(rawPrompt, aspect),
      originalPrompt: rawPrompt
    };
  }

  return {
    prompt: `${rawPrompt}\n\n画面比例要求：${aspect}。`,
    originalPrompt: rawPrompt
  };
}

async function generateImage() {
  if (!state.loggedIn) {
    setStatus("statusText", "请先登录飞书~", true);
    return;
  }
  const modelId = $("modelSelect").value;
  const aspect = getSelectedAspect();
  const count = Number($("countSelect").value);
  if (!modelId) {
    setStatus("statusText", "请先选择一个已配置的模型。", true);
    return;
  }
  if (state.requestMode === "edit" && !state.references.length) {
    setStatus("statusText", "edit 改图模式下，请先上传至少一张原图或参考图。", true);
    return;
  }

  let promptPayload;
  try {
    promptPayload = getPromptPayload(aspect);
  } catch (error) {
    setStatus("statusText", error.message, true);
    return;
  }

  $("generateBtn").disabled = true;
  $("imageBox").innerHTML = '<div class="placeholder">正在生成图片，请稍候...</div>';
  setStatus("statusText", "任务已提交，正在调用生图 API。");

  try {
    renderLoadingPlaceholders(count, aspect);
    const data = await request("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        visitor: state.visitor,
        clientId: state.clientId,
        prompt: promptPayload.prompt,
        originalPrompt: promptPayload.originalPrompt,
        aspect,
        count,
        requestMode: state.requestMode,
        promptFormat: state.promptFormat,
        reference: state.references.map((item) => item.data),
        referenceName: state.references.map((item) => item.name).join("、"),
        referencePreviews: state.references.map((item, index) => ({
          name: item.name,
          label: `参考图 ${index + 1}`,
          src: item.preview || ""
        })),
        modelId
      })
    });
    state.lastImages = data.images || (data.image ? [data.image] : []);
    renderOutput(state.lastImages);
    state.canClearReferences = true;
    updateClearReferencesButton();
    await loadUserRecords();
    state.userRecords = rememberLatestRecordMode(state.userRecords, state.requestMode);
    renderRecords(state.userRecords, "userRecordsList");
    setStatus("statusText", `生成完成，共 ${state.lastImages.length} 张，记录已写入后台。`);
  } catch (error) {
    $("imageBox").innerHTML = '<div class="placeholder">生成失败，请检查模型配置或 API 返回。</div>';
    setStatus("statusText", error.message, true);
  } finally {
    $("generateBtn").disabled = !state.models.length;
  }
}

function renderOutput(images) {
  if (!images.length) {
    $("imageBox").innerHTML = '<div class="placeholder">生成完成，但没有返回可展示的图片。</div>';
    return;
  }
  const grid = document.createElement("div");
  grid.className = "output-grid";
  grid.style.setProperty("--tile-ratio", getCssAspectRatio(getSelectedAspect()));
  images.forEach((src, index) => {
    const item = document.createElement("div");
    item.className = "output-item";
    const img = new Image();
    img.alt = `AI 生成图片 ${index + 1}`;
    img.src = src;
    const button = document.createElement("button");
    button.className = "download-button mini-download";
    button.type = "button";
    button.textContent = "下载";
    button.addEventListener("click", () => downloadImage(src, `ai-image-${index + 1}.png`));
    item.append(img, button);
    grid.append(item);
  });
  $("imageBox").replaceChildren(grid);
  $("downloadAllBtn").disabled = false;
}

function renderLoadingPlaceholders(count, aspect) {
  $("downloadAllBtn").disabled = true;
  const grid = document.createElement("div");
  grid.className = "output-grid";
  grid.style.setProperty("--tile-ratio", getCssAspectRatio(aspect));
  for (let i = 0; i < count; i++) {
    const item = document.createElement("div");
    item.className = "output-item loading-card";
    item.innerHTML = '<div class="loader" aria-label="正在生成"></div>';
    grid.append(item);
  }
  $("imageBox").replaceChildren(grid);
}

function getCssAspectRatio(aspect) {
  if (aspect.startsWith("1:1")) return "1 / 1";
  if (aspect.startsWith("16:9")) return "16 / 9";
  if (aspect.startsWith("4:3")) return "4 / 3";
  if (aspect.startsWith("9:16")) return "9 / 16";
  if (aspect.startsWith("3:4")) return "3 / 4";
  return "16 / 9";
}

async function downloadAllImages() {
  for (const [index, src] of state.lastImages.entries()) {
    await downloadImage(src, `ai-image-${index + 1}.png`);
  }
}

function getDownloadHref(src, name) {
  if (src.startsWith("data:")) return src;
  return `/api/download?url=${encodeURIComponent(src)}&name=${encodeURIComponent(name)}`;
}

async function downloadImage(src, name) {
  if (src.startsWith("data:")) {
    triggerBlobDownload(src, name);
    return;
  }
  const response = await fetch(getDownloadHref(src, name));
  if (!response.ok) {
    const message = await response.text().catch(() => "下载失败");
    throw new Error(message || "下载失败");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  triggerBlobDownload(objectUrl, name);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

function triggerBlobDownload(href, name) {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

async function fetchVisitorFromSession() {
  try {
    const session = await request("/api/admin/session");
    if (session.authed) {
      const admin = session.adminUser || null;
      state.visitor = admin?.name || admin?.openId || "";
      state.loggedIn = true;
    }
  } catch (_) {}
  const btn = $("generateBtn");
  if (!state.loggedIn) {
    btn.disabled = true;
    btn.title = "请先登录飞书~";
  } else {
    btn.disabled = false;
    btn.title = "";
  }
}

async function openAdmin() {
  $("adminDialog").showModal();
  setStatus("loginStatus", "");
  showAdminPanel();
  try {
    await loadAdminConfig();
  } catch (_) {}
  loadRecords().catch(() => {});
}

function showAdminLogin() {
  $("loginForm").classList.remove("hidden");
  $("adminPanel").classList.add("hidden");
  syncAdminVisibility();
}

function showAdminPanel() {
  $("loginForm").classList.add("hidden");
  $("adminPanel").classList.remove("hidden");
}

function renderCurrentAdmin() {
  const admin = state.currentAdmin;
  $("currentAdminInfo").textContent = admin
    ? "当前管理员：" + (admin.name || admin.openId || admin.userId || "未命名") + (admin.isSuperAdmin === false ? "（普通管理员）" : "（超级管理员）")
    : "当前未识别到管理员信息";
}

function renderAdminUsers() {
  const list = $("adminUsersList");
  if (!state.adminUsers.length) {
    list.innerHTML = '<p class="empty-text">还没有配置飞书管理员，请先添加至少一位。</p>';
    return;
  }
  list.innerHTML = state.adminUsers.map((user) => {
    const key = user.openId || user.userId || user.unionId;
    return '<article class="api-item"><div><strong>' + escapeHtml(user.name || key || "未命名管理员") + '</strong><div class="muted">Open ID：' + escapeHtml(user.openId || "-") + '</div><div class="muted">User ID：' + escapeHtml(user.userId || "-") + '</div><div class="muted">邮箱：' + escapeHtml(user.email || "-") + '</div><div class="muted">角色：' + (user.isSuperAdmin === false ? "普通管理员" : "超级管理员") + '</div></div><div class="api-actions"><button class="compact danger" type="button" data-delete-admin="' + escapeHtml(key) + '">移除</button></div></article>';
  }).join("");
}

function syncFeishuLoginView() {
  const enabled = state.feishuAuth?.enabled !== false;
  $("feishuLoginBtn").classList.toggle("hidden", !enabled);
  $("legacyLoginFields").classList.toggle("hidden", enabled);
  $("legacyLoginBtn").classList.toggle("hidden", enabled);
}

function syncAdminVisibility() {
  const isAdmin = Boolean(state.currentAdmin?.isAdmin || state.currentAdmin?.isSuperAdmin);
  const isSuperAdmin = Boolean(state.currentAdmin) && state.currentAdmin.isSuperAdmin !== false && isAdmin;
  $("feishuConfigSection").classList.toggle("hidden", !isSuperAdmin);
  $("adminUsersSection").classList.toggle("hidden", !isSuperAdmin);
}

async function loginAdmin(event) {
  event.preventDefault();
  setStatus("loginStatus", "正在登录...");
  try {
    await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: $("adminUser").value.trim(), password: $("adminPass").value })
    });
    sessionStorage.setItem(adminSessionKey, "1");
    state.loggedIn = true;
    state.visitor = $("adminUser").value.trim();
    $("generateBtn").disabled = false;
    $("generateBtn").title = "";
    showAdminPanel();
    setStatus("loginStatus", "");
    loadAdminConfig().catch((error) => {
      sessionStorage.removeItem(adminSessionKey);
      showAdminLogin();
      setStatus("loginStatus", error.message, true);
    });
    loadRecords().catch(() => {});
  } catch (error) {
    setStatus("loginStatus", error.message, true);
  }
}

async function loadAdminMeta() {
  const data = await request("/api/admin/feishu/meta");
  state.feishuAuth = data.feishuAuth || null;
  syncFeishuLoginView();
}

async function beginFeishuLogin() {
  setStatus("loginStatus", "正在跳转到飞书登录...");
  const data = await request("/api/admin/feishu/login?returnTo=" + encodeURIComponent("/image.html"));
  window.location.href = data.url;
}

async function logoutAdmin() {
  await request("/api/admin/logout", { method: "POST" });
  sessionStorage.removeItem(adminSessionKey);
  state.currentAdmin = null;
  state.loggedIn = false;
  state.visitor = "";
  $("generateBtn").disabled = true;
  $("generateBtn").title = "请先登录飞书~";
  showAdminLogin();
  setStatus("loginStatus", "已退出管理员登录。");
}

async function saveFeishuConfig(event) {
  event.preventDefault();
  $("feishuConfigStatus").textContent = "保存中...";
  try {
    await request("/api/admin/feishu-config", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("feishuEnabled").checked,
        appId: $("feishuAppId").value,
        appSecret: $("feishuAppSecret").value || "********",
        redirectUri: $("feishuRedirectUri").value
      })
    });
    $("feishuConfigStatus").textContent = "飞书配置已保存。";
    await loadAdminConfig();
  } catch (error) {
    $("feishuConfigStatus").textContent = error.message;
  }
}

async function saveAdminUser(event) {
  event.preventDefault();
  $("adminUserStatus").textContent = "保存中...";
  try {
    const data = await request("/api/admin/admin-users", {
      method: "POST",
      body: JSON.stringify({
        name: $("adminUserName").value,
        openId: $("adminUserOpenId").value,
        userId: $("adminUserUserId").value,
        unionId: $("adminUserUnionId").value,
        email: $("adminUserEmail").value,
        isSuperAdmin: $("adminUserSuperAdmin").checked
      })
    });
    state.adminUsers = data.adminUsers || [];
    renderAdminUsers();
    $("adminUserStatus").textContent = "管理员名单已更新。";
    $("adminUserForm").reset();
    $("adminUserSuperAdmin").checked = true;
  } catch (error) {
    $("adminUserStatus").textContent = error.message;
  }
}

async function checkAdminSessionAfterRedirect() {
  const params = new URLSearchParams(window.location.search);
  const success = params.get("admin_login_success");
  const error = params.get("admin_login_error");
  if (!success && !error) return;
  const cleanUrl = window.location.pathname + (window.location.hash || "");
  window.history.replaceState({}, document.title, cleanUrl);
  if (error) {
    showAdminLogin();
    setStatus("loginStatus", error);
    $("adminDialog").showModal();
    return;
  }
  try {
    const session = await request("/api/admin/session");
    if (session.authed) {
      sessionStorage.setItem(adminSessionKey, "1");
      state.currentAdmin = session.adminUser || null;
      showAdminPanel();
      renderCurrentAdmin();
      syncAdminVisibility();
      setStatus("loginStatus", "");
      $("adminDialog").showModal();
      if (state.currentAdmin?.isAdmin || state.currentAdmin?.isSuperAdmin) {
        await loadAdminConfig();
      }
    }
  } catch (sessionError) {
    setStatus("loginStatus", sessionError.message);
  }
}

async function loadAdminConfig() {
  const data = await request("/api/admin/config");
  $("currentUser").value = data.username || "";
  $("nextUser").value = data.username || "";
  state.adminUsers = data.adminUsers || [];
  state.feishuAuth = data.feishuAuth || null;
  state.currentAdmin = data.currentAdmin || null;
  $("feishuEnabled").checked = state.feishuAuth?.enabled !== false;
  $("feishuAppId").value = state.feishuAuth?.appId || "";
  $("feishuAppSecret").value = state.feishuAuth?.appSecret || "";
  $("feishuRedirectUri").value = state.feishuAuth?.redirectUri || "";
  renderCurrentAdmin();
  renderAdminUsers();
  syncFeishuLoginView();
  syncAdminVisibility();
  renderApis(data.apis || []);
  if (!$("recordsList").children.length) {
    $("recordsList").innerHTML = '<div class="placeholder">点击"刷新记录"加载管理员记录。</div>';
  }
}

function renderApis(apis) {
  const list = $("apiList");
  list.innerHTML = "";
  if (!apis.length) {
    list.innerHTML = '<div class="placeholder">尚未配置 API。新增后会立刻出现在生图模型选择框。</div>';
    return;
  }

  apis.forEach((api) => {
    const item = document.createElement("div");
    item.className = "api-item";
    const info = document.createElement("div");
    info.innerHTML = `<strong>${escapeHtml(api.name)}</strong><span>${escapeHtml(api.model)} · ${escapeHtml(formatApiModes(api))}</span>`;

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "compact";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => fillApiForm(api));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "compact danger";
    del.textContent = "删除";
    del.addEventListener("click", () => deleteApi(api.id));

    item.append(info, edit, del);
    list.append(item);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clearApiForm() {
  state.editingApi = null;
  $("apiForm").classList.remove("hidden");
  $("apiFormTitle").textContent = "新增模型";
  $("apiId").value = "";
  $("apiName").value = "";
  $("apiModel").value = "";
  $("apiEndpoint").value = "";
  $("apiKey").value = "";
  $("apiSize").value = "1024x1024";
  $("apiModeGeneration").checked = true;
  $("apiModeEdit").checked = false;
  setStatus("apiStatus", "");
}

function fillApiForm(api) {
  state.editingApi = api;
  $("apiForm").classList.remove("hidden");
  $("apiFormTitle").textContent = "编辑模型";
  $("apiId").value = api.id;
  $("apiName").value = api.name || "";
  $("apiModel").value = api.model || "";
  $("apiEndpoint").value = api.endpoint || "";
  $("apiKey").value = api.apiKey || "";
  $("apiSize").value = api.size || "1024x1024";
  const modes = getApiModes(api);
  $("apiModeGeneration").checked = modes.includes("generation");
  $("apiModeEdit").checked = modes.includes("edit");
  setStatus("apiStatus", "正在编辑已有模型。API Key 保持星号表示不修改。");
}

async function saveApi(event) {
  event.preventDefault();
  setStatus("apiStatus", "正在保存...");
  const requestModes = getApiModesFromForm();
  const body = {
    id: $("apiId").value || undefined,
    name: $("apiName").value,
    model: $("apiModel").value,
    endpoint: $("apiEndpoint").value,
    apiKey: $("apiKey").value,
    size: $("apiSize").value || "1024x1024",
    requestModes,
    enabled: requestModes.length > 0
  };

  if (!requestModes.length) {
    setStatus("apiStatus", "未选择任何模式，该模型将进入停用状态。");
  }

  try {
    await request("/api/admin/apis", { method: "POST", body: JSON.stringify(body) });
    setStatus("apiStatus", "保存成功。");
    clearApiForm();
    $("apiForm").classList.add("hidden");
    await loadAdminConfig();
    await loadModels();
  } catch (error) {
    setStatus("apiStatus", error.message, true);
  }
}

async function deleteApi(id) {
  if (!confirm("确认删除这个模型配置？")) return;
  try {
    await request(`/api/admin/apis/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadAdminConfig();
    await loadModels();
  } catch (error) {
    setStatus("apiStatus", error.message, true);
  }
}

async function changePassword(event) {
  event.preventDefault();
  setStatus("passwordStatus", "正在修改...");
  try {
    await request("/api/admin/password", {
      method: "POST",
      body: JSON.stringify({
        currentUsername: $("currentUser").value.trim(),
        currentPassword: $("currentPass").value,
        nextUsername: $("nextUser").value.trim(),
        nextPassword: $("nextPass").value
      })
    });
    $("adminUser").value = $("nextUser").value.trim();
    $("adminPass").value = "";
    $("currentPass").value = "";
    $("nextPass").value = "";
    setStatus("passwordStatus", "修改成功，下次登录请使用新账号密码。");
  } catch (error) {
    setStatus("passwordStatus", error.message, true);
  }
}

async function loadRecords() {
  const list = $("recordsList");
  if (!list) return;
  list.innerHTML = '<div class="placeholder">正在读取记录...</div>';
  try {
    const data = await request("/api/admin/records");
    state.records = applyRecordModeCache(data.records || []);
    updateRecordFilters("filterUser", state.records);
    renderRecords(getFilteredRecords(state.records, "filterUser", "filterStart", "filterEnd"), "recordsList");
  } catch (error) {
    list.innerHTML = `<div class="placeholder">${escapeHtml(error.message)}</div>`;
  }
}

async function loadUserRecords() {
  const list = $("userRecordsList");
  if (!list) return;
  list.innerHTML = '<div class="placeholder">正在读取记录...</div>';
  try {
    const data = await request(`/api/records?clientId=${encodeURIComponent(state.clientId)}`);
    state.userRecords = applyRecordModeCache(data.records || []);
    renderRecords(state.userRecords, "userRecordsList");
  } catch (error) {
    list.innerHTML = `<div class="placeholder">${escapeHtml(error.message)}</div>`;
  }
}

function renderRecords(records, listId = "recordsList") {
  const list = $(listId);
  const isUserList = listId === "userRecordsList";
  list.innerHTML = "";
  if (!records.length) {
    list.innerHTML = '<div class="placeholder">暂无生成记录。</div>';
    return;
  }
  [...records]
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .forEach((record) => {
    const item = document.createElement("div");
    item.className = "record-item";

    const outputs = Array.isArray(record.outputs) ? record.outputs : record.image ? [record.image] : [];
    const timeText = formatRecordTime(record.time);
    const isSuccess = outputs.some((item) => typeof item === "string" && item.trim());
    const modeText = record.requestMode === "edit" ? "edit" : "generation";
    const meta = document.createElement("div");
    meta.className = "record-meta";
    if (isUserList) {
      meta.innerHTML = `
        <div class="record-badges">
          <span class="badge user-badge">${escapeHtml(record.visitor || "-")}</span>
          <span class="badge mode-badge">${escapeHtml(modeText)}</span>
          <span class="badge time-badge">${escapeHtml(timeText)}</span>
          <span class="badge ${isSuccess ? "success-badge" : "failed-badge"}">${isSuccess ? "成功" : "失败"}</span>
        </div>
        <span>生成模型：${escapeHtml(record.model || record.modelId || "-")}</span>
        <span>生成图片数量：${escapeHtml(record.count || outputs.length || 0)} 张</span>
        <p>Prompt：${escapeHtml(record.prompt || "-")}</p>
      `;
    } else {
      meta.innerHTML = `
        <div class="record-badges">
          <span class="badge user-badge">使用者：${escapeHtml(record.visitor || "-")}</span>
          <span class="badge mode-badge">模式：${escapeHtml(modeText)}</span>
          <span class="badge time-badge">时间：${escapeHtml(timeText)}</span>
          <span class="badge ${isSuccess ? "success-badge" : "failed-badge"}">${isSuccess ? "成功" : "失败"}</span>
        </div>
        <span>生成模型：${escapeHtml(record.model || record.modelId || "-")}</span>
        <span>参考图：${escapeHtml(record.referenceName || record.reference || "无")}</span>
        <span>生成图片数量：${escapeHtml(record.count || outputs.length || 0)} 张</span>
        <p>Prompt：${escapeHtml(record.prompt || "-")}</p>
      `;
    }

    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "compact";
    preview.textContent = "输出结果";
    preview.disabled = !outputs.length;
    preview.addEventListener("click", () => showPreview(outputs));

    const refs = Array.isArray(record.referencePreviews) ? record.referencePreviews : [];
    const refButton = document.createElement("button");
    refButton.type = "button";
    refButton.className = "compact";
    refButton.textContent = "参考图";
    refButton.disabled = !refs.length;
    refButton.addEventListener("click", () => showReferencePreview(refs));

    const actions = document.createElement("div");
    actions.className = "record-buttons";
    actions.append(refButton, preview);

    item.append(meta, actions);
    list.append(item);
    });
}

function updateRecordFilters(selectId, records) {
  const select = $(selectId);
  const current = select.value;
  const users = [...new Set(records.map((record) => record.visitor).filter(Boolean))].sort();
  select.innerHTML = '<option value="">全部使用者</option>';
  users.forEach((user) => {
    const option = document.createElement("option");
    option.value = user;
    option.textContent = user;
    select.append(option);
  });
  select.value = users.includes(current) ? current : "";
}

function getFilteredRecords(records, userId, startId, endId) {
  const user = userId ? $(userId).value : "";
  const start = $(startId).value ? new Date($(startId).value).getTime() : null;
  const end = $(endId).value ? new Date($(endId).value).getTime() : null;
  return records.filter((record) => {
    if (user && record.visitor !== user) return false;
    const time = Date.parse(record.time || "");
    if (start && (!time || time < start)) return false;
    if (end && (!time || time > end)) return false;
    return true;
  });
}

function formatRecordTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function resetRecordFilters() {
  $("filterUser").value = "";
  $("filterStart").value = "";
  $("filterEnd").value = "";
  renderRecords(getFilteredRecords(state.records, "filterUser", "filterStart", "filterEnd"), "recordsList");
}

function showPreview(images) {
  const grid = $("previewGrid");
  grid.innerHTML = "";
  images.forEach((src, index) => {
    const item = document.createElement("div");
    item.className = "preview-item";
    const img = new Image();
    img.alt = `输出结果 ${index + 1}`;
    img.src = src;
    const button = document.createElement("button");
    button.className = "download-button";
    button.type = "button";
    button.textContent = "下载";
    button.addEventListener("click", () => downloadImage(src, `record-image-${index + 1}.png`));
    item.append(img, button);
    grid.append(item);
  });
  $("previewDialog").showModal();
}

function showReferencePreview(refs) {
  const grid = $("previewGrid");
  grid.innerHTML = "";
  refs.forEach((ref, index) => {
    const item = document.createElement("div");
    item.className = "preview-item reference-preview-item";
    if (ref.src) {
      const img = new Image();
      img.alt = ref.label || `参考图 ${index + 1}`;
      img.src = ref.src;
      item.append(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "reference-preview-empty";
      placeholder.textContent = "无预览";
      item.append(placeholder);
    }
    const label = document.createElement("span");
    label.className = "reference-preview-label";
    label.textContent = `${ref.label || `参考图 ${index + 1}`} · ${ref.name || ""}`;
    item.append(label);
    grid.append(item);
  });
  $("previewDialog").showModal();
}

async function handleReferenceFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
  $("referenceInput").value = "";
  if (!files.length) {
    renderReferenceThumbs();
    $("referenceNote").textContent = '可选，可在 prompt 中描述"参考图 1"的主体或"参考图 2"的风格。';
    return;
  }
  const limited = files.slice(0, 9);
  try {
    for (const file of limited) {
      if (file.size > 12 * 1024 * 1024) continue;
      const data = await readFileAsDataUrl(file);
      state.references.push({ name: file.name, data, preview: await makeReferencePreview(data) });
    }
    state.canClearReferences = false;
    renderReferenceThumbs();
    updateClearReferencesButton();
    $("referenceNote").textContent = state.references.length
      ? `已选择 ${state.references.length} 张参考图，可在 prompt 中按编号描述。`
      : "参考图请控制在 12MB 以内。";
  } catch (error) {
    $("referenceNote").textContent = error.message;
  }
}

function renderReferenceThumbs() {
  const wrap = $("referenceThumbs");
  wrap.innerHTML = "";
  state.references.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "reference-thumb";
    card.title = "双击预览";
    card.addEventListener("dblclick", () => {
      showReferencePreview([{
        name: item.name,
        label: `参考图 ${index + 1}`,
        src: item.preview || item.data || ""
      }]);
    });
    const img = new Image();
    img.src = item.data;
    img.alt = `参考图 ${index + 1}`;
    const badge = document.createElement("span");
    badge.textContent = `参考图 ${index + 1}`;
    const name = document.createElement("small");
    name.textContent = item.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-reference";
    remove.setAttribute("aria-label", `删除参考图 ${index + 1}`);
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeReference(index);
    });
    remove.addEventListener("dblclick", (event) => event.stopPropagation());
    card.append(img, badge, remove, name);
    wrap.append(card);
  });
}

function makeReferencePreview(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const maxSide = 320;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => resolve("");
    img.src = dataUrl;
  });
}

async function importPendingImageTask() {
  const raw = sessionStorage.getItem("pendingImageTask") || localStorage.getItem("pendingImageTask");
  if (!raw) return;
  sessionStorage.removeItem("pendingImageTask");
  localStorage.removeItem("pendingImageTask");

  let task = null;
  try {
    task = JSON.parse(raw);
  } catch {
    return;
  }

  const requestMode = String(task.requestMode || "").trim();
  if (requestMode === "edit" || requestMode === "generation") {
    setRequestMode(requestMode);
  }

  const promptFormat = String(task.promptFormat || "").trim();
  if (promptFormat === "json" || promptFormat === "plain") {
    setPromptFormat(promptFormat);
  }

  const prompt = String(task.prompt || "").trim();
  if (prompt) {
    state.promptDrafts[state.promptFormat] = prompt;
    renderPromptInput();
  }

  const images = Array.isArray(task.images) ? task.images.slice(0, 9) : [];
  state.references = [];
  for (const [index, image] of images.entries()) {
    const data = image?.data || image?.dataUrl || "";
    if (!String(data).startsWith("data:image/")) continue;
    state.references.push({
      name: image.name || `参考图 ${index + 1}.png`,
      data,
      preview: data,
    });
  }

  state.canClearReferences = false;
  renderReferenceThumbs();
  updateClearReferencesButton();
  $("referenceNote").textContent = state.references.length
    ? `已从 Prompt 优化器导入 ${state.references.length} 张参考图，顺序已保留。`
    : "已从 Prompt 优化器导入提示词，未携带参考图。";
  setStatus("statusText", "已从 Prompt 优化器导入内容，可继续选择模型和参数生成图片。");
}


function removeReference(index) {
  state.references.splice(index, 1);
  state.canClearReferences = false;
  renderReferenceThumbs();
  updateClearReferencesButton();
  $("referenceNote").textContent = state.references.length
    ? `已选择 ${state.references.length} 张参考图，可在 prompt 中按编号描述。`
    : '可选，可在 prompt 中描述"参考图 1"的主体或"参考图 2"的风格。';
}

function clearReferences() {
  if (!state.canClearReferences) return;
  state.references = [];
  state.canClearReferences = false;
  renderReferenceThumbs();
  updateClearReferencesButton();
  $("referenceNote").textContent = "参考图已清空。可继续选择或拖入新参考图。";
}

function updateClearReferencesButton() {
  const button = $("clearReferencesBtn");
  button.disabled = !state.references.length || !state.canClearReferences;
}

function jumpToPromptOptimizer() {
  syncPromptDraft();
  const activePrompt = state.promptDrafts[state.promptFormat] || "";
  sessionStorage.setItem("pendingPromptTask", JSON.stringify({
    description: activePrompt.trim(),
    mode: state.references.length ? "reference" : "text",
    images: state.references.map((item, index) => ({
      name: item.name || `参考图 ${index + 1}.png`,
      data: item.data,
    })),
    createdAt: new Date().toISOString(),
  }));
  window.location.href = "/prompt.html";
}

$("referenceInput").addEventListener("change", () => handleReferenceFiles($("referenceInput").files));
$("clearReferencesBtn").addEventListener("click", clearReferences);
$("uploadZone").addEventListener("dragover", (event) => {
  event.preventDefault();
  $("uploadZone").classList.add("dragging");
});
$("uploadZone").addEventListener("dragleave", () => $("uploadZone").classList.remove("dragging"));
$("uploadZone").addEventListener("drop", (event) => {
  event.preventDefault();
  $("uploadZone").classList.remove("dragging");
  handleReferenceFiles(event.dataTransfer.files);
});

$("settingsBtn").addEventListener("click", openAdmin);
$("closeAdminBtn").addEventListener("click", () => $("adminDialog").close());
$("loginForm").addEventListener("submit", loginAdmin);
$("feishuLoginBtn").addEventListener("click", beginFeishuLogin);
$("adminLogoutBtn").addEventListener("click", logoutAdmin);
$("feishuConfigForm").addEventListener("submit", saveFeishuConfig);
$("adminUserForm").addEventListener("submit", saveAdminUser);
$("adminUsersList").addEventListener("click", async (event) => {
  const id = event.target.dataset.deleteAdmin;
  if (!id) return;
  if (!confirm("确定移除这个管理员吗？")) return;
  try {
    const data = await request("/api/admin/admin-users/" + encodeURIComponent(id), { method: "DELETE" });
    state.adminUsers = data.adminUsers || [];
    renderAdminUsers();
    $("adminUserStatus").textContent = "管理员已移除。";
  } catch (error) {
    $("adminUserStatus").textContent = error.message;
  }
});
$("apiForm").addEventListener("submit", saveApi);
$("passwordForm").addEventListener("submit", changePassword);
$("newApiBtn").addEventListener("click", clearApiForm);
$("refreshRecordsBtn").addEventListener("click", loadRecords);
$("applyFiltersBtn").addEventListener("click", () => renderRecords(getFilteredRecords(state.records, "filterUser", "filterStart", "filterEnd"), "recordsList"));
$("resetFiltersBtn").addEventListener("click", resetRecordFilters);
$("refreshUserRecordsBtn").addEventListener("click", loadUserRecords);
$("closePreviewBtn").addEventListener("click", () => $("previewDialog").close());
$("downloadAllBtn").addEventListener("click", downloadAllImages);
$("generateBtn").addEventListener("click", generateImage);
$("jumpToPromptBtn").addEventListener("click", jumpToPromptOptimizer);
$("modelSelect").addEventListener("change", updateModelHint);
$("generationModeBtn").addEventListener("click", () => setRequestMode("generation"));
$("editModeBtn").addEventListener("click", () => setRequestMode("edit"));
$("plainPromptBtn").addEventListener("click", () => setPromptFormat("plain"));
$("jsonPromptBtn").addEventListener("click", () => setPromptFormat("json"));
$("promptInput").addEventListener("input", syncPromptDraft);

checkAdminSessionAfterRedirect().catch(() => {});
fetchVisitorFromSession().catch(() => {});
renderPromptInput();
importPendingImageTask().catch((error) => setStatus("statusText", error.message, true));
loadModels().catch((error) => setStatus("statusText", error.message, true));
loadUserRecords().catch((error) => setStatus("statusText", error.message, true));
