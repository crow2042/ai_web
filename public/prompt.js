(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    images: [],
    llmModels: [],
    llmApis: [],
    adminUsers: [],
    feishuAuth: null,
    currentAdmin: null,
    visitor: "",
    clientId: localStorage.getItem("clientId") || localStorage.getItem("aiImageClientId") || crypto.randomUUID(),
    lastGeneratedPrompt: "",
    lastGeneratedJson: "",
    lastGeneratedMode: "",
    outputView: "plain",
  };
  localStorage.setItem("clientId", state.clientId);
  localStorage.setItem("aiImageClientId", state.clientId);
  const promptRecordCacheKey = `prompt-record-cache:${state.clientId}`;
  const adminSessionKey = "adminSessionActive";
  const promptAdminConfigCacheKey = "promptAdminConfigCache";
  const promptAdminRecordsCacheKey = "promptAdminRecordsCache";
  const navType = globalThis.performance?.getEntriesByType?.("navigation")?.[0]?.type || "";
  if (navType === "reload") {
    sessionStorage.removeItem(adminSessionKey);
    sessionStorage.removeItem(promptAdminConfigCacheKey);
    sessionStorage.removeItem(promptAdminRecordsCacheKey);
  }

  const modeGrid = $("modeGrid");
  const imageInput = $("imageInput");
  const uploadZone = $("uploadZone");
  const imageThumbs = $("imageThumbs");
  const clearImageBtn = $("clearImageBtn");
  const generateBtn = $("generatePromptBtn");
  const resetBtn = $("resetBtn");
  const resultSummary = $("resultSummary");
  const promptOutput = $("promptOutput");
  const copyPromptBtn = $("copyPromptBtn");
  const toggleOutputBtn = $("toggleOutputBtn");
  const jumpToImageBtn = $("jumpToImageBtn");
  const llmModelSelect = $("llmModelSelect");
  const outputBox = promptOutput.closest(".output-box");

  const adminDialog = $("promptAdminDialog");
  const settingsBtn = $("promptSettingsBtn");
  const closeAdminBtn = $("closePromptAdminBtn");
  const loginForm = $("promptLoginForm");
  const adminPanel = $("promptAdminPanel");
  const loginStatus = $("promptLoginStatus");
  const feishuLoginBtn = $("promptFeishuLoginBtn");
  const legacyLoginBtn = $("promptLegacyLoginBtn");
  const legacyLoginFields = $("legacyLoginFields");
  const adminLogoutBtn = $("promptAdminLogoutBtn");
  const currentAdminInfo = $("currentAdminInfo");
  const feishuConfigSection = $("feishuConfigSection");
  const feishuConfigForm = $("feishuConfigForm");
  const feishuConfigStatus = $("feishuConfigStatus");
  const adminUsersSection = $("adminUsersSection");
  const adminUserForm = $("adminUserForm");
  const adminUserStatus = $("adminUserStatus");
  const adminUsersList = $("adminUsersList");
  const llmAdminSection = $("llmAdminSection");
  const promptRecordsAdminSection = $("promptRecordsAdminSection");
  const llmApiList = $("llmApiList");
  const llmApiForm = $("llmApiForm");
  const llmApiFormTitle = $("llmApiFormTitle");
  const llmApiStatus = $("llmApiStatus");
  const promptRecordsList = $("promptRecordsList");
  const localPromptRecordsList = $("localPromptRecordsList");
  const recordDialog = $("promptRecordDialog");
  const recordDialogTitle = $("promptRecordDialogTitle");
  const recordDetail = $("promptRecordDetail");

  function lines(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function apiFetch(url, options = {}) {
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json; charset=utf-8", ...(options.headers || {}) },
        ...options,
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { error: text };
      }
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      return payload;
    } catch (error) {
      throw error;
    }
  }


  function showPromptLogin() {
    loginForm.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    syncAdminVisibility();
  }

  function showPromptAdminPanel() {
    loginForm.classList.add("hidden");
    adminPanel.classList.remove("hidden");
  }

  function renderCurrentAdmin() {
    const admin = state.currentAdmin;
    currentAdminInfo.textContent = admin
      ? '当前管理员：' + (admin.name || admin.openId || admin.userId || '未命名') + (admin.isSuperAdmin === false ? '（普通管理员）' : '（超级管理员）')
      : '当前未识别到管理员信息';
  }

  function renderAdminUsers() {
    if (!state.adminUsers.length) {
      adminUsersList.innerHTML = '<p class="empty-text">还没有配置飞书管理员，请先添加至少一位。</p>';
      return;
    }
    adminUsersList.innerHTML = state.adminUsers.map((user) => {
      const key = user.openId || user.userId || user.unionId;
      return '<article class="api-item"><div><strong>' + escapeHtml(user.name || key || '未命名管理员') + '</strong><div class="muted">Open ID：' + escapeHtml(user.openId || '-') + '</div><div class="muted">User ID：' + escapeHtml(user.userId || '-') + '</div><div class="muted">邮箱：' + escapeHtml(user.email || '-') + '</div><div class="muted">角色：' + (user.isSuperAdmin === false ? '普通管理员' : '超级管理员') + '</div></div><div class="api-actions"><button class="compact danger" type="button" data-delete-admin="' + escapeHtml(key) + '">移除</button></div></article>';
    }).join('');
  }

  function syncFeishuLoginView() {
    const enabled = state.feishuAuth?.enabled !== false;
    feishuLoginBtn.classList.toggle('hidden', !enabled);
    legacyLoginFields.classList.toggle('hidden', enabled);
    legacyLoginBtn.classList.toggle('hidden', enabled);
  }

  function syncAdminVisibility() {
    const isAdmin = Boolean(state.currentAdmin?.isAdmin || state.currentAdmin?.isSuperAdmin);
    const isSuperAdmin = Boolean(state.currentAdmin) && state.currentAdmin.isSuperAdmin !== false && isAdmin;
    feishuConfigSection.classList.toggle("hidden", !isSuperAdmin);
    adminUsersSection.classList.toggle("hidden", !isSuperAdmin);
    llmAdminSection.classList.toggle("hidden", !isAdmin);
    promptRecordsAdminSection.classList.toggle("hidden", !isAdmin);
    if (!isAdmin) llmApiForm.classList.add("hidden");
  }

  function rememberAdminSession() {
    sessionStorage.setItem(adminSessionKey, "1");
  }

  function forgetAdminSession() {
    sessionStorage.removeItem(adminSessionKey);
    sessionStorage.removeItem(promptAdminConfigCacheKey);
    sessionStorage.removeItem(promptAdminRecordsCacheKey);
  }

  function readSessionCache(key, fallback) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeSessionCache(key, value) {
    sessionStorage.setItem(key, JSON.stringify(value));
  }

  function hydratePromptAdminCache() {
    const cachedApis = readSessionCache(promptAdminConfigCacheKey, []);
    state.llmApis = Array.isArray(cachedApis) ? cachedApis : [];
    renderLlmApiList();

    const cachedRecords = readSessionCache(promptAdminRecordsCacheKey, []);
    if (Array.isArray(cachedRecords) && cachedRecords.length) {
      renderPromptRecords(cachedRecords, promptRecordsList);
    } else if (promptRecordsList) {
      promptRecordsList.innerHTML = `<p class="empty-text">点击“刷新记录”加载管理员记录。</p>`;
    }
  }

  function currentMode() {
    return document.querySelector('input[name="mode"]:checked')?.value || "edit";
  }

  function modeLabel(mode) {
    if (mode === "edit") return "改图";
    if (mode === "reference") return "参考图生图";
    if (mode === "text") return "纯文生图";
    return mode || "-";
  }

  function splitPromptParts(value) {
    return String(value || "")
      .split(/[\n，。；;、,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function normalizedList(values, fallback = []) {
    const list = (Array.isArray(values) ? values : [values])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    return list.length ? list : fallback;
  }

  function uniqueList(values) {
    return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
  }

  function toFeatureList(descriptionParts, preserve, limit = 4) {
    return uniqueList([...preserve, ...descriptionParts]).slice(0, limit);
  }

  function buildPromptJson(input, plainPrompt) {
    const descriptionParts = splitPromptParts(input?.description || plainPrompt);
    const promptParts = splitPromptParts(plainPrompt);
    const preserve = normalizedList(input?.preserve, input?.mode === "edit"
      ? ["主体轮廓不变", "整体构图不变", "原有风格不变"]
      : ["主体识别度高", "构图完整"]);
    const negative = normalizedList(input?.negative, ["不要文字", "不要复杂背景", "不要偏离主体"]);
    const styleList = normalizedList(input?.styleTone ? [input.styleTone] : [], []);
    const aspectRatio = input?.aspectRatio || "16:9";

    if (input?.mode === "edit") {
      return {
        task: "image_edit",
        goal: input.description || plainPrompt || "根据需求修改原图",
        keep_unchanged: preserve,
        edit_area: {
          target: descriptionParts[0] || "用户指定区域",
          action: "adjust"
        },
        repair_instruction: {
          area: descriptionParts[0] || "被修改区域周围",
          fill_with: ["自然延续的结构或材质", "连续光影", "与原图一致的风格"]
        },
        style_requirement: uniqueList([...styleList, "干净", "精致", "统一"]),
        negative_prompt: negative,
        plain_prompt: plainPrompt
      };
    }

    if (input?.mode === "reference") {
      return {
        task: "image_generation_with_reference",
        reference_usage: {
          use_for: ["参考图的风格质感", "参考图的材质表现", "参考图的配色氛围", "参考图的完成度"],
          do_not_copy: ["不要照抄参考图角色", "不要照抄参考图结构", "不要保留参考图中的具体装饰或文字"]
        },
        generate_target: {
          subject: descriptionParts[0] || "根据需求生成新主体",
          theme: input.styleTone || promptParts[0] || "参考图延展设计",
          core_shape: descriptionParts[1] || "主体轮廓清晰"
        },
        design_requirements: {
          silhouette: preserve,
          features: toFeatureList(descriptionParts, preserve),
          expression_or_pose: descriptionParts[2] || input.description || plainPrompt,
          materials: styleList.length ? styleList : ["参考图质感延展"],
          effects: uniqueList(promptParts.slice(0, 4))
        },
        color_palette: [],
        composition: {
          aspect_ratio: aspectRatio,
          framing: "主体完整，构图饱满，视觉中心明确",
          background: "背景简洁，不抢主体"
        },
        quality_requirements: ["高识别度", "高完成度", "干净精致", "游戏资源质感", "小图标可读性强"],
        negative_prompt: negative,
        plain_prompt: plainPrompt
      };
    }

    return {
      task: "image_generation",
      generate_target: {
        subject: descriptionParts[0] || "根据需求生成主体",
        theme: input?.styleTone || promptParts[0] || "按需求生成",
        core_shape: descriptionParts[1] || "主体轮廓清晰"
      },
      design_requirements: {
        features: toFeatureList(descriptionParts, preserve),
        materials: styleList,
        effects: uniqueList(promptParts.slice(0, 4)),
        expression_or_pose: descriptionParts[2] || input?.description || plainPrompt
      },
      composition: {
        aspect_ratio: aspectRatio,
        framing: "主体完整，构图饱满，视觉中心明确",
        background: "背景简洁，不抢主体"
      },
      quality_requirements: ["高识别度", "高完成度", "干净精致"],
      negative_prompt: negative,
      plain_prompt: plainPrompt
    };
  }

  function updateModeCards() {
    document.querySelectorAll(".mode-card").forEach((card) => {
      const input = card.querySelector("input");
      card.classList.toggle("is-active", input.checked);
    });
  }

  async function loadLlmModels() {
    try {
      const data = await apiFetch("/api/llm-models", { headers: {} });
      state.llmModels = data.models || [];
      llmModelSelect.innerHTML = "";
      if (!state.llmModels.length) {
        llmModelSelect.innerHTML = `<option value="">请先在右上角齿轮配置 LLM API</option>`;
        return;
      }
      state.llmModels.forEach((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = `${model.name}（${model.model}）`;
        llmModelSelect.appendChild(option);
      });
    } catch (error) {
      llmModelSelect.innerHTML = `<option value="">模型列表加载失败</option>`;
      resultSummary.textContent = error.message;
    }
  }

  function readInputs() {
    return {
      visitor: state.visitor,
      clientId: state.clientId,
      modelId: llmModelSelect.value,
      mode: currentMode(),
      aspectRatio: $("aspectRatio").value,
      styleTone: $("styleTone").value.trim(),
      description: $("description").value.trim(),
      preserve: lines($("preserve").value),
      negative: lines($("negative").value),
      imageDataUrls: state.images.map((item) => item.dataUrl),
      imageDataUrl: state.images[0]?.dataUrl || "",
    };
  }

  function fileToImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, dataUrl: reader.result });
      reader.readAsDataURL(file);
    });
  }

  async function addImages(fileList) {
    const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
    imageInput.value = "";
    if (!files.length) return;
    const slots = Math.max(0, 9 - state.images.length);
    const selected = files.slice(0, slots);
    const images = await Promise.all(selected.map(fileToImage));
    state.images.push(...images);
    renderImageThumbs();
  }

  function renderImageThumbs() {
    imageThumbs.innerHTML = "";
    clearImageBtn.disabled = !state.images.length;
    state.images.forEach((image, index) => {
      const item = document.createElement("div");
      item.className = "reference-thumb";
      item.innerHTML = `
        <img alt="参考图 ${index + 1} 预览" src="${image.dataUrl}" />
        <span>参考图 ${index + 1}</span>
        <button type="button" class="remove-reference" aria-label="删除参考图 ${index + 1}">×</button>
        <small>${image.name}</small>
      `;
      item.querySelector(".remove-reference").addEventListener("click", (event) => {
        event.stopPropagation();
        state.images.splice(index, 1);
        renderImageThumbs();
      });
      imageThumbs.appendChild(item);
    });
  }

  function getPromptText(cards) {
    return (cards || [])
      .map((card) => String(card.content || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  function plainOutputAvailable() {
    return state.lastGeneratedMode !== "edit" && Boolean(state.lastGeneratedPrompt);
  }

  function jsonOutputAvailable() {
    return state.lastGeneratedMode !== "text" && Boolean(state.lastGeneratedJson);
  }

  function currentOutputText() {
    if (state.outputView === "json") return state.lastGeneratedJson || "";
    return state.lastGeneratedPrompt || "";
  }

  function setPromptOutput(value = "") {
    const text = String(value || "").trim();
    const isEmpty = !text;
    promptOutput.value = text;
    outputBox.classList.toggle("is-empty", isEmpty);
  }

  function updateOutputButtons() {
    const hasPlain = plainOutputAvailable();
    const hasJson = jsonOutputAvailable();
    const canToggle = hasPlain && hasJson;
    toggleOutputBtn.disabled = !canToggle;
    if (canToggle) {
      toggleOutputBtn.textContent = state.outputView === "plain" ? "切换至 JSON" : "切换至自然语言";
    } else if (hasJson) {
      toggleOutputBtn.textContent = "仅 JSON";
    } else if (hasPlain) {
      toggleOutputBtn.textContent = "仅自然语言";
    } else {
      toggleOutputBtn.textContent = "切换输出";
    }

    copyPromptBtn.disabled = !currentOutputText();
    jumpToImageBtn.classList.toggle("hidden", !(hasPlain || hasJson));
    jumpToImageBtn.disabled = !(hasPlain || hasJson);
  }

  function renderActiveOutput() {
    if (state.outputView === "json" && !jsonOutputAvailable()) {
      state.outputView = plainOutputAvailable() ? "plain" : "json";
    }
    if (state.outputView === "plain" && !plainOutputAvailable()) {
      state.outputView = jsonOutputAvailable() ? "json" : "plain";
    }
    setPromptOutput(currentOutputText());
    updateOutputButtons();
  }

  function flashCopied(button, fallbackText) {
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = fallbackText;
    }, 1200);
  }

  function hideJumpToImage() {
    state.lastGeneratedPrompt = "";
    state.lastGeneratedJson = "";
    state.lastGeneratedMode = "";
    jumpToImageBtn.classList.add("hidden");
    updateOutputButtons();
  }

  function renderCards(cards, input) {
    state.lastGeneratedMode = input.mode;
    state.lastGeneratedPrompt = getPromptText(cards);
    state.lastGeneratedJson = input.mode === "text"
      ? ""
      : (state.lastGeneratedPrompt ? JSON.stringify(buildPromptJson(input, state.lastGeneratedPrompt), null, 2) : "");
    state.outputView = input.mode === "edit" ? "json" : "plain";
    renderActiveOutput();

    if (!state.lastGeneratedPrompt) {
      resultSummary.textContent = "没有生成可用 Prompt。";
    } else if (input.mode === "edit") {
      resultSummary.textContent = "已生成改图 Prompt，并提供对应 JSON 结构化输出。";
    } else if (input.mode === "reference") {
      resultSummary.textContent = "已生成自然语言 Prompt，并提供对应 JSON 结构化输出。";
    } else {
      resultSummary.textContent = "已生成自然语言 Prompt。";
    }
    jumpToImageBtn.classList.toggle("hidden", !state.lastGeneratedPrompt);
  }

  async function generate() {
    if (!state.loggedIn) {
      resultSummary.textContent = "请先登录飞书~";
      return;
    }
    const input = readInputs();
    setPromptOutput("");
    hideJumpToImage();

    if (!input.modelId) {
      resultSummary.textContent = "请先选择 LLM 模型，或在右上角齿轮中配置模型。";
      return;
    }
    if (!input.description) {
      resultSummary.textContent = "请先填写需求描述。";
      return;
    }
    if ((input.mode === "edit" || input.mode === "reference") && !input.imageDataUrls.length) {
      resultSummary.textContent = "当前模式需要先上传参考图。";
      return;
    }

    generateBtn.disabled = true;
    generateBtn.textContent = "模型优化中...";
    resultSummary.textContent = "正在调用 LLM 读取图片和文本，请稍等。";
    try {
      const data = await apiFetch("/api/prompt-orchestrator/generate", {
        method: "POST",
        body: JSON.stringify(input),
      });
      renderCards(data.cards || [], input);
      await loadLocalPromptRecords();
    } catch (error) {
      state.lastGeneratedPrompt = "";
      state.lastGeneratedJson = "";
      state.lastGeneratedMode = "";
      setPromptOutput("");
      updateOutputButtons();
      resultSummary.textContent = error.message;
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "调用模型优化 Prompt";
    }
  }

  function resetInput() {
    ["styleTone", "description", "preserve", "negative"].forEach((id) => {
      $(id).value = "";
    });
    state.images = [];
    imageInput.value = "";
    setPromptOutput("");
    state.lastGeneratedPrompt = "";
    state.lastGeneratedJson = "";
    state.lastGeneratedMode = "";
    state.outputView = "plain";
    resultSummary.textContent = "根据任务模式，这里会输出自然语言 Prompt 或对应 JSON。";
    hideJumpToImage();
    renderImageThumbs();
    updateOutputButtons();
  }

  function importPendingPromptTask() {
    const raw = sessionStorage.getItem("pendingPromptTask") || localStorage.getItem("pendingPromptTask");
    if (!raw) return;
    sessionStorage.removeItem("pendingPromptTask");
    localStorage.removeItem("pendingPromptTask");

    let task = null;
    try {
      task = JSON.parse(raw);
    } catch {
      return;
    }

    const mode = String(task.mode || "");
    const targetMode = mode === "edit" || mode === "reference" || mode === "text"
      ? mode
      : (Array.isArray(task.images) && task.images.length ? "reference" : "text");
    const modeInput = document.querySelector(`input[name="mode"][value="${targetMode}"]`);
    if (modeInput) modeInput.checked = true;
    updateModeCards();

    const description = String(task.description || "").trim();
    if (description) {
      $("description").value = description;
    }

    const images = Array.isArray(task.images) ? task.images : [];
    state.images = images
      .map((image, index) => ({
        name: image?.name || `参考图 ${index + 1}.png`,
        dataUrl: image?.data || image?.dataUrl || "",
      }))
      .filter((image) => String(image.dataUrl).startsWith("data:image/"));
    renderImageThumbs();
  }

  function jumpToImagePage() {
    const prompt = currentOutputText();
    if (!prompt) return;
    const requestMode = state.lastGeneratedMode === "edit" ? "edit" : "generation";
    sessionStorage.setItem("pendingImageTask", JSON.stringify({
      prompt,
      requestMode,
      promptFormat: state.outputView,
      images: state.images.map((image, index) => ({
        name: image.name || `参考图 ${index + 1}.png`,
        data: image.dataUrl,
      })),
    }));
    window.location.href = "/image.html";
  }

  async function loadAdminConfig() {
    const data = await apiFetch("/api/admin/llm-config");
    state.llmApis = data.llmApis || [];
    state.adminUsers = data.adminUsers || [];
    state.feishuAuth = data.feishuAuth || null;
    state.currentAdmin = data.currentAdmin || null;
    writeSessionCache(promptAdminConfigCacheKey, state.llmApis);
    $("feishuEnabled").checked = state.feishuAuth?.enabled !== false;
    $("feishuAppId").value = state.feishuAuth?.appId || "";
    $("feishuAppSecret").value = state.feishuAuth?.appSecret || "";
    $("feishuRedirectUri").value = state.feishuAuth?.redirectUri || "";
    renderCurrentAdmin();
    renderAdminUsers();
    syncFeishuLoginView();
    syncAdminVisibility();
    renderLlmApiList();
  }

  async function loadAdminMeta() {
    const data = await apiFetch("/api/admin/feishu/meta");
    state.feishuAuth = data.feishuAuth || null;
    syncFeishuLoginView();
  }

  async function beginFeishuLogin() {
    loginStatus.textContent = "正在跳转到飞书登录...";
    const data = await apiFetch("/api/admin/feishu/login?returnTo=" + encodeURIComponent("/prompt.html"));
    window.location.href = data.url;
  }

  async function logoutAdmin() {
    await apiFetch("/api/admin/logout", { method: "POST" });
    forgetAdminSession();
    state.currentAdmin = null;
    state.loggedIn = false;
    state.visitor = "";
    generateBtn.disabled = true;
    generateBtn.title = "请先登录飞书~";
    showPromptLogin();
    loginStatus.textContent = "已退出管理员登录。";
  }

  async function saveFeishuConfig(event) {
    event.preventDefault();
    feishuConfigStatus.textContent = "保存中...";
    try {
      await apiFetch("/api/admin/feishu-config", {
        method: "POST",
        body: JSON.stringify({
          enabled: $("feishuEnabled").checked,
          appId: $("feishuAppId").value,
          appSecret: $("feishuAppSecret").value || "********",
          redirectUri: $("feishuRedirectUri").value
        })
      });
      feishuConfigStatus.textContent = "飞书配置已保存。";
      await loadAdminConfig();
    } catch (error) {
      feishuConfigStatus.textContent = error.message;
    }
  }

  async function saveAdminUser(event) {
    event.preventDefault();
    adminUserStatus.textContent = "保存中...";
    try {
      const data = await apiFetch("/api/admin/admin-users", {
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
      adminUserStatus.textContent = "管理员名单已更新。";
      adminUserForm.reset();
      $("adminUserSuperAdmin").checked = true;
    } catch (error) {
      adminUserStatus.textContent = error.message;
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
      showPromptLogin();
      loginStatus.textContent = error;
      return;
    }
    try {
      const session = await apiFetch("/api/admin/session");
      if (session.authed) {
        rememberAdminSession();
        state.currentAdmin = session.adminUser || null;
        showPromptAdminPanel();
        renderCurrentAdmin();
        syncAdminVisibility();
        loginStatus.textContent = "";
        if (state.currentAdmin?.isAdmin || state.currentAdmin?.isSuperAdmin) {
          await loadAdminConfig();
        }
      }
    } catch (sessionError) {
      loginStatus.textContent = sessionError.message;
    }
  }

  async function fetchVisitorFromSession() {
    try {
      const session = await apiFetch("/api/admin/session");
      if (session.authed) {
        rememberAdminSession();
        state.currentAdmin = session.adminUser || null;
        state.visitor = state.currentAdmin?.name || state.currentAdmin?.openId || "";
        state.loggedIn = true;
        showPromptAdminPanel();
        renderCurrentAdmin();
        syncAdminVisibility();
      }
    } catch {}
    if (!state.loggedIn) {
      generateBtn.disabled = true;
      generateBtn.title = "请先登录飞书~";
    } else {
      generateBtn.disabled = false;
      generateBtn.title = "";
    }
  }

  function renderLlmApiList() {
    llmApiList.innerHTML = "";
    if (!state.llmApis.length) {
      llmApiList.innerHTML = `<p class="empty-text">还没有配置 LLM 模型。</p>`;
      return;
    }
    state.llmApis.forEach((api) => {
      const item = document.createElement("div");
      item.className = "api-item";
      item.innerHTML = `
        <div>
          <strong>${api.name}</strong>
          <span>${api.model} · ${api.enabled === false ? "停用" : "启用"}</span>
        </div>
        <button type="button" class="compact" data-edit="${api.id}">编辑</button>
        <button type="button" class="compact danger" data-delete="${api.id}">删除</button>
      `;
      llmApiList.appendChild(item);
    });
  }

  function fillLlmForm(api = null) {
    llmApiForm.classList.remove("hidden");
    llmApiFormTitle.textContent = api ? "编辑模型" : "新增模型";
    $("llmApiId").value = api?.id || "";
    $("llmApiName").value = api?.name || "";
    $("llmApiModel").value = api?.model || "";
    $("llmApiEndpoint").value = api?.endpoint || "";
    $("llmApiKey").value = api?.apiKey || "";
    $("llmApiTemperature").value = api?.temperature ?? 0.4;
    $("llmApiEnabled").checked = api?.enabled !== false;
    llmApiStatus.textContent = "";
  }

  async function saveLlmApi(event) {
    event.preventDefault();
    llmApiStatus.textContent = "保存中...";
    try {
      await apiFetch("/api/admin/llm-apis", {
        method: "POST",
        body: JSON.stringify({
          id: $("llmApiId").value,
          name: $("llmApiName").value,
          model: $("llmApiModel").value,
          endpoint: $("llmApiEndpoint").value,
          apiKey: $("llmApiKey").value,
          temperature: $("llmApiTemperature").value,
          enabled: $("llmApiEnabled").checked,
        }),
      });
      llmApiStatus.textContent = "已保存。";
      llmApiForm.classList.add("hidden");
      await loadAdminConfig();
      await loadLlmModels();
    } catch (error) {
      llmApiStatus.textContent = error.message;
    }
  }

  async function loadPromptRecords() {
    promptRecordsList.innerHTML = `<p class="empty-text">加载中...</p>`;
    try {
      const records = (await apiFetch("/api/admin/prompt-records")).records || [];
      writeSessionCache(promptAdminRecordsCacheKey, records);
      renderPromptRecords(records, promptRecordsList);
    } catch (error) {
      promptRecordsList.innerHTML = `<p class="empty-text">${error.message}</p>`;
    }
  }

  function summarizePromptRecord(record) {
    return {
      time: record.time,
      visitor: record.visitor,
      mode: record.mode,
      model: record.model,
      status: record.status,
      description: record.description,
      error: record.error,
      _cached: true,
    };
  }

  function readPromptRecordCache() {
    try {
      const raw = localStorage.getItem(promptRecordCacheKey);
      const records = raw ? JSON.parse(raw) : [];
      return Array.isArray(records) ? records : [];
    } catch {
      return [];
    }
  }

  function writePromptRecordCache(records) {
    const summaries = (records || [])
      .slice()
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
      .slice(0, 40)
      .map(summarizePromptRecord);
    localStorage.setItem(promptRecordCacheKey, JSON.stringify(summaries));
  }

  async function loadLocalPromptRecords(options = {}) {
    if (!localPromptRecordsList) return;
    const cachedRecords = options.preferCache ? readPromptRecordCache() : [];
    if (cachedRecords.length) {
      renderPromptRecords(cachedRecords, localPromptRecordsList);
    } else {
      localPromptRecordsList.innerHTML = `<p class="empty-text">加载中...</p>`;
    }
    try {
      const data = await apiFetch(`/api/prompt-records?clientId=${encodeURIComponent(state.clientId)}`);
      const records = data.records || [];
      writePromptRecordCache(records);
      renderPromptRecords(records, localPromptRecordsList);
    } catch (error) {
      if (!cachedRecords.length) {
        localPromptRecordsList.innerHTML = `<p class="empty-text">${error.message}</p>`;
      }
    }
  }

  function renderPromptRecords(records, list) {
    const sorted = (records || [])
      .slice()
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
    if (!sorted.length) {
      list.innerHTML = `<p class="empty-text">暂无 Prompt 优化记录。</p>`;
      return;
    }
    list.innerHTML = "";
    sorted.slice(0, 80).forEach((record) => {
      const item = document.createElement("div");
      item.className = "record-item prompt-record-item";
      const isCached = Boolean(record._cached);
      item.innerHTML = `
          <div class="record-meta">
            <div class="record-badges">
              <span class="badge user-badge">${escapeHtml(record.visitor || "未知")}</span>
              <span class="badge mode-badge">${escapeHtml(modeLabel(record.mode))}</span>
              <span class="badge time-badge">${escapeHtml(record.time ? new Date(record.time).toLocaleString() : "-")}</span>
              <span class="badge ${record.status === "success" ? "success-badge" : "failed-badge"}">${record.status === "success" ? "成功" : "失败"}</span>
            </div>
            <span class="record-model-name">${escapeHtml(record.model || "未知模型")}</span>
            <p>${escapeHtml(record.description || record.error || "")}</p>
          </div>
        <div class="record-actions">
          <button type="button" class="compact">查看输入</button>
          <button type="button" class="compact">查看输出</button>
        </div>
      `;
      const buttons = item.querySelectorAll(".record-actions button");
      buttons[0].disabled = isCached;
      buttons[1].disabled = isCached;
      if (isCached) {
        buttons[0].title = "正在后台加载详情";
        buttons[1].title = "正在后台加载详情";
      } else {
        buttons[0].addEventListener("click", () => showPromptRecordInput(record));
        buttons[1].addEventListener("click", () => showPromptRecordOutput(record));
      }
      list.appendChild(item);
    });
  }

  function detailCard(title, content) {
    const rawContent = String(content || "-");
    return `
      <section class="detail-card">
        <div class="detail-head">
          <h3>${escapeHtml(title)}</h3>
        </div>
        <pre><code>${escapeHtml(rawContent)}</code></pre>
      </section>
    `;
  }

  function showPromptRecordInput(record) {
    recordDialogTitle.textContent = "输入内容";
    const images = Array.isArray(record.inputImagePreviews) && record.inputImagePreviews.length
      ? record.inputImagePreviews
      : record.inputImagePreview ? [record.inputImagePreview] : [];
    const image = images.length
      ? `<section class="detail-card"><h3>输入图片</h3><div class="detail-images">${images.map((src, index) => `<img src="${src}" alt="输入图片 ${index + 1}" />`).join("")}</div></section>`
      : "";
    recordDetail.innerHTML = [
      detailCard("基础信息", [
        `使用者：${record.visitor || "-"}`,
        `时间：${record.time ? new Date(record.time).toLocaleString() : "-"}`,
        `模型：${record.model || record.modelId || "-"}`,
        `模式：${modeLabel(record.mode)}`,
        `比例：${record.aspectRatio || "-"}`,
        `风格：${record.styleTone || "-"}`
      ].join("\n")),
      detailCard("需求描述", record.description || "-"),
      detailCard("重点保留 / 重点参考", Array.isArray(record.preserve) && record.preserve.length ? record.preserve.join("\n") : "-"),
      detailCard("负向约束", Array.isArray(record.negative) && record.negative.length ? record.negative.join("\n") : "-"),
      image
    ].join("");
    recordDialog.showModal();
  }

  function showPromptRecordOutput(record) {
    recordDialogTitle.textContent = "输出结果";
    const cards = Array.isArray(record.cards) ? record.cards : [];
    if (!cards.length) {
      recordDetail.innerHTML = detailCard(record.status === "failed" ? "失败原因" : "输出结果", record.error || "没有可查看的输出结果。");
    } else {
      const plainText = getPromptText(cards) || "没有可查看的输出结果。";
      const jsonText = record.mode === "text"
        ? ""
        : JSON.stringify(buildPromptJson({
          mode: record.mode,
          description: record.description,
          preserve: record.preserve,
          negative: record.negative,
          styleTone: record.styleTone,
          aspectRatio: record.aspectRatio
        }, plainText), null, 2);
      recordDetail.innerHTML = [
        detailCard("自然语言 Prompt", plainText),
        ...(jsonText ? [detailCard("JSON 输出", jsonText)] : [])
      ].join("");
    }
    recordDialog.showModal();
  }

  settingsBtn.addEventListener("click", async () => {
    adminDialog.showModal();
    loginStatus.textContent = "";
    try {
      const session = await apiFetch("/api/admin/session");
      if (!session.authed) {
        showPromptLogin();
        await loadAdminMeta().catch(() => {});
        return;
      }
      rememberAdminSession();
      state.currentAdmin = session.adminUser || null;
      showPromptAdminPanel();
      renderCurrentAdmin();
      syncAdminVisibility();
      if (state.currentAdmin?.isAdmin || state.currentAdmin?.isSuperAdmin) {
        hydratePromptAdminCache();
        await loadAdminConfig();
      }
    } catch (error) {
      forgetAdminSession();
      showPromptLogin();
      loginStatus.textContent = error.message;
    }
  });
  closeAdminBtn.addEventListener("click", () => adminDialog.close());
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginStatus.textContent = "登录中...";
    try {
      await apiFetch("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("promptAdminUser").value,
          password: $("promptAdminPass").value,
        })
      });
      rememberAdminSession();
      state.loggedIn = true;
      state.visitor = $("promptAdminUser").value;
      generateBtn.disabled = false;
      generateBtn.title = "";
      showPromptAdminPanel();
      hydratePromptAdminCache();
      loginStatus.textContent = "";
      llmApiStatus.textContent = "正在加载模型配置...";
      loadAdminConfig().then(() => {
        llmApiStatus.textContent = "";
      }).catch((error) => {
        forgetAdminSession();
        showPromptLogin();
        loginStatus.textContent = error.message;
      });
      if (!readSessionCache(promptAdminRecordsCacheKey, []).length) {
        promptRecordsList.innerHTML = '<p class="empty-text">点击“刷新记录”加载管理员记录。</p>';
      }
    } catch (error) {
      loginStatus.textContent = error.message;
    }
  });

  feishuLoginBtn.addEventListener("click", beginFeishuLogin);
  adminLogoutBtn.addEventListener("click", logoutAdmin);
  feishuConfigForm.addEventListener("submit", saveFeishuConfig);
  adminUserForm.addEventListener("submit", saveAdminUser);
  adminUsersList.addEventListener("click", async (event) => {
    const id = event.target.dataset.deleteAdmin;
    if (!id) return;
    if (!confirm("确定移除这个管理员吗？")) return;
    try {
      const data = await apiFetch("/api/admin/admin-users/" + encodeURIComponent(id), { method: "DELETE" });
      state.adminUsers = data.adminUsers || [];
      renderAdminUsers();
      adminUserStatus.textContent = "管理员已移除。";
    } catch (error) {
      adminUserStatus.textContent = error.message;
    }
  });

  $("newLlmApiBtn").addEventListener("click", () => fillLlmForm());
  llmApiForm.addEventListener("submit", saveLlmApi);
  llmApiList.addEventListener("click", async (event) => {
    const editId = event.target.dataset.edit;
    const deleteId = event.target.dataset.delete;
    if (editId) fillLlmForm(state.llmApis.find((api) => api.id === editId));
    if (deleteId && confirm("确定删除这个 LLM 模型吗？")) {
      await apiFetch(`/api/admin/llm-apis/${encodeURIComponent(deleteId)}`, { method: "DELETE" });
      await loadAdminConfig();
      await loadLlmModels();
    }
  });
  $("refreshPromptRecordsBtn").addEventListener("click", loadPromptRecords);
  $("refreshLocalPromptRecordsBtn").addEventListener("click", loadLocalPromptRecords);
  $("closePromptRecordBtn").addEventListener("click", () => recordDialog.close());
  copyPromptBtn.addEventListener("click", async () => {
    const text = promptOutput.value.trim();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    flashCopied(copyPromptBtn, "复制");
  });
  toggleOutputBtn.addEventListener("click", () => {
    if (!plainOutputAvailable() || !jsonOutputAvailable()) return;
    state.outputView = state.outputView === "plain" ? "json" : "plain";
    renderActiveOutput();
  });
  jumpToImageBtn.addEventListener("click", jumpToImagePage);

  modeGrid.addEventListener("change", updateModeCards);
  imageInput.addEventListener("change", () => addImages(imageInput.files));
  clearImageBtn.addEventListener("click", () => {
    state.images = [];
    imageInput.value = "";
    renderImageThumbs();
  });

  ["dragenter", "dragover"].forEach((name) => {
    uploadZone.addEventListener(name, (event) => {
      event.preventDefault();
      uploadZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    uploadZone.addEventListener(name, (event) => {
      event.preventDefault();
      uploadZone.classList.remove("dragging");
    });
  });
  uploadZone.addEventListener("drop", (event) => addImages(event.dataTransfer.files));

  generateBtn.addEventListener("click", generate);
  resetBtn.addEventListener("click", resetInput);

  updateModeCards();
  setPromptOutput("");
  updateOutputButtons();
  loadAdminMeta().catch(() => {});
  checkAdminSessionAfterRedirect()
    .then(() => fetchVisitorFromSession())
    .then(() => {
      importPendingPromptTask().catch(() => {});
      loadLlmModels().catch(() => {});
      loadLocalPromptRecords({ preferCache: true }).catch(() => {});
      if (new URLSearchParams(window.location.search).get("settings") === "1") {
        window.history.replaceState({}, document.title, window.location.pathname + (window.location.hash || ""));
        settingsBtn.click();
      }
    })
    .catch((error) => {
      loginStatus.textContent = error.message;
    });
})();
