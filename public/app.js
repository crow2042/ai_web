const state = {
  visitor: "",
  clientId: getClientId(),
  loggedIn: false,
  allModels: [],
  models: [],
  llmModels: [],
  editingApi: null,
  editingLlmApi: null,
  references: [],
  canClearReferences: false,
  lastImages: [],
  records: [],
  userRecords: [],
  taskMode: "edit",
  quality: "high",
  lastGeneratedPrompt: "",
  lastGeneratedJson: "",
  lastGeneratedMode: "",
  promptAnalysis: null,
  promptOutputs: [],
  selectedPromptOutputIndex: 0,
  outputView: "plain",
  adminUsers: [],
  feishuAuth: null,
  currentAdmin: null
};
const adminSessionKey = "adminSessionActive";
const recordModeCacheKey = "previewRecordModeCache";
const themeStorageKey = "preferredTheme";
const navType = globalThis.performance?.getEntriesByType?.("navigation")?.[0]?.type || "";
if (navType === "reload") {
  sessionStorage.removeItem(adminSessionKey);
}

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

function getStoredTheme() {
  var stored = localStorage.getItem(themeStorageKey);
  return stored === "dark" || stored === "cyberpunk" || stored === "matrix" ? stored : "light";
}

function ensureMatrixBackground() {
  var bg = $("themeMatrixBg");
  if (!bg || bg.dataset.ready === "true") return bg;
  var reducedMotion = globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var width = Math.max(globalThis.innerWidth || 0, document.documentElement.clientWidth || 0, 1280);
  var columnCount = reducedMotion ? 14 : Math.min(44, Math.max(24, Math.floor(width / 36)));
  var matrixPhrase = "Battle Of Balls · 球球大作战";
  function buildStreamText(minLength, maxLength) {
    var length = Math.floor(minLength + Math.random() * (maxLength - minLength));
    var result = "";
    for (var j = 0; j < length; j += 1) {
      if (j > 0) result += "\n";
      result += matrixPhrase.charAt(j % matrixPhrase.length);
    }
    return result;
  }
  var fragment = document.createDocumentFragment();
  for (var i = 0; i < columnCount; i += 1) {
    var stream = document.createElement("span");
    stream.className = "matrix-stream";
    var layer = i % 5;
    var opacity = reducedMotion ? 0.2 : 0.16 + Math.random() * 0.42;
    var duration = reducedMotion ? 24 : 10 + Math.random() * 9;
    var size = layer === 0 ? 17 : layer === 1 ? 15 : layer === 2 ? 14 : layer === 3 ? 13 : 12;
    var blur = layer === 0 ? 0 : layer === 1 ? 0.15 : layer === 2 ? 0.3 : layer === 3 ? 0.55 : 0.85;
    var left = (i / columnCount) * 100 + (Math.random() * 2.8 - 1.4);
    stream.style.left = left.toFixed(2) + "%";
    stream.style.setProperty("--stream-opacity", opacity.toFixed(2));
    stream.style.setProperty("--stream-scale", (layer === 0 ? 1.14 : layer === 1 ? 1.03 : layer === 2 ? 0.96 : layer === 3 ? 0.9 : 0.84).toFixed(2));
    stream.style.setProperty("--stream-size", size + "px");
    stream.style.setProperty("--stream-blur", blur.toFixed(2) + "px");
    stream.style.setProperty("--stream-glow", layer <= 1 ? "0 0 10px rgba(76, 255, 100, 0.22), 0 0 20px rgba(76, 255, 100, 0.08)" : layer === 2 ? "0 0 8px rgba(76, 255, 100, 0.14)" : "0 0 5px rgba(76, 255, 100, 0.08)");
    stream.style.animationDelay = (Math.random() * -22).toFixed(2) + "s";
    stream.style.animationDuration = duration.toFixed(2) + "s";
    stream.textContent = buildStreamText(layer <= 1 ? 24 : 18, layer <= 1 ? 38 : 30);
    fragment.appendChild(stream);
  }
  bg.appendChild(fragment);
  bg.dataset.ready = "true";
  return bg;
}

function disposeMatrixBackground() {
  var bg = $("themeMatrixBg");
  if (!bg) return;
  bg.classList.remove("is-active");
  bg.textContent = "";
  delete bg.dataset.ready;
}

function updateThemeToggleIcon(theme) {
  const btn = $("themeToggleBtn");
  if (!btn) return;
  var labels = { light: "浅色主题", dark: "深色主题", cyberpunk: "赛博朋克主题", matrix: "矩阵主题" };
  btn.dataset.theme = theme;
  btn.setAttribute("aria-label", labels[theme] || labels.light);
  btn.setAttribute("title", labels[theme] || labels.light);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeToggleIcon(theme);
  if (theme === "matrix") {
    var bg = ensureMatrixBackground();
    if (bg) bg.classList.add("is-active");
  } else {
    disposeMatrixBackground();
  }
}

function initThemeToggle() {
  applyTheme(getStoredTheme());
  const btn = $("themeToggleBtn");
  if (!btn) return;
  btn.addEventListener("click", function (e) {
    var face = e.target.closest("[data-set-theme]");
    if (!face) return;
    var theme = face.dataset.setTheme;
    if (!theme) return;
    localStorage.setItem(themeStorageKey, theme);
    applyTheme(theme);
  });
  btn.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var face = event.target.closest("[data-set-theme]");
    if (!face) return;
    event.preventDefault();
    var theme = face.dataset.setTheme;
    localStorage.setItem(themeStorageKey, theme);
    applyTheme(theme);
  });
}

function setStatus(id, message, isError = false) {
  const node = $(id);
  if (!node) return;
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

function getImageRequestMode(taskMode) {
  return taskMode === "text" ? "generation" : "edit";
}

async function loadModels() {
  const data = await request("/api/models");
  state.allModels = data.models || [];
  renderModelOptions();
}

async function loadLlmModels() {
  try {
    const data = await request("/api/llm-models");
    state.llmModels = data.models || [];
    renderLlmModelOptions();
  } catch (error) {
    state.llmModels = [];
    $("llmModelSelect").innerHTML = `<option value="">LLM 模型加载失败</option>`;
    setStatus("optimizeStatus", error.message, true);
  }
}

function renderLlmModelOptions() {
  const select = $("llmModelSelect");
  if (!state.llmModels.length) {
    select.innerHTML = `<option value="">请在管理员配置中添加 LLM API</option>`;
    return;
  }
  const current = select.value;
  select.innerHTML = state.llmModels.map((model) =>
    `<option value="${model.id}">${escapeHtml(model.name)}（${escapeHtml(model.model)}）</option>`
  ).join("");
  select.value = state.llmModels.some((m) => m.id === current) ? current : state.llmModels[0].id;
}

function renderModelOptions() {
  const targetMode = getImageRequestMode(state.taskMode);
  state.models = state.allModels.filter((model) => getApiModes(model).includes(targetMode));
  const select = $("modelSelect");
  const currentValue = select.value;

  if (!state.models.length) {
    const label = targetMode === "edit"
      ? "当前没有可用于 edit 改图/参考图生图的模型，请在管理员中配置"
      : "当前没有可用于 generation 纯文生图的模型，请联系管理员配置";
    select.innerHTML = `<option value="">${label}</option>`;
    $("generateBtn").disabled = true;
    $("modelHint").textContent = "未配置当前任务模式的模型";
    return;
  }

  select.innerHTML = state.models.map((model) =>
    `<option value="${model.id}">${escapeHtml(model.name)} (${escapeHtml(model.model)})</option>`
  ).join("");
  select.value = state.models.some((model) => model.id === currentValue) ? currentValue : state.models[0].id;
  $("generateBtn").disabled = !state.loggedIn;
  updateModelHint();
}

function updateModelHint() {
  const selected = state.models.find((model) => model.id === $("modelSelect").value);
  const taskLabel = taskModeLabel(state.taskMode);
  $("modelHint").textContent = selected
    ? `当前模型：${selected.name} · ${selected.size} · ${taskLabel}`
    : "等待选择模型";
}

function taskModeLabel(mode) {
  if (mode === "edit") return "改图";
  if (mode === "reference") return "参考图生图";
  if (mode === "text") return "纯文生图";
  return mode;
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

function aspectShort(aspect) {
  const match = String(aspect || "").match(/^(\d+:\d+)/);
  return match ? match[1] : "16:9";
}

function setTaskMode(mode) {
  if (!["edit", "reference", "text"].includes(mode) || mode === state.taskMode) return;
  state.taskMode = mode;
  $("editTaskBtn").classList.toggle("is-active", mode === "edit");
  $("referenceTaskBtn").classList.toggle("is-active", mode === "reference");
  $("textTaskBtn").classList.toggle("is-active", mode === "text");
  updateReferenceNote();
  renderModelOptions();
}

function updateReferenceNote() {
  const note = $("referenceNote");
  if (state.taskMode === "text") {
    note.textContent = "纯文生图模式不会使用参考图。";
    return;
  }
  if (state.taskMode === "edit") {
    note.textContent = state.references.length
      ? `已选择 ${state.references.length} 张参考图，将用于改图。`
      : "改图模式下，请先上传至少一张原图。";
    return;
  }
  note.textContent = state.references.length
    ? `已选择 ${state.references.length} 张参考图，可在 prompt 中按编号描述。`
    : "参考图生图模式下，请上传至少一张参考图。";
}

// === Prompt JSON 构造（自 prompt.js 移植） ===

function lines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  const preserve = input?.mode === "edit"
    ? ["主体轮廓不变", "整体构图不变", "原有风格不变"]
    : ["主体识别度高", "构图完整"];
  const negative = ["不要文字", "不要复杂背景", "不要偏离主体"];
  const styleList = [];
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
        theme: promptParts[0] || "参考图延展设计",
        core_shape: descriptionParts[1] || "主体轮廓清晰"
      },
      design_requirements: {
        silhouette: preserve,
        features: toFeatureList(descriptionParts, preserve),
        expression_or_pose: descriptionParts[2] || input.description || plainPrompt,
        materials: ["参考图质感延展"],
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
      theme: promptParts[0] || "按需求生成",
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

function getPromptText(cards) {
  return (cards || [])
    .map((card) => String(card.content || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function outputByFormat(format) {
  return (state.promptOutputs || []).find((output) => output.format === format && output.prompt);
}

function normalizePromptOutput(output) {
  return {
    mode: String(output?.mode || "text2img"),
    format: String(output?.format || "plain") === "json" ? "json" : "plain",
    filename_suffix: String(output?.filename_suffix || ""),
    target_width: Number(output?.target_width) || 0,
    target_height: Number(output?.target_height) || 0,
    aspect_ratio: String(output?.aspect_ratio || ""),
    prompt: String(output?.prompt || ""),
    negative_prompt: String(output?.negative_prompt || "")
  };
}

function plainOutputAvailable() {
  return Boolean(outputByFormat("plain") || (!state.promptOutputs.length && state.lastGeneratedMode !== "edit" && state.lastGeneratedPrompt));
}

function jsonOutputAvailable() {
  return Boolean(outputByFormat("json") || (!state.promptOutputs.length && state.lastGeneratedMode !== "text" && state.lastGeneratedJson));
}

function currentOutputText() {
  if (state.outputView === "json") return outputByFormat("json")?.prompt || state.lastGeneratedJson || "";
  return outputByFormat("plain")?.prompt || state.lastGeneratedPrompt || "";
}

function updatePromptFormatVisibility() {
  const switcher = $("promptFormatSwitch");
  const hasPlain = plainOutputAvailable();
  const hasJson = jsonOutputAvailable();
  const showSwitcher = hasPlain && hasJson;
  switcher.hidden = !showSwitcher;
  $("plainPromptBtn").classList.toggle("is-active", state.outputView === "plain");
  $("jsonPromptBtn").classList.toggle("is-active", state.outputView === "json");
  switcher.classList.toggle("is-second-active", state.outputView === "json");
}

function setOutputView(view) {
  if (!["plain", "json"].includes(view) || view === state.outputView) return;
  if (view === "plain" && !plainOutputAvailable()) return;
  if (view === "json" && !jsonOutputAvailable()) return;
  state.outputView = view;
  $("promptInput").value = currentOutputText();
  updatePromptFormatVisibility();
}

async function optimizePrompt() {
  if (!state.loggedIn) {
    setStatus("optimizeStatus", "请先登录飞书~", true);
    return;
  }
  const modelId = $("llmModelSelect").value;
  const description = $("descriptionInput").value.trim();
  if (!modelId) {
    setStatus("optimizeStatus", "请先选择 LLM 模型，或在管理员配置中添加。", true);
    return;
  }
  if (!description) {
    setStatus("optimizeStatus", "请先填写需求描述。", true);
    return;
  }
  if ((state.taskMode === "edit" || state.taskMode === "reference") && !state.references.length) {
    setStatus("optimizeStatus", "当前任务模式需要先上传参考图。", true);
    return;
  }

  const optimizeBtn = $("optimizePromptBtn");
  optimizeBtn.disabled = true;
  optimizeBtn.textContent = "模型优化中...";
  setStatus("optimizeStatus", "正在调用 LLM 读取图片和文本，请稍等。");

  const imageDataUrls = state.references.map((item) => item.data);
  const input = {
    visitor: state.visitor,
    clientId: state.clientId,
    modelId,
    mode: state.taskMode,
    aspectRatio: aspectShort(getSelectedAspect()),
    styleTone: "",
    description,
    preserve: [],
    negative: [],
    imageDataUrls,
    imageDataUrl: imageDataUrls[0] || ""
  };

  try {
    const data = await request("/api/prompt-orchestrator/generate", {
      method: "POST",
      body: JSON.stringify(input)
    });
    if (data.needs_clarification) {
      state.promptAnalysis = data;
      state.promptOutputs = [];
      state.lastGeneratedPrompt = "";
      state.lastGeneratedJson = "";
      updatePromptFormatVisibility();
      setStatus("optimizeStatus", data.clarification_question || "需求还不明确，请补充说明。", true);
      return;
    }
    const cards = data.cards || [];
    state.promptAnalysis = data;
    state.promptOutputs = (data.outputs || []).map(normalizePromptOutput).filter((output) => output.prompt);
    state.lastGeneratedMode = state.taskMode;
    state.lastGeneratedPrompt = outputByFormat("plain")?.prompt || getPromptText(cards);
    state.lastGeneratedJson = outputByFormat("json")?.prompt || (state.taskMode === "text"
      ? ""
      : (state.lastGeneratedPrompt
        ? JSON.stringify(buildPromptJson(input, state.lastGeneratedPrompt), null, 2)
        : ""));
    state.outputView = outputByFormat("json") && state.taskMode === "edit" ? "json" : "plain";
    if (state.outputView === "json" && !jsonOutputAvailable()) state.outputView = "plain";
    if (state.outputView === "plain" && !plainOutputAvailable()) state.outputView = "json";
    $("promptInput").value = currentOutputText();
    updatePromptFormatVisibility();
    if (!currentOutputText()) {
      setStatus("optimizeStatus", "模型未返回有效 Prompt。", true);
    } else {
      setStatus("optimizeStatus", state.promptOutputs.length > 1 ? "Prompt 已生成多个版本，可切换 JSON / 自然语言后继续生图。" : "Prompt 已生成，可直接编辑或继续生图。");
    }
  } catch (error) {
    setStatus("optimizeStatus", error.message, true);
  } finally {
    optimizeBtn.disabled = false;
    optimizeBtn.textContent = "调用模型优化 Prompt";
  }
}

function clearOptimizerInputs() {
  $("descriptionInput").value = "";
  $("promptInput").value = "";
  state.lastGeneratedPrompt = "";
  state.lastGeneratedJson = "";
  state.lastGeneratedMode = "";
  state.promptAnalysis = null;
  state.promptOutputs = [];
  state.selectedPromptOutputIndex = 0;
  state.outputView = "plain";
  state.references = [];
  state.canClearReferences = false;
  renderReferenceThumbs();
  updateClearReferencesButton();
  updateReferenceNote();
  updatePromptFormatVisibility();
  setStatus("optimizeStatus", "已清空 Prompt 和参考图。");
}

async function generateImage() {
  if (!state.loggedIn) {
    setStatus("statusText", "请先登录飞书~", true);
    return;
  }
  const modelId = $("modelSelect").value;
  const aspect = getSelectedAspect();
  const count = Number($("countSelect").value);
  const quality = $("qualitySelect").value || "high";
  state.quality = quality;
  if (!modelId) {
    setStatus("statusText", "请先选择一个已配置的模型。", true);
    return;
  }
  const imageRequestMode = getImageRequestMode(state.taskMode);
  if (imageRequestMode === "edit" && !state.references.length) {
    setStatus("statusText", "当前任务模式下，请先上传至少一张参考图。", true);
    return;
  }
  const rawPrompt = $("promptInput").value.trim();
  if (!rawPrompt) {
    setStatus("statusText", "请先生成或填写 Prompt。", true);
    return;
  }

  const promptToSend = rawPrompt.includes("画面比例要求")
    ? rawPrompt
    : `${rawPrompt}\n\n画面比例要求：${aspect}。`;
  const generatedOutputPrompts = state.promptOutputs.map((output) => String(output.prompt || "").trim()).filter(Boolean);
  const canSendPromptOutputs = state.promptOutputs.length > 1 && generatedOutputPrompts.includes(rawPrompt);
  const promptOutputsToSend = canSendPromptOutputs
    ? state.promptOutputs.map((output) => ({
      ...output,
      prompt: String(output.prompt || "").includes("画面比例要求")
        ? String(output.prompt || "")
        : `${String(output.prompt || "")}\n\n画面比例要求：${aspect}。`
    }))
    : [];

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
        prompt: promptToSend,
        originalPrompt: rawPrompt,
        promptOutputs: promptOutputsToSend,
        aspect,
        count,
        quality,
        requestMode: imageRequestMode,
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
    state.userRecords = rememberLatestRecordMode(state.userRecords, imageRequestMode);
    renderRecords(state.userRecords, "userRecordsList");
    setStatus("statusText", `生成完成，共 ${state.lastImages.length} 张，记录已写入后台。`);
  } catch (error) {
    $("imageBox").innerHTML = '<div class="placeholder">生成失败，请检查模型配置或 API 返回。</div>';
    setStatus("statusText", error.message, true);
  } finally {
    $("generateBtn").disabled = !state.models.length || !state.loggedIn;
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

function syncTopbarLoginState() {
  const loggedIn = Boolean(state.loggedIn);
  $("topbarLoginBtn").classList.toggle("hidden", loggedIn);
  $("settingsBtn").classList.toggle("hidden", !loggedIn);
  $("loginBanner").classList.toggle("hidden", loggedIn);
  syncAuthGatedButtons();
}

function syncAuthGatedButtons() {
  const loggedIn = Boolean(state.loggedIn);
  const optimizeBtn = $("optimizePromptBtn");
  const generateBtn = $("generateBtn");
  if (optimizeBtn) {
    optimizeBtn.disabled = !loggedIn;
    optimizeBtn.title = loggedIn ? "" : "请先登录飞书~";
  }
  if (generateBtn) {
    generateBtn.disabled = !loggedIn || !state.models.length;
    generateBtn.title = loggedIn ? "" : "请先登录飞书~";
  }
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
    btn.disabled = !state.models.length;
    btn.title = "";
  }
  syncTopbarLoginState();
}

async function openAdmin() {
  $("adminDialog").showModal();
  setStatus("loginStatus", "");
  showAdminPanel();
  try {
    await loadAdminConfig();
  } catch (_) {}
  try {
    await loadLlmAdminConfig();
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
    const key = user.id;
    return '<article class="api-item"><div><strong>' + escapeHtml(user.name || user.openId || user.userId || user.unionId || "未命名管理员") + '</strong><div class="muted">Open ID：' + escapeHtml(user.openId || "-") + '</div><div class="muted">User ID：' + escapeHtml(user.userId || "-") + '</div><div class="muted">邮箱：' + escapeHtml(user.email || "-") + '</div><div class="muted">角色：' + (user.isSuperAdmin === false ? "普通管理员" : "超级管理员") + '</div></div><div class="api-actions"><button class="compact danger" type="button" data-delete-admin="' + escapeHtml(key) + '">移除</button></div></article>';
  }).join("");
}

function syncAdminVisibility() {
  const isAdmin = Boolean(state.currentAdmin?.isAdmin || state.currentAdmin?.isSuperAdmin);
  const isSuperAdmin = Boolean(state.currentAdmin) && state.currentAdmin.isSuperAdmin !== false && isAdmin;
  $("feishuConfigSection").classList.toggle("hidden", !isSuperAdmin);
  $("adminUsersSection").classList.toggle("hidden", !isSuperAdmin);
}

async function loadAdminMeta() {
  const data = await request("/api/admin/feishu/meta");
  state.feishuAuth = data.feishuAuth || null;
}

async function beginFeishuLogin() {
  try {
    const res = await fetch("/api/admin/feishu/login?returnTo=" + encodeURIComponent("/image.html"));
    const data = await res.json();
    if (!res.ok || !data || !data.url) {
      $("loginFailDialog").querySelector("p").textContent = data?.error || "登录失败";
      $("loginFailDialog").showModal();
      return;
    }
    window.location.href = data.url;
  } catch {
    $("loginFailDialog").querySelector("p").textContent = "登录失败";
    $("loginFailDialog").showModal();
  }
}

async function logoutAdmin() {
  await request("/api/admin/logout", { method: "POST" });
  sessionStorage.removeItem(adminSessionKey);
  state.currentAdmin = null;
  state.loggedIn = false;
  state.visitor = "";
  $("generateBtn").disabled = true;
  $("generateBtn").title = "请先登录飞书~";
  $("adminDialog").close();
  syncTopbarLoginState();
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
        name: $("adminUserName").value
      })
    });
    state.adminUsers = data.adminUsers || [];
    renderAdminUsers();
    $("adminUserStatus").textContent = "管理员名单已更新。";
    $("adminUserForm").reset();
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
      syncTopbarLoginState();
      setStatus("loginStatus", "");
      $("adminDialog").showModal();
      if (state.currentAdmin?.isAdmin || state.currentAdmin?.isSuperAdmin) {
        await loadAdminConfig();
        await loadLlmAdminConfig();
      }
    }
  } catch (sessionError) {
    setStatus("loginStatus", sessionError.message);
  }
}

async function loadAdminConfig() {
  const data = await request("/api/admin/config");
  state.adminUsers = data.adminUsers || [];
  state.feishuAuth = data.feishuAuth || null;
  state.currentAdmin = data.currentAdmin || null;
  $("feishuEnabled").checked = state.feishuAuth?.enabled !== false;
  $("feishuAppId").value = state.feishuAuth?.appId || "";
  $("feishuAppSecret").value = state.feishuAuth?.appSecret || "";
  $("feishuRedirectUri").value = state.feishuAuth?.redirectUri || "";
  renderCurrentAdmin();
  renderAdminUsers();
  syncAdminVisibility();
  renderApis(data.apis || []);
  if (!$("recordsList").children.length) {
    $("recordsList").innerHTML = '<div class="placeholder">点击"刷新记录"加载管理员记录。</div>';
  }
}

async function loadLlmAdminConfig() {
  try {
    const data = await request("/api/admin/llm-config");
    renderLlmApis(data.llmApis || []);
  } catch (error) {
    setStatus("llmApiStatus", error.message, true);
  }
}

function renderLlmApis(apis) {
  const list = $("llmApiList");
  list.innerHTML = "";
  if (!apis.length) {
    list.innerHTML = '<div class="placeholder">尚未配置 LLM 模型。新增后会立刻出现在 Prompt 优化的 LLM 模型选择框中。</div>';
    return;
  }
  apis.forEach((api) => {
    const item = document.createElement("div");
    item.className = "api-item";
    const info = document.createElement("div");
    info.innerHTML = `<strong>${escapeHtml(api.name)}</strong><span>${escapeHtml(api.model)} · 温度 ${escapeHtml(String(api.temperature ?? 0.4))}${api.enabled === false ? " · 已停用" : ""}</span>`;

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "compact";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => fillLlmApiForm(api));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "compact danger";
    del.textContent = "删除";
    del.addEventListener("click", () => deleteLlmApi(api.id));

    item.append(info, edit, del);
    list.append(item);
  });
}

function clearLlmApiForm() {
  state.editingLlmApi = null;
  $("llmApiForm").classList.remove("hidden");
  $("llmApiFormTitle").textContent = "新增 LLM 模型";
  $("llmApiId").value = "";
  $("llmApiName").value = "";
  $("llmApiModel").value = "";
  $("llmApiEndpoint").value = "";
  $("llmApiKey").value = "";
  $("llmApiTemperature").value = "0.4";
  $("llmApiEnabled").checked = true;
  setStatus("llmApiStatus", "");
}

function fillLlmApiForm(api) {
  state.editingLlmApi = api;
  $("llmApiForm").classList.remove("hidden");
  $("llmApiFormTitle").textContent = "编辑 LLM 模型";
  $("llmApiId").value = api.id || "";
  $("llmApiName").value = api.name || "";
  $("llmApiModel").value = api.model || "";
  $("llmApiEndpoint").value = api.endpoint || "";
  $("llmApiKey").value = api.apiKey || "";
  $("llmApiTemperature").value = String(api.temperature ?? 0.4);
  $("llmApiEnabled").checked = api.enabled !== false;
  setStatus("llmApiStatus", "正在编辑已有 LLM 模型。API Key 保持星号表示不修改。");
}

async function saveLlmApi(event) {
  event.preventDefault();
  setStatus("llmApiStatus", "正在保存...");
  const body = {
    id: $("llmApiId").value || undefined,
    name: $("llmApiName").value,
    model: $("llmApiModel").value,
    endpoint: $("llmApiEndpoint").value,
    apiKey: $("llmApiKey").value,
    temperature: Number($("llmApiTemperature").value) || 0.4,
    enabled: $("llmApiEnabled").checked
  };
  try {
    await request("/api/admin/llm-apis", { method: "POST", body: JSON.stringify(body) });
    setStatus("llmApiStatus", "保存成功。");
    clearLlmApiForm();
    $("llmApiForm").classList.add("hidden");
    await loadLlmAdminConfig();
    await loadLlmModels();
  } catch (error) {
    setStatus("llmApiStatus", error.message, true);
  }
}

async function deleteLlmApi(id) {
  if (!confirm("确认删除这个 LLM 模型配置？")) return;
  try {
    await request(`/api/admin/llm-apis/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadLlmAdminConfig();
    await loadLlmModels();
  } catch (error) {
    setStatus("llmApiStatus", error.message, true);
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
    var adapter = api.provider && api.provider !== "auto" ? ` · ${api.provider}` : "";
    var responses = api.useResponsesImageTool ? " · Responses 工具" : "";
    info.innerHTML = `<strong>${escapeHtml(api.name)}</strong><span>${escapeHtml(api.model)} · ${escapeHtml(formatApiModes(api))}${escapeHtml(adapter)}${escapeHtml(responses)}</span>`;

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
  $("apiProvider").value = "auto";
  $("apiEditModel").value = "";
  $("apiUseResponsesImageTool").checked = false;
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
  $("apiProvider").value = api.provider || "auto";
  $("apiEditModel").value = api.editModel || "";
  $("apiUseResponsesImageTool").checked = Boolean(api.useResponsesImageTool);
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
    provider: $("apiProvider").value || "auto",
    editModel: $("apiEditModel").value,
    useResponsesImageTool: $("apiUseResponsesImageTool").checked,
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
    const qualityText = record.quality ? ` · quality: ${escapeHtml(record.quality)}` : "";
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
        <span>生成模型：${escapeHtml(record.model || record.modelId || "-")}${qualityText}</span>
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
        <span>生成模型：${escapeHtml(record.model || record.modelId || "-")}${qualityText}</span>
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
    updateReferenceNote();
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
    updateReferenceNote();
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
  updateReferenceNote();
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

$("topbarLoginBtn").addEventListener("click", beginFeishuLogin);
$("bannerLoginBtn").addEventListener("click", beginFeishuLogin);
$("closeLoginFailBtn").addEventListener("click", () => $("loginFailDialog").close());
$("settingsBtn").addEventListener("click", openAdmin);
$("closeAdminBtn").addEventListener("click", () => $("adminDialog").close());
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
$("llmApiForm").addEventListener("submit", saveLlmApi);
$("newLlmApiBtn").addEventListener("click", clearLlmApiForm);
$("newApiBtn").addEventListener("click", clearApiForm);
$("refreshRecordsBtn").addEventListener("click", loadRecords);
$("applyFiltersBtn").addEventListener("click", () => renderRecords(getFilteredRecords(state.records, "filterUser", "filterStart", "filterEnd"), "recordsList"));
$("resetFiltersBtn").addEventListener("click", resetRecordFilters);
$("refreshUserRecordsBtn").addEventListener("click", loadUserRecords);
$("closePreviewBtn").addEventListener("click", () => $("previewDialog").close());
$("downloadAllBtn").addEventListener("click", downloadAllImages);
$("generateBtn").addEventListener("click", generateImage);
$("modelSelect").addEventListener("change", updateModelHint);
$("editTaskBtn").addEventListener("click", () => setTaskMode("edit"));
$("referenceTaskBtn").addEventListener("click", () => setTaskMode("reference"));
$("textTaskBtn").addEventListener("click", () => setTaskMode("text"));
$("optimizePromptBtn").addEventListener("click", optimizePrompt);
$("clearOptimizerBtn").addEventListener("click", clearOptimizerInputs);
$("plainPromptBtn").addEventListener("click", () => setOutputView("plain"));
$("jsonPromptBtn").addEventListener("click", () => setOutputView("json"));
$("qualitySelect").addEventListener("change", () => {
  state.quality = $("qualitySelect").value || "high";
});

initThemeToggle();
syncAuthGatedButtons();
loadAdminMeta().catch(() => {});
checkAdminSessionAfterRedirect().catch(() => {});
fetchVisitorFromSession().catch(() => {});
loadModels().catch((error) => setStatus("statusText", error.message, true));
loadLlmModels().catch(() => {});
loadUserRecords().catch((error) => setStatus("statusText", error.message, true));
updateReferenceNote();
updatePromptFormatVisibility();
