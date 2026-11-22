const DB_NAME = "floating-notes-fs";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const DIRECTORY_KEY = "notes-directory";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["fnNotes", "fnPreferences"]);
  const patch = {};

  if (!Array.isArray(existing.fnNotes)) patch.fnNotes = [];
  if (!existing.fnPreferences) {
    patch.fnPreferences = {
      backgroundOpacity: 0.9,
      textOpacity: 1,
      editorFontSize: 14,
      fullscreenPolicy: "keep",
      clickThrough: false,
      language: "auto",
      directoryDisplayPath: "D:\\0实习",
      theme: "auto",
      fileNameTemplate: "{date}_{title}.md",
      normalPosition: { right: 24, top: 88 },
      fullscreenPosition: { right: 24, top: 24 },
      size: { width: 330, height: 240 },
      blockedSites: []
    };
  }

  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.action.onClicked.addListener(handleActionClick);

async function handleActionClick(tab) {
  if (!tab?.id) return;
  await clearActionState(tab.id);
  if (isRestrictedPage(tab.url || tab.pendingUrl || "")) {
    await showRestrictedPageHint(tab.id);
    return;
  }
  await sendToTab(tab.id, { type: "FN_TOGGLE" });
}

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const typeByCommand = {
    "toggle-note": "FN_TOGGLE",
    "new-note": "FN_NEW_NOTE",
    "toggle-click-through": "FN_TOGGLE_CLICK_THROUGH"
  };

  const type = typeByCommand[command];
  if (type) await sendToTab(tab.id, { type });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove(`fnTab:${tabId}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === "FN_GET_TAB_STATE") {
    const key = `fnTab:${sender.tab?.id ?? "unknown"}`;
    chrome.storage.session.get(key).then((result) => {
      sendResponse(result[key] || { visible: false });
    });
    return true;
  }

  if (message.type === "FN_SET_TAB_STATE") {
    const key = `fnTab:${sender.tab?.id ?? "unknown"}`;
    chrome.storage.session.set({ [key]: message.state || { visible: false } }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "FN_SYNC_NOTE") {
    syncNoteToMarkdown(message.note).then(sendResponse);
    return true;
  }

  if (message.type === "FN_SYNC_ALL") {
    syncAllNotes().then(sendResponse);
    return true;
  }

  if (message.type === "FN_DIRECTORY_STATUS") {
    getDirectoryStatus().then(sendResponse);
    return true;
  }

  if (message.type === "FN_GET_SHORTCUTS") {
    chrome.commands.getAll().then((commands) => sendResponse({ commands }));
    return true;
  }

  if (message.type === "FN_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, message: error.message });
    });
    return true;
  }

  return false;
});

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    await clearActionState(tabId);
    return true;
  } catch (error) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tabId, message);
      await clearActionState(tabId);
      return true;
    } catch (injectionError) {
      await showRestrictedPageHint(tabId);
      return false;
    }
  }
}

function isRestrictedPage(url) {
  if (!url) return false;
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "chromewebstore.google.com" || (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"));
  } catch {
    return true;
  }
}

async function clearActionState(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: chrome.i18n.getMessage("actionTitle") }).catch(() => {});
}

async function showRestrictedPageHint(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: chrome.i18n.getMessage("restrictedPageTitle") }).catch(() => {});
}

function openHandleDatabase() {
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

async function getDirectoryHandle() {
  const db = await openHandleDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, "readonly");
    const request = tx.objectStore(HANDLE_STORE).get(DIRECTORY_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function getDirectoryStatus() {
  try {
    const handle = await getDirectoryHandle();
    if (!handle) return { status: "not-configured" };
    const permission = await handle.queryPermission({ mode: "readwrite" });
    return { status: permission === "granted" ? "ready" : "permission-required", name: handle.name };
  } catch (error) {
    return { status: "error", message: error.message };
  }
}

async function syncAllNotes() {
  const { fnNotes = [] } = await chrome.storage.local.get("fnNotes");
  const results = [];
  for (const note of fnNotes.filter((item) => !item.deletedAt)) {
    results.push(await syncNoteToMarkdown(note));
  }
  return { ok: results.every((item) => item.ok), results };
}

async function syncNoteToMarkdown(note) {
  if (!note?.id) return { ok: false, status: "invalid-note" };

  try {
    const handle = await getDirectoryHandle();
    if (!handle) {
      await updateNoteSyncStatus(note.id, "pending");
      return { ok: false, status: "not-configured" };
    }

    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      await updateNoteSyncStatus(note.id, "pending");
      return { ok: false, status: "permission-required" };
    }

    const { fnPreferences = {} } = await chrome.storage.local.get("fnPreferences");
    const fileName = await resolveFileName(handle, note, fnPreferences.fileNameTemplate || "{date}_{title}.md");
    const fileHandle = await handle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(buildMarkdown(note));
    await writable.close();
    await updateNoteSyncStatus(note.id, "synced", fileName);
    return { ok: true, status: "synced", fileName };
  } catch (error) {
    await updateNoteSyncStatus(note.id, "error");
    return { ok: false, status: "error", message: error.message };
  }
}

function buildMarkdown(note) {
  const sources = Array.isArray(note.sources) ? note.sources : [];
  const sourceLines = sources.map((source) => {
    const time = Number.isFinite(source.videoTime) ? ` @ ${formatTime(source.videoTime)}` : "";
    return `- [${escapeMarkdown(source.pageTitle || source.url)}](${source.url})${time}`;
  });

  return [
    "---",
    `title: "${String(note.title || "未命名笔记").replaceAll('"', '\\"')}"`,
    `created: "${note.createdAt || new Date().toISOString()}"`,
    `updated: "${note.updatedAt || new Date().toISOString()}"`,
    `note_id: "${note.id}"`,
    "---",
    "",
    `# ${note.title || "未命名笔记"}`,
    "",
    note.content || "",
    ...(sourceLines.length ? ["", "## 来源", "", ...sourceLines] : []),
    ""
  ].join("\n");
}

function buildFileName(note, template) {
  const date = new Date(note.createdAt || Date.now());
  const values = {
    date: localDate(date),
    time: `${pad(date.getHours())}-${pad(date.getMinutes())}`,
    title: note.title || "未命名笔记",
    domain: safeDomain(note.sources?.[0]?.url)
  };

  let name = template.replace(/\{(date|time|title|domain)\}/g, (_, key) => values[key]);
  if (!name.toLowerCase().endsWith(".md")) name += ".md";
  name = name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return name.slice(0, 180) || `${values.date}_未命名笔记.md`;
}

async function resolveFileName(directoryHandle, note, template) {
  if (note.fileName) return note.fileName;
  const baseName = buildFileName(note, template);
  const extensionIndex = baseName.toLowerCase().lastIndexOf(".md");
  const stem = extensionIndex >= 0 ? baseName.slice(0, extensionIndex) : baseName;

  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? `${stem}.md` : `${stem}_${index}.md`;
    try {
      const existingHandle = await directoryHandle.getFileHandle(candidate);
      const existingFile = await existingHandle.getFile();
      const beginning = await existingFile.slice(0, 4096).text();
      if (beginning.includes(`note_id: "${note.id}"`)) return candidate;
    } catch (error) {
      if (error.name === "NotFoundError") return candidate;
      throw error;
    }
  }

  return `${stem}_${note.id.slice(0, 8)}.md`;
}

async function updateNoteSyncStatus(id, syncStatus, fileName) {
  const { fnNotes = [] } = await chrome.storage.local.get("fnNotes");
  const index = fnNotes.findIndex((note) => note.id === id);
  if (index === -1) return;
  fnNotes[index] = { ...fnNotes[index], syncStatus, ...(fileName ? { fileName } : {}) };
  await chrome.storage.local.set({ fnNotes });
}

function escapeMarkdown(value) {
  return String(value || "").replace(/[\[\]]/g, "\\$&");
}

function safeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "网页";
  } catch {
    return "网页";
  }
}

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

