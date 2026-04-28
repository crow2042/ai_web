const state = {
  visitor: localStorage.getItem("visitorName") || "",
  clientId: getClientId(),
  models: [],
  editingApi: null,
  references: [],
  canClearReferences: false,
  lastImages: [],
  records: [],
  userRecords: []
};

const $ = (id) => document.getElementById(id);

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

function showIdentityIfNeeded() {
  if (state.visitor) {
    $("visitorBadge").textContent = `当前访问者：${state.visitor}`;
    $("identityModal").classList.add("hidden");
  } else {
    $("identityModal").classList.remove("hidden");
  }
}

async function loadModels() {
  const data = await request("/api/models");
  state.models = data.models || [];
  const select = $("modelSelect");
  select.innerHTML = "";

  if (!state.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无可用模型，请联系管理员配置";
    select.append(option);
    $("generateBtn").disabled = true;
    $("modelHint").textContent = "未配置模型";
    return;
  }

  state.models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name} (${model.model})`;
    select.append(option);
  });
  $("generateBtn").disabled = false;
  updateModelHint();
}

function updateModelHint() {
  const selected = state.models.find((model) => model.id === $("modelSelect").value);
  $("modelHint").textContent = selected ? `当前模型：${selected.name} · ${selected.size}` : "等待选择模型";
}

function getSelectedAspect() {
  return $("aspectSelect").value || "16:9 横向宽银幕构图";
}

async function generateImage() {
  const prompt = $("promptInput").value.trim();
  const modelId = $("modelSelect").value;
  const aspect = getSelectedAspect();
  const count = Number($("countSelect").value);
  if (!state.visitor) {
    $("identityModal").classList.remove("hidden");
    return;
  }
  if (!prompt) {
    setStatus("statusText", "请先填写 prompt。", true);
    return;
  }
  if (!modelId) {
    setStatus("statusText", "请先选择一个已配置的模型。", true);
    return;
  }

  $("generateBtn").disabled = true;
  $("imageBox").innerHTML = '<div class="placeholder">正在生成图片，请稍候...</div>';
  setStatus("statusText", "任务已提交，正在调用生图 API。");

  try {
    const finalPrompt = `${prompt}\n\n画面比例要求：${aspect}。`;
    renderLoadingPlaceholders(count, aspect);
    const data = await request("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        visitor: state.visitor,
        clientId: state.clientId,
        prompt: finalPrompt,
        originalPrompt: prompt,
        aspect,
        count,
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

function openAdmin() {
  $("adminDialog").showModal();
}

async function loginAdmin(event) {
  event.preventDefault();
  setStatus("loginStatus", "正在登录...");
  try {
    await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: $("adminUser").value.trim(), password: $("adminPass").value })
    });
    $("loginForm").classList.add("hidden");
    $("adminPanel").classList.remove("hidden");
    setStatus("loginStatus", "");
    await loadAdminConfig();
  } catch (error) {
    setStatus("loginStatus", error.message, true);
  }
}

async function loadAdminConfig() {
  const data = await request("/api/admin/config");
  $("currentUser").value = data.username || "";
  $("nextUser").value = data.username || "";
  renderApis(data.apis || []);
  await loadRecords();
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
    info.innerHTML = `<strong>${escapeHtml(api.name)}</strong><span>${escapeHtml(api.model)} · ${escapeHtml(api.enabled === false ? "已停用" : "已启用")}</span>`;

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
  $("apiEnabled").checked = true;
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
  $("apiEnabled").checked = api.enabled !== false;
  setStatus("apiStatus", "正在编辑已有模型。API Key 保持星号表示不修改。");
}

async function saveApi(event) {
  event.preventDefault();
  setStatus("apiStatus", "正在保存...");
  const body = {
    id: $("apiId").value || undefined,
    name: $("apiName").value,
    model: $("apiModel").value,
    endpoint: $("apiEndpoint").value,
    apiKey: $("apiKey").value,
    size: $("apiSize").value || "1024x1024",
    enabled: $("apiEnabled").checked
  };

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
    state.records = data.records || [];
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
    state.userRecords = data.records || [];
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
  records.forEach((record) => {
    const item = document.createElement("div");
    item.className = "record-item";

    const outputs = Array.isArray(record.outputs) ? record.outputs : record.image ? [record.image] : [];
    const timeText = formatRecordTime(record.time);
    const isSuccess = outputs.some((item) => typeof item === "string" && item.trim());
    const meta = document.createElement("div");
    meta.className = "record-meta";
    if (isUserList) {
      meta.innerHTML = `
        <div class="record-badges">
          <span class="badge user-badge">${escapeHtml(record.visitor || "-")}</span>
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
    $("referenceNote").textContent = "可选，可在 prompt 中描述“参考图 1”的主体或“参考图 2”的风格。";
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


function removeReference(index) {
  state.references.splice(index, 1);
  state.canClearReferences = false;
  renderReferenceThumbs();
  updateClearReferencesButton();
  $("referenceNote").textContent = state.references.length
    ? `已选择 ${state.references.length} 张参考图，可在 prompt 中按编号描述。`
    : "可选，可在 prompt 中描述“参考图 1”的主体或“参考图 2”的风格。";
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

$("identityForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.visitor = $("visitorName").value.trim();
  if (!state.visitor) return;
  localStorage.setItem("visitorName", state.visitor);
  showIdentityIfNeeded();
});

$("settingsBtn").addEventListener("click", openAdmin);
$("closeAdminBtn").addEventListener("click", () => $("adminDialog").close());
$("loginForm").addEventListener("submit", loginAdmin);
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
$("modelSelect").addEventListener("change", updateModelHint);

$("visitorName").value = state.visitor;
showIdentityIfNeeded();
loadModels().catch((error) => setStatus("statusText", error.message, true));
loadUserRecords();
