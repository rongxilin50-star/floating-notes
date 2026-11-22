const DB_NAME = "floating-notes-fs";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const DIRECTORY_KEY = "notes-directory";

const DEFAULTS = {
  backgroundOpacity: 0.9,
  textOpacity: 1,
  editorFontSize: 14,
  fullscreenPolicy: "keep",
  clickThrough: false,
  language: "auto",
  directoryDisplayPath: "D:\\0实习",
  theme: "auto",
  fileNameTemplate: "{date}_{title}.md",
  blockedSites: []
};

let preferences = { ...DEFAULTS };

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  const stored = await chrome.storage.local.get(["fnPreferences"]);
  const saved = stored.fnPreferences || {};
  preferences = {
    ...DEFAULTS,
    ...saved,
    backgroundOpacity: saved.backgroundOpacity ?? saved.opacity ?? DEFAULTS.backgroundOpacity,
    textOpacity: saved.textOpacity ?? DEFAULTS.textOpacity,
    editorFontSize: saved.editorFontSize ?? DEFAULTS.editorFontSize
  };
  fillForm();
  bindEvents();
  await Promise.all([refreshDirectoryStatus(), renderShortcuts()]);
}

function fillForm() {
  $("backgroundOpacity").value = Math.round(preferences.backgroundOpacity * 100);
  $("backgroundOpacityValue").textContent = `${Math.round(preferences.backgroundOpacity * 100)}%`;
  $("textOpacity").value = Math.round(preferences.textOpacity * 100);
  $("textOpacityValue").textContent = `${Math.round(preferences.textOpacity * 100)}%`;
  $("editorFontSize").value = String(preferences.editorFontSize);
  $("fullscreenPolicy").value = preferences.fullscreenPolicy || "keep";
  $("theme").value = preferences.theme;
  $("clickThrough").checked = Boolean(preferences.clickThrough);
  $("language").value = preferences.language || "auto";
  $("directoryDisplayPath").value = preferences.directoryDisplayPath || "D:\\0实习";
  $("fileNameTemplate").value = preferences.fileNameTemplate;
  $("blockedSites").value = (preferences.blockedSites || []).join("\n");
  updateFileNamePreview();
  applyOptionsLanguage();
}

function bindEvents() {
  $("backgroundOpacity").addEventListener("input", () => {
    $("backgroundOpacityValue").textContent = `${$("backgroundOpacity").value}%`;
    preferences.backgroundOpacity = Number($("backgroundOpacity").value) / 100;
    savePreferences();
  });

  $("textOpacity").addEventListener("input", () => {
    $("textOpacityValue").textContent = `${$("textOpacity").value}%`;
    preferences.textOpacity = Number($("textOpacity").value) / 100;
    savePreferences();
  });

  $("editorFontSize").addEventListener("change", () => {
    preferences.editorFontSize = Number($("editorFontSize").value);
    savePreferences();
  });

  $("fullscreenPolicy").addEventListener("change", () => {
    preferences.fullscreenPolicy = $("fullscreenPolicy").value;
    savePreferences();
  });

  $("theme").addEventListener("change", () => {
    preferences.theme = $("theme").value;
    savePreferences();
  });

  $("clickThrough").addEventListener("change", () => {
    preferences.clickThrough = $("clickThrough").checked;
    savePreferences();
  });

  $("language").addEventListener("change", () => {
    preferences.language = $("language").value;
    applyOptionsLanguage();
    renderShortcuts();
    refreshDirectoryStatus();
    savePreferences();
  });

  $("directoryDisplayPath").addEventListener("input", debounce(() => {
    preferences.directoryDisplayPath = $("directoryDisplayPath").value.trim();
    savePreferences();
  }, 300));

  $("fileNameTemplate").addEventListener("input", () => {
    preferences.fileNameTemplate = $("fileNameTemplate").value.trim() || "{date}_{title}.md";
    updateFileNamePreview();
    savePreferences();
  });

  $("blockedSites").addEventListener("input", debounce(() => {
    preferences.blockedSites = $("blockedSites").value.split(/\r?\n/).map((item) => item.trim().toLowerCase()).filter(Boolean);
    savePreferences();
  }, 350));

  $("chooseDirectory").addEventListener("click", chooseDirectory);
  $("requestPermission").addEventListener("click", requestDirectoryPermission);
  $("syncAll").addEventListener("click", syncAll);
  $("openShortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
  $("exportData").addEventListener("click", exportData);
  $("importData").addEventListener("change", importData);
  $("clearData").addEventListener("click", clearData);
}

async function savePreferences() {
  await chrome.storage.local.set({ fnPreferences: preferences });
}

async function chooseDirectory() {
  if (!("showDirectoryPicker" in window)) {
    setMessage("directoryMessage", optionText("当前浏览器不支持文件夹授权，请升级 Chrome 或 Edge。", "Folder access is unavailable. Please update Chrome or Edge."), "error");
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ id: "floating-notes-directory", mode: "readwrite" });
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      setMessage("directoryMessage", optionText("未获得写入权限，笔记仍会保存在浏览器本地。", "Write permission was not granted. Notes remain saved in browser storage."), "error");
      return;
    }
    await storeDirectoryHandle(handle);
    setMessage("directoryMessage", optionText(`已授权“${handle.name}”，正在同步笔记……`, `“${handle.name}” authorized. Syncing notes…`), "success");
    await refreshDirectoryStatus();
    await syncAll();
  } catch (error) {
    if (error.name !== "AbortError") setMessage("directoryMessage", `选择失败：${error.message}`, "error");
  }
}

async function requestDirectoryPermission() {
  try {
    const handle = await getDirectoryHandle();
    if (!handle) {
      setMessage("directoryMessage", optionText("请先选择笔记文件夹。", "Choose a note folder first."), "error");
      return;
    }
    const permission = await handle.requestPermission({ mode: "readwrite" });
    setMessage("directoryMessage", permission === "granted" ? optionText("目录权限已恢复。", "Folder permission restored.") : optionText("目录权限未获得。", "Folder permission was not granted."), permission === "granted" ? "success" : "error");
    await refreshDirectoryStatus();
    if (permission === "granted") await syncAll();
  } catch (error) {
    setMessage("directoryMessage", `授权失败：${error.message}`, "error");
  }
}

async function syncAll() {
  $("syncAll").disabled = true;
  setMessage("directoryMessage", optionText("正在同步……", "Syncing…"));
  try {
    const result = await chrome.runtime.sendMessage({ type: "FN_SYNC_ALL" });
    if (result?.ok) setMessage("directoryMessage", optionText(`同步完成，共处理 ${result.results.length} 篇笔记。`, `Sync complete. ${result.results.length} notes processed.`), "success");
    else {
      const status = result?.results?.[0]?.status;
      const text = status === "permission-required" ? "目录需要重新授权。" : status === "not-configured" ? "请先选择笔记文件夹。" : "部分笔记同步失败，请稍后重试。";
      setMessage("directoryMessage", text, "error");
    }
  } catch (error) {
    setMessage("directoryMessage", `同步失败：${error.message}`, "error");
  } finally {
    $("syncAll").disabled = false;
    await refreshDirectoryStatus();
  }
}

async function refreshDirectoryStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "FN_DIRECTORY_STATUS" });
    const badge = $("directoryBadge");
    badge.className = "badge";
    if (status.status === "ready") {
      badge.textContent = optionText("可以同步", "Ready");
      badge.classList.add("success");
      $("directoryName").textContent = status.name;
    } else if (status.status === "permission-required") {
      badge.textContent = optionText("需要授权", "Permission needed");
      badge.classList.add("warning");
      $("directoryName").textContent = status.name || "已选择的文件夹";
    } else if (status.status === "error") {
      badge.textContent = optionText("读取失败", "Read failed");
      badge.classList.add("error");
    } else {
      badge.textContent = optionText("尚未配置", "Not configured");
      badge.classList.add("warning");
      $("directoryName").textContent = optionText("未选择（建议选择 D:\\0实习）", "Not selected (D:\\0实习 recommended)");
    }
  } catch (error) {
    setMessage("directoryMessage", `状态读取失败：${error.message}`, "error");
  }
}

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const labels = {
    "toggle-note": optionText("显示或隐藏当前便签", "Show or hide the current note"),
    "new-note": optionText("新建一篇笔记", "Create a new note"),
    "toggle-click-through": optionText("开启或关闭鼠标穿透", "Toggle mouse click-through")
  };
  const list = $("shortcutList");
  list.replaceChildren();
  commands.filter((command) => labels[command.name]).forEach((command) => {
    const row = document.createElement("div");
    row.className = "shortcut";
    row.innerHTML = `<div><strong></strong><small></small></div><kbd></kbd>`;
    row.querySelector("strong").textContent = labels[command.name];
    row.querySelector("small").textContent = command.name;
    const key = row.querySelector("kbd");
    key.textContent = command.shortcut || optionText("未绑定", "Unbound");
    key.classList.toggle("missing", !command.shortcut);
    list.append(row);
  });
}

function updateFileNamePreview() {
  const now = new Date();
  const values = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}-${pad(now.getMinutes())}`,
    title: "网页标题",
    domain: "example.com"
  };
  let value = ($("fileNameTemplate").value || "{date}_{title}.md").replace(/\{(date|time|title|domain)\}/g, (_, key) => values[key]);
  if (!value.toLowerCase().endsWith(".md")) value += ".md";
  $("fileNamePreview").textContent = value.replace(/[\\/:*?"<>|]/g, "_");
}

function applyOptionsLanguage() {
  const en = optionsLanguage() === "en";
  document.documentElement.lang = en ? "en" : "zh-CN";
  document.title = en ? "Floating Notes Settings" : "浮笺设置";
  const set = (selector, zh, english) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = en ? english : zh;
  };
  const leading = (selector, zh, english) => {
    const element = document.querySelector(selector);
    if (!element) return;
    const node = [...element.childNodes].find((item) => item.nodeType === Node.TEXT_NODE);
    if (node) node.textContent = en ? english : zh;
  };

  set(".hero h1", "浮笺设置", "Floating Notes Settings");
  set(".hero > div > p:last-child", "网页与全屏视频上的本地悬浮笔记", "Local floating notes for web pages and fullscreen video");
  const headings = [...document.querySelectorAll(".card h2")];
  const headingPairs = [
    ["Markdown 保存目录", "Markdown folder"], ["显示外观", "Appearance"], ["文件命名", "File naming"],
    ["快捷键", "Shortcuts"], ["快速使用方法", "Quick guide"], ["网站黑名单", "Blocked websites"], ["数据备份", "Data backup"]
  ];
  headingPairs.forEach((pair, index) => { if (headings[index]) headings[index].textContent = en ? pair[1] : pair[0]; });
  set("#chooseDirectory", "选择文件夹", "Choose folder");
  set("#requestPermission", "重新授权", "Grant permission again");
  set("#syncAll", "立即同步全部笔记", "Sync all notes now");
  set("#openShortcuts", "在浏览器中修改", "Edit in browser");
  set("#exportData", "导出全部数据", "Export all data");
  set(".file-button span", "导入备份", "Import backup");
  set("#clearData", "清除所有笔记", "Delete all notes");
  set(".privacy h2", "隐私说明", "Privacy");
  set("footer", "设置会自动保存 · 浮笺 V2.1.0", "Settings save automatically · Floating Notes V2.1.0");
  set(".directory-box small", "当前目录", "Current folder");
  set(".path-label > span", "路径备注（浏览器不会提供完整磁盘路径，仅用于帮助你识别）", "Path label (the browser does not expose the full disk path; this is only for identification)");
  leading(".two-columns > div:first-child .field:nth-of-type(2) > span", "背景透明度 ", "Background opacity ");
  leading(".two-columns > div:first-child .field:nth-of-type(3) > span", "文字透明度 ", "Text opacity ");
  set(".two-columns > div:first-child .field:nth-of-type(4) > span", "默认字号", "Default font size");
  set(".two-columns > div:first-child .field:nth-of-type(5) > span", "进入全屏时", "On entering fullscreen");
  set(".two-columns > div:first-child .field:nth-of-type(6) > span", "主题", "Theme");
  set(".toggle-row strong", "默认鼠标穿透", "Mouse click-through by default");
  set(".toggle-row small", "需要使用快捷键退出", "Use the shortcut to exit");
  set(".two-columns > div:nth-child(2) .field > span", "Markdown 文件名模板", "Markdown filename template");
  set(".two-columns > div:nth-child(2) .hint", "支持 {date}、{time}、{title}、{domain}", "Supports {date}, {time}, {title}, {domain}");
  set(".preview small", "预览", "Preview");
  set(".shortcut-list + .hint", "浏览器和操作系统快捷键始终优先。若显示“未绑定”，请点击上方按钮重新设置。", "Browser and operating-system shortcuts take priority. If a command is unbound, use the button above to set it.");
  set(".privacy p:nth-of-type(1)", "浮笺默认不连接远程服务器，不上传笔记、浏览历史或网页正文。网页权限仅用于显示悬浮窗口以及在用户主动操作时读取当前网页标题、地址和视频进度。笔记保存在浏览器本地及用户主动授权的本地文件夹中。", "Floating Notes does not connect to a remote server by default and does not upload notes, browsing history, or page content. Page access is used only to show the overlay and, on your action, read the page title, URL, and video time. Notes stay in browser storage and your authorized local folder.");
  set(".privacy p:nth-of-type(2)", "浏览器内部页面、扩展商店及部分受保护播放器不允许扩展运行，这是浏览器的安全限制。", "Browser internal pages, extension stores, and some protected players do not allow extensions to run.");
  $("blockedSites").placeholder = en ? "One domain per line" : "每行一个域名";

  const themeOptions = $("theme").options;
  [en ? "Follow system" : "跟随系统", en ? "Light" : "浅色", en ? "Dark" : "深色"].forEach((label, index) => { themeOptions[index].textContent = label; });
  const languageOptions = $("language").options;
  languageOptions[0].textContent = en ? "Follow browser / Auto" : "跟随浏览器 / Auto";
  const fullscreenOptions = $("fullscreenPolicy").options;
  [en ? "Keep current state" : "保持当前显示状态", en ? "Hide automatically" : "自动隐藏", en ? "Show automatically" : "自动显示"].forEach((label, index) => { fullscreenOptions[index].textContent = label; });

  const descriptions = document.querySelectorAll(".description");
  if (descriptions[0]) descriptions[0].textContent = en ? "Notes are first stored in the browser. After folder permission is granted, they also sync as UTF-8 Markdown files." : "笔记会先保存在浏览器本地。授权文件夹后，再自动同步为 UTF-8 Markdown 文件。";
  if (descriptions[1]) descriptions[1].textContent = en ? "Enter one domain per line. Floating Notes will not automatically reappear on these sites." : "每行填写一个域名。在这些网站中，浮笺不会自动恢复显示。示例：bank.example.com";

  const usage = document.querySelectorAll(".usage-grid div");
  const usagePairs = [
    ["移动与缩放", "拖动便签顶部移动，拖动右下角调整大小。", "Move and resize", "Drag the header to move and the lower-right corner to resize."],
    ["视频全屏", "进入支持的网页全屏后，使用显示快捷键唤醒并继续输入。", "Fullscreen video", "Use the show shortcut to keep writing over supported fullscreen players."],
    ["打开链接", "直接输入或粘贴网址，离开编辑区后会自动变成可点击链接。", "Open links", "Typed or pasted URLs become clickable when the editor loses focus."],
    ["保存与导出", "笔记自动保存在浏览器本地；“导出”可下载当前 Markdown。", "Save and export", "Notes autosave locally; Export downloads the current Markdown file."],
    ["鼠标穿透", "开启后用 Alt+Shift+P 恢复鼠标操作。", "Click-through", "Press Alt+Shift+P to regain mouse control."],
    ["文字格式", "工具栏支持撤销、粗体、斜体、下划线、删除线、列表、颜色和字号。", "Text formatting", "The toolbar supports undo, bold, italic, underline, strike, lists, color and size."]
  ];
  usagePairs.forEach((pair, index) => {
    if (!usage[index]) return;
    usage[index].querySelector("strong").textContent = en ? pair[2] : pair[0];
    usage[index].querySelector("p").textContent = en ? pair[3] : pair[1];
  });
}

function optionsLanguage() {
  if (preferences.language === "zh-CN" || preferences.language === "en") return preferences.language;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function optionText(zh, english) {
  return optionsLanguage() === "en" ? english : zh;
}

async function exportData() {
  const data = await chrome.storage.local.get(null);
  const payload = JSON.stringify({ format: "floating-notes-backup", version: 1, exportedAt: new Date().toISOString(), data }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `浮笺备份_${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setMessage("dataMessage", optionText("备份文件已导出。", "Backup exported."), "success");
}

async function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload.format !== "floating-notes-backup" || !payload.data || !Array.isArray(payload.data.fnNotes)) throw new Error("不是有效的浮笺备份文件");
    if (!confirm(`即将导入 ${payload.data.fnNotes.length} 篇笔记，并覆盖当前设置。是否继续？`)) return;
    await chrome.storage.local.set(payload.data);
    setMessage("dataMessage", "数据导入完成，请刷新已打开的网页。", "success");
    const stored = await chrome.storage.local.get("fnPreferences");
    preferences = { ...DEFAULTS, ...(stored.fnPreferences || {}) };
    fillForm();
  } catch (error) {
    setMessage("dataMessage", `导入失败：${error.message}`, "error");
  } finally {
    event.target.value = "";
  }
}

async function clearData() {
  if (!confirm("确定清除所有笔记吗？此操作不会删除已经写入本地文件夹的 Markdown 文件。")) return;
  if (!confirm("再次确认：浏览器中的全部浮笺笔记将被清除。")) return;
  await chrome.storage.local.set({ fnNotes: [], fnCurrentNoteId: null });
  setMessage("dataMessage", "浏览器中的笔记已清除。", "success");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeDirectoryHandle(handle) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readwrite");
    tx.objectStore(HANDLE_STORE).put(handle, DIRECTORY_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function getDirectoryHandle() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readonly");
    const request = tx.objectStore(HANDLE_STORE).get(DIRECTORY_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

function setMessage(id, text, type = "") {
  const element = $(id);
  element.textContent = text;
  element.className = `message${type ? ` ${type}` : ""}`;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function $(id) {
  return document.getElementById(id);
}

