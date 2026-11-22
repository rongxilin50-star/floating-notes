(() => {
  if (globalThis.__floatingNotesLoaded || window !== window.top) return;
  globalThis.__floatingNotesLoaded = true;

  const STORAGE_KEYS = ["fnNotes", "fnCurrentNoteId", "fnPreferences"];
  const DEFAULT_PREFERENCES = {
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

  let notes = [];
  let currentNoteId = null;
  let preferences = { ...DEFAULT_PREFERENCES };
  let tabState = { visible: false, pendingResume: false };
  let host;
  let shadow;
  let saveTimer;
  let statusTimer;
  let savedEditorRange = null;
  let collapsedDragConsumed = false;
  let isFullscreen = Boolean(document.fullscreenElement);
  let initialized = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) return false;
    initialize().then(() => {
      if (message.type === "FN_TOGGLE") toggleVisible();
      if (message.type === "FN_NEW_NOTE") newNote(true);
      if (message.type === "FN_TOGGLE_CLICK_THROUGH") toggleClickThrough();
      sendResponse({ ok: true });
    });
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !initialized) return;

    if (changes.fnPreferences?.newValue) {
      preferences = { ...DEFAULT_PREFERENCES, ...changes.fnPreferences.newValue };
      applyAppearance();
      if (isBlockedSite() && tabState.visible) hideHost(false);
    }

    if (Array.isArray(changes.fnNotes?.newValue)) {
      const incoming = changes.fnNotes.newValue;
      notes = mergeNotes(notes, incoming);
      renderCurrentNote(false);
      renderTimestampChips();
      updateSaveStatus();
    }

    if (changes.fnCurrentNoteId?.newValue && changes.fnCurrentNoteId.newValue !== currentNoteId) {
      currentNoteId = changes.fnCurrentNoteId.newValue;
      renderCurrentNote(true);
    }
  });

  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("loadedmetadata", refreshTimestampButton, true);
  document.addEventListener("durationchange", refreshTimestampButton, true);
  document.addEventListener("yt-navigate-finish", refreshTimestampButton, true);

  initialize();

  function handleFullscreenChange() {
    const wasFullscreen = isFullscreen;
    isFullscreen = Boolean(document.fullscreenElement);
    if (wasFullscreen === isFullscreen || !host) return;

    if (isFullscreen && preferences.fullscreenPolicy === "hide" && tabState.visible) {
      hideHost(false);
      return;
    }
    if (isFullscreen && preferences.fullscreenPolicy === "show" && !tabState.visible) {
      showHost(false);
      return;
    }

    mountHostForContext();
    applySavedGeometry();
    if (!tabState.visible) {
      host.hidden = true;
      host.style.display = "none";
      return;
    }

    host.hidden = false;
    host.style.display = "block";
    try {
      if (host.hasAttribute("popover") && typeof host.showPopover === "function" && !host.matches(":popover-open")) host.showPopover();
    } catch {}
  }

  async function initialize() {
    if (initialized) return;
    const stored = await chrome.storage.local.get(STORAGE_KEYS);
    notes = Array.isArray(stored.fnNotes) ? stored.fnNotes : [];
    const savedPreferences = stored.fnPreferences || {};
    preferences = {
      ...DEFAULT_PREFERENCES,
      ...savedPreferences,
      backgroundOpacity: savedPreferences.backgroundOpacity ?? savedPreferences.opacity ?? DEFAULT_PREFERENCES.backgroundOpacity,
      textOpacity: savedPreferences.textOpacity ?? DEFAULT_PREFERENCES.textOpacity,
      editorFontSize: savedPreferences.editorFontSize ?? DEFAULT_PREFERENCES.editorFontSize
    };
    currentNoteId = stored.fnCurrentNoteId || notes.find((note) => !note.deletedAt)?.id || null;

    if (preferences.clickThrough && !(await hasClickThroughShortcut())) {
      preferences.clickThrough = false;
      await chrome.storage.local.set({ fnPreferences: preferences });
    }

    try {
      tabState = await chrome.runtime.sendMessage({ type: "FN_GET_TAB_STATE" }) || tabState;
      tabState.visible = false;
    } catch {
      tabState = { visible: false, pendingResume: false };
    }

    createUi();
    initialized = true;

    if (isBlockedSite()) {
      tabState.visible = false;
      await saveTabState();
      return;
    }

    if (tabState.visible) {
      await ensureCurrentNote();
      showHost(false);
    }
  }

  function createUi() {
    host = document.createElement("div");
    host.id = "floating-notes-extension-root";
    host.setAttribute("popover", "manual");
    host.setAttribute("aria-label", "浮笺悬浮笔记");
    Object.assign(host.style, {
      position: "fixed",
      zIndex: "2147483647",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      color: "inherit",
      maxWidth: "none",
      maxHeight: "none",
      overflow: "visible"
    });

    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `${styles()}${markup()}`;
    document.documentElement.append(host);
    host.hidden = true;
    host.style.display = "none";

    bindUi();
    applyAppearance();
    applySavedGeometry();
  }

  function markup() {
    return `
      <section class="shell" aria-label="浮笺编辑器">
        <header class="header" data-drag-handle>
          <span class="grip" aria-hidden="true">⠿</span>
          <input class="title" aria-label="笔记标题" maxlength="120" placeholder="未命名笔记" />
          <button class="icon tool-toggle" title="展开工具" aria-label="展开工具" aria-expanded="false">•••</button>
          <button class="icon collapse-button" title="折叠" aria-label="折叠">−</button>
          <button class="icon close-button" title="隐藏便签" aria-label="隐藏便签">×</button>
        </header>

        <div class="body">
          <div class="timestamp-strip" aria-label="笔记中的视频时间戳"></div>
          <div class="editor" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="富文本笔记内容" data-placeholder="在这里记录……"></div>

          <section class="tool-drawer" hidden aria-label="笔记工具">
            <nav class="drawer-tabs" aria-label="工具分类">
              <button class="drawer-tab active" data-drawer-target="format">格式</button>
              <button class="drawer-tab" data-drawer-target="context">上下文</button>
              <button class="drawer-tab" data-drawer-target="notes">笔记</button>
              <button class="drawer-tab" data-drawer-target="display">显示</button>
            </nav>

            <div class="drawer-section format-section active" data-drawer-section="format">
              <nav class="formatting" aria-label="文字格式">
                <button data-command="undo" title="撤销 (Ctrl+Z)">↶</button>
                <button data-command="redo" title="重做 (Ctrl+Y)">↷</button>
                <i></i>
                <button data-command="bold" title="加粗 (Ctrl+B)"><b>B</b></button>
                <button data-command="italic" title="斜体 (Ctrl+I)"><em>I</em></button>
                <button data-command="underline" title="下划线 (Ctrl+U)"><u>U</u></button>
                <button data-command="strikeThrough" title="删除线"><s>S</s></button>
                <button data-command="insertOrderedList" title="有序列表">1.</button>
                <button data-command="insertUnorderedList" title="无序列表">•</button>
                <button data-command="formatBlock" data-command-value="blockquote" title="引用">“</button>
                <button data-command="formatBlock" data-command-value="pre" title="代码块">&lt;/&gt;</button>
                <label class="color-control" title="字体颜色"><span>A</span><input class="font-color" type="color" value="#5f8066" /></label>
              </nav>
            </div>

            <div class="drawer-section context-section" data-drawer-section="context">
              <nav class="actions" aria-label="上下文操作">
                <button class="action timestamp-button" title="插入当前视频时间">⏱ 时间戳</button>
                <button class="action link-button" title="插入当前网页标题和链接">↗ 插入网页</button>
                <span class="context-summary">当前页面尚未关联</span>
              </nav>
            </div>

            <div class="drawer-section notes-section" data-drawer-section="notes">
              <nav class="actions" aria-label="笔记操作">
                <button class="action new-button">＋ 新建</button>
                <button class="action switch-button">☰ 切换</button>
                <button class="action export-button">⇩ 导出</button>
                <button class="action storage-button">⌂ 保存位置</button>
                <button class="action help-button">? 使用帮助</button>
              </nav>
            </div>

            <div class="drawer-section display-section" data-drawer-section="display">
              <div class="display-presets">
                <button data-visual-preset="clear">清晰</button>
                <button data-visual-preset="glass">半透明</button>
                <button data-visual-preset="minimal">极简</button>
                <button class="settings-button" title="完整显示设置">⚙</button>
              </div>
              <div class="display-controls">
                <label>字号<select class="editor-font-size"><option value="12">12</option><option value="14">14</option><option value="16">16</option><option value="18">18</option><option value="20">20</option></select></label>
                <label>背景<input class="background-opacity-range" type="range" min="20" max="100" step="1" /><output class="background-opacity-value">90%</output></label>
                <label>文字<input class="text-opacity-range" type="range" min="40" max="100" step="1" /><output class="text-opacity-value">100%</output></label>
              </div>
            </div>
          </section>

          <footer class="footer">
            <button class="context-chip" title="插入或查看当前网页来源">当前网页</button>
            <span class="save-status"><i></i><span>已保存到本地</span></span>
            <button class="storage-status" title="查看保存位置">本地存储</button>
            <span class="shortcut-hint" title="显示/隐藏快捷键">⌥⇧N</span>
          </footer>
        </div>

        <aside class="quick-settings" hidden>
          <div class="panel-heading"><strong>显示设置</strong><button class="panel-close" aria-label="关闭设置">×</button></div>
          <label><span>背景透明度</span><output class="opacity-value">90%</output></label>
          <input class="opacity-range" type="range" min="20" max="100" step="1" />
          <label><span>文字透明度</span><output class="quick-text-opacity-value">100%</output></label>
          <input class="quick-text-opacity-range" type="range" min="40" max="100" step="1" />
          <label><span>默认字号</span><select class="quick-editor-font-size"><option value="12">12px</option><option value="14">14px</option><option value="16">16px</option><option value="18">18px</option><option value="20">20px</option></select></label>
          <label class="check-row"><input class="click-through-check" type="checkbox" /> 鼠标穿透</label>
          <label><span>语言 / Language</span><select class="language-select"><option value="auto">自动 / Auto</option><option value="zh-CN">中文</option><option value="en">English</option></select></label>
          <p>穿透后按 Alt+Shift+P 恢复操作。</p>
          <button class="open-options">打开完整设置</button>
        </aside>

        <aside class="notes-panel" hidden>
          <div class="panel-heading"><strong>切换笔记</strong><button class="notes-close" aria-label="关闭列表">×</button></div>
          <input class="note-search" type="search" placeholder="搜索标题或内容……" aria-label="搜索笔记" />
          <label class="check-row"><input class="current-page-only" type="checkbox" /> 只看当前网页相关笔记</label>
          <div class="note-list"></div>
          <button class="wide-new">＋ 新建笔记</button>
        </aside>

        <aside class="help-panel" hidden>
          <div class="panel-heading"><strong>使用方法</strong><button class="help-close" aria-label="关闭帮助">×</button></div>
          <div class="help-grid">
            <kbd>Alt+Shift+N</kbd><span>显示或隐藏便签</span>
            <kbd>Alt+Shift+M</kbd><span>新建笔记</span>
            <kbd>Alt+Shift+P</kbd><span>关闭或开启鼠标穿透</span>
            <kbd>Ctrl+Z</kbd><span>撤销输入</span>
          </div>
          <ol>
            <li>拖动顶部可移动，拖动右下角可缩放。</li>
            <li>点击网页链接会在新标签页打开。</li>
            <li>全屏视频中仍可拖动和输入。</li>
            <li>点击“导出”可单独下载当前笔记。</li>
            <li>齿轮中可调透明度；文字始终保持清晰。</li>
          </ol>
          <button class="help-options">打开完整设置</button>
        </aside>

        <aside class="storage-panel" hidden>
          <div class="panel-heading"><strong>笔记保存位置</strong><button class="storage-close" aria-label="关闭保存信息">×</button></div>
          <p class="storage-copy">正在读取……</p>
          <button class="storage-export">导出当前笔记</button>
          <button class="storage-options">设置 Markdown 文件夹</button>
        </aside>

        <div class="recovery" hidden role="dialog" aria-modal="true" aria-label="恢复上次笔记">
          <div class="recovery-card">
            <span class="recovery-icon">↩</span>
            <strong>继续上次的笔记？</strong>
            <p class="recovery-title"></p>
            <div><button class="recover-yes" title="继续上次笔记">✓</button><button class="recover-no" title="新建笔记">×</button></div>
          </div>
        </div>

        <button class="collapsed-badge" hidden title="展开浮笺" aria-label="展开浮笺"></button>
        <div class="resize-handle" title="拖动调整大小" aria-hidden="true"></div>
        <div class="toast" role="status" aria-live="polite"></div>
      </section>
    `;
  }

  function styles() {
    return `<style>
      :host { all: initial; font-family: Inter, "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
      * { box-sizing: border-box; }
      button, input, textarea { font: inherit; }
      button { -webkit-tap-highlight-color: transparent; }
      .shell {
        --accent: #5f8066;
        --accent-2: #7fa386;
        --surface-rgb: 255,255,255;
        --panel-alpha: .9;
        --text-alpha: 1;
        --ink-rgb: 35,48,39;
        --muted-rgb: 91,105,95;
        --surface: rgb(var(--surface-rgb));
        --surface-2: #f3f7f3;
        --ink: rgba(var(--ink-rgb), var(--text-alpha));
        --muted: rgba(var(--muted-rgb), var(--text-alpha));
        --line: rgba(53,82,60,.15);
        width: 100%; height: 100%; min-width: 280px; min-height: 180px;
        position: relative; overflow: hidden; color: var(--ink);
        background:
          linear-gradient(rgba(var(--surface-rgb), var(--panel-alpha)), rgba(var(--surface-rgb), var(--panel-alpha))),
          radial-gradient(circle at 14% 10%, rgba(103,143,111,.10), transparent 38%),
          repeating-linear-gradient(0deg, rgba(50,79,57,.018) 0, rgba(50,79,57,.018) 1px, transparent 1px, transparent 4px);
        border: 1px solid rgba(83,122,91,.22); border-radius: 14px;
        box-shadow: 0 16px 44px rgba(31,57,37,.16), 0 2px 8px rgba(31,57,37,.08);
        backdrop-filter: blur(12px); transition: background .16s ease, box-shadow .16s ease;
      }
      .shell.dark {
        --surface-rgb: 31,29,39; --surface: rgb(var(--surface-rgb)); --surface-2: #292630;
        --ink-rgb: 244,242,249; --muted-rgb: 170,165,181; --line: rgba(255,255,255,.11);
        border-color: rgba(143,181,151,.26); box-shadow: 0 18px 55px rgba(0,0,0,.42);
      }
      .header {
        height: 38px; display: flex; align-items: center; gap: 4px; padding: 0 7px;
        background: linear-gradient(135deg, rgba(103,143,111,.13), rgba(var(--surface-rgb),.03));
        border-bottom: 1px solid var(--line); cursor: grab; user-select: none;
      }
      .header:active { cursor: grabbing; }
      .grip { color: var(--accent); font-size: 18px; line-height: 1; }
      .title { min-width: 0; flex: 1; padding: 5px 7px; color: var(--ink); background: transparent; border: 1px solid transparent; border-radius: 7px; outline: none; font-weight: 700; }
      .title:hover { border-color: var(--line); }
      .title:focus { background: var(--surface); border-color: var(--accent); box-shadow: 0 0 0 2px rgba(95,128,102,.15); }
      .icon { width: 28px; height: 28px; display: inline-grid; place-items: center; padding: 0; border: 0; border-radius: 8px; color: var(--muted); background: transparent; cursor: pointer; font-size: 17px; line-height: 1; }
      .icon:hover { color: var(--ink); background: rgba(95,128,102,.13); }
      .body { height: calc(100% - 38px); display: flex; flex-direction: column; }
      .actions { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; padding: 5px 0; }
      .actions::-webkit-scrollbar { display: none; }
      .action { min-height: 28px; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; color: var(--ink); background: rgba(var(--surface-rgb),.36); cursor: pointer; font-size: 11px; line-height: 1.35; }
      .action:hover { color: var(--accent); border-color: rgba(95,128,102,.46); }
      .action:disabled { opacity: .45; cursor: not-allowed; }
      .formatting { flex: 0 0 auto; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); align-items: center; gap: 4px; padding: 5px 0; }
      .formatting::-webkit-scrollbar { display: none; }
      .formatting button { width: 100%; height: 27px; display: inline-grid; place-items: center; padding: 0; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: rgba(var(--surface-rgb),.36); cursor: pointer; font-size: 12px; line-height: 1; }
      .formatting button:hover { color: var(--accent); border-color: rgba(95,128,102,.48); }
      .formatting i { display: none; }
      .color-control { position: relative; width: 100%; height: 27px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: rgba(var(--surface-rgb),.36); font: 700 12px serif; cursor: pointer; overflow: hidden; }
      .font-color { position: absolute; inset: auto 0 0; width: 100%; height: 6px; padding: 0; border: 0; cursor: pointer; }
      .timestamp-strip { display: none; gap: 5px; padding: 0 9px 5px; overflow-x: auto; scrollbar-width: thin; }
      .timestamp-strip.has-items { display: flex; }
      .time-chip { flex: 0 0 auto; border: 0; border-radius: 99px; padding: 3px 7px; color: var(--accent); background: rgba(95,128,102,.13); cursor: pointer; font-size: 11px; line-height: 1.35; }
      .editor { flex: 1; width: calc(100% - 16px); min-height: 54px; margin: 7px 8px 0; padding: 9px 10px; overflow: auto; border: 1px solid transparent; border-radius: 9px; outline: none; color: var(--ink); background: rgba(var(--surface-rgb), calc(var(--panel-alpha) * .28)); line-height: 1.58; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .editor:focus { border-color: rgba(95,128,102,.38); box-shadow: inset 0 0 0 1px rgba(95,128,102,.08); background: rgba(var(--surface-rgb), calc(var(--panel-alpha) * .48)); }
      .editor:empty::before { content: attr(data-placeholder); color: var(--muted); pointer-events: none; }
      .note-link { color: var(--accent); text-decoration: underline; cursor: pointer; }
      .editor ol, .editor ul { margin: 5px 0; padding-left: 25px; }
      .tool-drawer { flex: 0 0 auto; margin: 6px 8px 0; padding: 6px 7px; border: 1px solid var(--line); border-radius: 10px; background: rgba(var(--surface-rgb), calc(var(--panel-alpha) * .56)); box-shadow: 0 5px 16px rgba(31,57,37,.07); }
      .drawer-tabs { display: flex; gap: 4px; padding-bottom: 5px; border-bottom: 1px solid var(--line); }
      .drawer-tab { min-height: 25px; flex: 1; display: inline-flex; align-items: center; justify-content: center; padding: 4px 5px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; cursor: pointer; font-size: 10px; line-height: 1.3; }
      .drawer-tab.active { color: var(--accent); background: rgba(95,128,102,.13); font-weight: 700; }
      .drawer-section { display: none; min-height: 35px; }
      .drawer-section.active { display: block; }
      .context-section .actions { display: grid; grid-template-columns: auto auto minmax(0, 1fr); }
      .notes-section .actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .notes-section .action { width: 100%; min-width: 0; padding-inline: 5px; }
      .context-summary { min-width: 90px; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
      .display-presets { display: flex; gap: 4px; padding: 5px 0 3px; }
      .display-presets button { min-height: 25px; flex: 1; display: inline-flex; align-items: center; justify-content: center; padding: 4px; color: var(--muted); background: rgba(var(--surface-rgb),.32); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; font-size: 9px; line-height: 1.3; }
      .display-presets .settings-button { flex: 0 0 25px; }
      .display-controls { display: grid; grid-template-columns: 70px minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 6px; }
      .display-controls label { min-width: 0; display: grid; grid-template-columns: auto minmax(28px, 1fr) auto; align-items: center; gap: 3px; color: var(--muted); font-size: 9px; white-space: nowrap; }
      .display-controls label:first-child { grid-template-columns: auto minmax(42px, 1fr); }
      .display-controls input[type="range"] { min-width: 28px; width: 100%; accent-color: var(--accent); }
      .display-controls output { min-width: 25px; font-size: 8px; text-align: right; }
      .display-controls select { min-width: 0; width: 100%; padding: 2px; color: var(--ink); background: rgba(var(--surface-rgb),.4); border: 1px solid var(--line); border-radius: 5px; font-size: 9px; }
      .footer { height: 29px; flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 0 10px; color: var(--muted); font-size: 9px; }
      .save-status { display: flex; align-items: center; gap: 5px; min-width: 0; }
      .save-status span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .save-status i { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: #22a06b; }
      .save-status.pending i { background: #d97706; }
      .save-status.error i { background: #dc2626; }
      .shortcut-hint { display: none; }
      .context-chip { max-width: 92px; padding: 2px 5px; overflow: hidden; color: var(--muted); background: rgba(var(--surface-rgb),.24); border: 1px solid var(--line); border-radius: 99px; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
      .storage-status { min-width: 0; margin-left: auto; padding: 2px 5px; overflow: hidden; color: var(--muted); background: transparent; border: 0; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
      .storage-status:hover { color: var(--accent); }
      .resize-handle { position: absolute; right: 1px; bottom: 1px; width: 16px; height: 16px; cursor: nwse-resize; opacity: .45; background: linear-gradient(135deg, transparent 45%, var(--muted) 47%, var(--muted) 52%, transparent 54%, transparent 66%, var(--muted) 68%, var(--muted) 73%, transparent 75%); }
      .quick-settings, .notes-panel, .help-panel, .storage-panel { position: absolute; z-index: 4; inset: 38px 0 0; padding: 12px; color: var(--ink); background: rgba(var(--surface-rgb), var(--panel-alpha)); backdrop-filter: blur(14px); overflow: auto; }
      .panel-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .panel-heading button { border: 0; color: var(--muted); background: transparent; cursor: pointer; font-size: 20px; }
      .quick-settings label:not(.check-row) { display: flex; justify-content: space-between; margin: 8px 0; font-size: 13px; }
      .quick-settings select { max-width: 52%; padding: 4px 6px; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); border-radius: 7px; outline: none; }
      .opacity-range { width: 100%; accent-color: var(--accent); }
      .check-row { display: flex; align-items: center; gap: 7px; margin: 10px 0; font-size: 12px; }
      .check-row input { accent-color: var(--accent); }
      .quick-settings p { color: var(--muted); font-size: 11px; }
      .open-options, .wide-new { width: 100%; border: 0; border-radius: 9px; padding: 8px; color: white; background: linear-gradient(135deg,var(--accent),var(--accent-2)); cursor: pointer; }
      .help-grid { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 7px 10px; font-size: 11px; }
      .help-grid kbd { padding: 4px 6px; color: var(--accent); background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; font: 600 9px ui-monospace, monospace; }
      .help-panel ol { margin: 13px 0; padding-left: 22px; color: var(--muted); font-size: 11px; line-height: 1.65; }
      .help-options, .storage-export, .storage-options { width: 100%; margin-top: 7px; padding: 8px; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
      .storage-copy { padding: 10px; color: var(--muted); background: var(--surface-2); border-radius: 9px; font-size: 11px; line-height: 1.6; }
      .note-search { width: 100%; padding: 8px 10px; color: var(--ink); background: rgba(var(--surface-rgb),.42); border: 1px solid var(--line); border-radius: 9px; outline: none; }
      .note-list { display: grid; gap: 6px; margin: 8px 0 12px; }
      .note-item { display: grid; grid-template-columns: 1fr auto; gap: 4px; padding: 8px 9px; border: 1px solid var(--line); border-radius: 9px; background: rgba(var(--surface-rgb),.38); cursor: pointer; }
      .note-item:hover, .note-item.current { border-color: rgba(95,128,102,.52); }
      .note-item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
      .note-item small { color: var(--muted); font-size: 10px; }
      .note-delete { grid-row: 1 / 3; grid-column: 2; align-self: center; border: 0; color: var(--muted); background: transparent; cursor: pointer; }
      .empty-list { padding: 20px 0; color: var(--muted); text-align: center; font-size: 12px; }
      .recovery { position: absolute; z-index: 8; inset: 0; display: grid; place-items: center; padding: 18px; background: rgba(18,15,31,.4); backdrop-filter: blur(5px); }
      .recovery-card { width: min(260px, 100%); padding: 20px; text-align: center; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 15px; box-shadow: 0 15px 40px rgba(0,0,0,.2); }
      .recovery-icon { display: block; color: var(--accent); font-size: 26px; }
      .recovery-card p { margin: 7px 0 14px; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
      .recovery-card button { width: 54px; height: 38px; margin: 0 5px; border: 0; border-radius: 10px; cursor: pointer; font-size: 21px; }
      .recover-yes { color: white; background: #22a06b; }
      .recover-no { color: var(--ink); background: var(--surface-2); }
      .collapsed-badge { position: absolute; inset: 0; width: 100%; height: 100%; display: block; padding: 0; border: 0; background: transparent url("${chrome.runtime.getURL("icons/collapsed-meteor.png")}") center / contain no-repeat; cursor: grab; filter: drop-shadow(0 5px 5px rgba(45,79,52,.3)); }
      .collapsed-badge:active { cursor: grabbing; }
      .shell.collapsed { min-width: 0; min-height: 0; border: 0; overflow: visible; background: transparent; box-shadow: none; }
      .shell.collapsed > :not(.collapsed-badge):not(.toast) { display: none !important; }
      .shell.collapsed .collapsed-badge { display: block !important; }
      .toast { position: absolute; left: 50%; bottom: 36px; z-index: 10; transform: translate(-50%, 8px); max-width: calc(100% - 28px); padding: 7px 10px; color: white; background: rgba(28,25,38,.9); border-radius: 8px; opacity: 0; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; transition: .16s ease; }
      .toast.show { opacity: 1; transform: translate(-50%, 0); }
      [hidden] { display: none !important; }
      @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
    </style>`;
  }

  function bindUi() {
    const editor = $(".editor");
    const title = $(".title");

    $(".close-button").addEventListener("click", () => hideHost(true));
    $(".tool-toggle").addEventListener("click", toggleToolDrawer);
    $(".collapse-button").addEventListener("click", collapse);
    $(".collapsed-badge").addEventListener("click", (event) => {
      if (collapsedDragConsumed) {
        collapsedDragConsumed = false;
        event.preventDefault();
        return;
      }
      expand();
    });
    $(".new-button").addEventListener("click", () => newNote(true));
    $(".wide-new").addEventListener("click", () => newNote(true));
    $(".export-button").addEventListener("click", exportCurrentNote);
    $(".switch-button").addEventListener("click", openNotesPanel);
    $(".notes-close").addEventListener("click", closePanels);
    $(".settings-button").addEventListener("click", openQuickSettings);
    $(".help-button").addEventListener("click", openHelpPanel);
    $(".help-close").addEventListener("click", closePanels);
    $(".storage-close").addEventListener("click", closePanels);
    $(".storage-status").addEventListener("click", openStoragePanel);
    $(".storage-button").addEventListener("click", openStoragePanel);
    $(".context-chip").addEventListener("click", insertCurrentPage);
    $(".storage-export").addEventListener("click", exportCurrentNote);
    $(".panel-close").addEventListener("click", closePanels);
    $(".timestamp-button").addEventListener("click", insertTimestamp);
    $(".link-button").addEventListener("click", insertCurrentPage);
    $(".recover-yes").addEventListener("click", acceptRecovery);
    $(".recover-no").addEventListener("click", rejectRecovery);
    $(".open-options").addEventListener("click", openOptionsPage);
    $(".help-options").addEventListener("click", openOptionsPage);
    $(".storage-options").addEventListener("click", openOptionsPage);
    $(".note-search").addEventListener("input", renderNoteList);
    $(".current-page-only").addEventListener("change", renderNoteList);
    shadow.querySelectorAll(".drawer-tab").forEach((button) => {
      button.addEventListener("click", () => selectDrawerSection(button.dataset.drawerTarget));
    });

    editor.addEventListener("input", () => {
      const note = getCurrentNote();
      if (!note) return;
      note.content = editor.innerHTML;
      note.contentFormat = "html";
      note.syncStatus = "pending";
      showSaveStatus(uiText("正在保存…", "Saving…"), "pending");
      renderTimestampChips();
      scheduleSave();
    });
    editor.addEventListener("keyup", captureEditorSelection);
    editor.addEventListener("mouseup", captureEditorSelection);
    editor.addEventListener("focus", captureEditorSelection);

    editor.addEventListener("blur", () => {
      if (linkifyEditor()) editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    editor.addEventListener("click", (event) => {
      const anchor = event.target.closest("a");
      if (!anchor) return;
      event.preventDefault();
      const videoTime = Number(anchor.dataset.videoTime);
      if (Number.isFinite(videoTime)) jumpToTimestamp(videoTime);
      else openSafeUrl(anchor.getAttribute("href"));
    });

    editor.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (isSafeHttpUrl(text)) {
        event.preventDefault();
        insertHtml(`<a class="note-link" href="${escapeAttribute(text)}">${escapeHtml(text)}</a>`);
      }
    });

    shadow.querySelectorAll(".formatting button[data-command]").forEach((button) => {
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => applyFormat(button.dataset.command, button.dataset.commandValue || null));
    });

    $(".font-color").addEventListener("input", (event) => applyFormat("foreColor", event.target.value));

    title.addEventListener("input", () => {
      const note = getCurrentNote();
      if (!note) return;
      note.title = title.value;
      note.syncStatus = "pending";
      showSaveStatus(uiText("正在保存…", "Saving…"), "pending");
      scheduleSave();
    });

    title.addEventListener("blur", () => {
      if (!title.value.trim()) {
        title.value = uiText("未命名笔记", "Untitled note");
        const note = getCurrentNote();
        if (note) note.title = title.value;
        scheduleSave(0);
      }
    });

    const opacityRange = $(".opacity-range");
    opacityRange.addEventListener("input", () => {
      setBackgroundOpacity(Number(opacityRange.value) / 100);
    });

    $(".background-opacity-range").addEventListener("input", (event) => setBackgroundOpacity(Number(event.target.value) / 100));
    $(".text-opacity-range").addEventListener("input", (event) => setTextOpacity(Number(event.target.value) / 100));
    $(".quick-text-opacity-range").addEventListener("input", (event) => setTextOpacity(Number(event.target.value) / 100));
    $(".editor-font-size").addEventListener("change", (event) => setEditorFontSize(Number(event.target.value)));
    $(".quick-editor-font-size").addEventListener("change", (event) => setEditorFontSize(Number(event.target.value)));
    shadow.querySelectorAll("[data-visual-preset]").forEach((button) => {
      button.addEventListener("click", () => applyVisualPreset(button.dataset.visualPreset));
    });

    $(".click-through-check").addEventListener("change", (event) => {
      setClickThrough(event.target.checked);
    });

    $(".language-select").addEventListener("change", (event) => {
      preferences.language = event.target.value;
      applyLanguage();
      savePreferences();
    });

    bindDrag();
    bindResize();
  }

  async function toggleVisible() {
    if (tabState.visible) hideHost(true);
    else showHost(true);
  }

  async function showHost(offerRecovery) {
    if (isBlockedSite()) return;
    await ensureCurrentNote();
    tabState.visible = true;
    host.hidden = false;
    host.style.display = "block";
    mountHostForContext();
    applySavedGeometry();
    renderCurrentNote(true);
    renderTimestampChips();
    refreshTimestampButton();

    try {
      if (host.hasAttribute("popover") && typeof host.showPopover === "function" && !host.matches(":popover-open")) host.showPopover();
    } catch {
      host.hidden = false;
      host.style.display = "block";
    }

    if (offerRecovery && tabState.pendingResume) openRecovery();
    else if (!preferences.onboardingSeen) {
      preferences.onboardingSeen = true;
      openHelpPanel();
      savePreferences();
    } else $(".editor").focus();
    saveTabState();
  }

  function hideHost(markPendingResume) {
    tabState.visible = false;
    tabState.pendingResume = Boolean(markPendingResume);
    closePanels();
    closeToolDrawer();
    $(".recovery").hidden = true;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
    } catch {}
    host.hidden = true;
    host.style.display = "none";
    saveTabState();
  }

  async function ensureCurrentNote() {
    if (getCurrentNote()) return;
    await newNote(false);
  }

  async function newNote(focusTitle) {
    if (!initialized) await initialize();
    const now = new Date().toISOString();
    const note = {
      id: crypto.randomUUID(),
      title: cleanPageTitle(document.title) || uiText("未命名笔记", "Untitled note"),
      content: "",
      createdAt: now,
      updatedAt: now,
      sources: [],
      syncStatus: "pending",
      version: 1,
      deletedAt: null
    };
    notes.unshift(note);
    currentNoteId = note.id;
    await chrome.storage.local.set({ fnNotes: notes, fnCurrentNoteId: currentNoteId });
    tabState.pendingResume = false;
    showHost(false);
    closePanels();
    renderCurrentNote(true);
    if (focusTitle) $(".title").select();
    syncNote(note);
  }

  function renderCurrentNote(force) {
    if (!shadow) return;
    const note = getCurrentNote();
    if (!note) return;
    const title = $(".title");
    const editor = $(".editor");
    if (force || shadow.activeElement !== title) title.value = note.title || uiText("未命名笔记", "Untitled note");
    if (force || shadow.activeElement !== editor) editor.innerHTML = noteToHtml(note);
    updateSaveStatus();
    updateContextUi();
  }

  function scheduleSave(delay = 420) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistCurrentNote, delay);
  }

  async function persistCurrentNote() {
    const note = getCurrentNote();
    if (!note) return;
    note.updatedAt = new Date().toISOString();
    note.version = (note.version || 0) + 1;
    note.syncStatus = "pending";
    await chrome.storage.local.set({ fnNotes: notes, fnCurrentNoteId: currentNoteId });
    showSaveStatus(uiText("已保存到本地 · 文件待同步", "Saved locally · file pending"), "pending");
    syncNote({ ...note, sources: [...(note.sources || [])] });
  }

  async function syncNote(note) {
    try {
      const result = await chrome.runtime.sendMessage({ type: "FN_SYNC_NOTE", note });
      if (result?.ok) showSaveStatus(`${uiText("已同步", "Synced")} · ${result.fileName}`, "ok");
      else if (result?.status === "not-configured") showSaveStatus(uiText("已保存到本地 · 未设置文件夹", "Saved locally · no folder set"), "pending");
      else if (result?.status === "permission-required") showSaveStatus(uiText("已保存到本地 · 目录需重新授权", "Saved locally · folder permission required"), "pending");
      else showSaveStatus(uiText("已保存到本地 · 文件同步失败", "Saved locally · file sync failed"), "error");
    } catch {
      showSaveStatus(uiText("已保存到本地 · 文件同步失败", "Saved locally · file sync failed"), "error");
    }
  }

  function insertCurrentPage() {
    const title = cleanPageTitle(document.title) || location.hostname;
    const url = location.href;
    insertHtml(`<a class="note-link" href="${escapeAttribute(url)}">${escapeHtml(title)}</a>`);
    addSource({ url, pageTitle: title, domain: location.hostname, addedAt: new Date().toISOString(), videoTime: null });
    toast(uiText("已插入当前网页", "Page link inserted"));
  }

  function insertTimestamp() {
    const video = findVideo();
    if (!video) {
      toast(uiText("当前页面没有可识别的视频", "No supported video found"));
      return;
    }
    const seconds = Math.max(0, Math.floor(video.currentTime || 0));
    const label = formatTime(seconds);
    insertHtml(`<a class="note-link" href="#" data-video-time="${seconds}">[${label}]</a>`);
    addSource({
      url: location.href,
      pageTitle: cleanPageTitle(document.title) || location.hostname,
      domain: location.hostname,
      addedAt: new Date().toISOString(),
      videoTime: seconds
    }, false);
    renderTimestampChips();
    toast(`${uiText("已插入", "Inserted")} ${label}`);
  }

  function insertHtml(html) {
    const editor = $(".editor");
    editor.focus();
    document.execCommand("insertHTML", false, `${html}&nbsp;`);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function addSource(source, dedupe = true) {
    const note = getCurrentNote();
    if (!note) return;
    note.sources ||= [];
    const exists = note.sources.some((item) => item.url === source.url && (!Number.isFinite(source.videoTime) || item.videoTime === source.videoTime));
    if (!dedupe || !exists) note.sources.push(source);
    updateContextUi();
    scheduleSave();
  }

  function renderTimestampChips() {
    if (!shadow) return;
    const container = $(".timestamp-strip");
    const note = getCurrentNote();
    const timestamps = (note?.sources || []).filter((source) => Number.isFinite(source.videoTime));
    container.replaceChildren();
    container.classList.toggle("has-items", timestamps.length > 0);
    timestamps.slice(-12).forEach((source) => {
      const button = document.createElement("button");
      button.className = "time-chip";
      button.textContent = `▶ ${formatTime(source.videoTime)}`;
      button.title = "跳转到视频时间";
      button.addEventListener("click", () => jumpToTimestamp(source.videoTime));
      container.append(button);
    });
  }

  function jumpToTimestamp(seconds) {
    const video = findVideo();
    if (!video) return toast(uiText("当前页面没有可跳转的视频", "No video available to seek"));
    video.currentTime = seconds;
    toast(`${uiText("已跳转到", "Jumped to")} ${formatTime(seconds)}`);
  }

  function findVideo() {
    const youtubeVideo = document.querySelector("video.html5-main-video");
    if (youtubeVideo && Number.isFinite(youtubeVideo.currentTime)) return youtubeVideo;
    const videos = [...document.querySelectorAll("video")].filter((video) => Number.isFinite(video.currentTime));
    if (!videos.length) return null;
    return videos.find((video) => !video.paused && !video.ended) || videos.sort((a, b) => area(b) - area(a))[0];
  }

  function refreshTimestampButton() {
    const button = $(".timestamp-button");
    if (!button) return;
    const available = Boolean(findVideo());
    button.disabled = !available;
    button.title = available ? "插入当前视频时间" : "当前页面没有可识别的视频";
  }

  function openRecovery() {
    closePanels();
    const note = getCurrentNote();
    $(".recovery-title").textContent = note?.title || uiText("未命名笔记", "Untitled note");
    $(".recovery").hidden = false;
    $(".recover-yes").focus();
  }

  function acceptRecovery() {
    tabState.pendingResume = false;
    $(".recovery").hidden = true;
    saveTabState();
    $(".editor").focus();
  }

  async function rejectRecovery() {
    tabState.pendingResume = false;
    $(".recovery").hidden = true;
    await saveTabState();
    await newNote(true);
  }

  function openNotesPanel() {
    closePanels();
    closeToolDrawer();
    $(".notes-panel").hidden = false;
    renderNoteList();
    $(".note-search").focus();
  }

  function toggleToolDrawer() {
    const drawer = $(".tool-drawer");
    drawer.hidden = !drawer.hidden;
    $(".tool-toggle").setAttribute("aria-expanded", String(!drawer.hidden));
    $(".tool-toggle").classList.toggle("active", !drawer.hidden);
    if (!drawer.hidden) syncDisplayControls();
  }

  function closeToolDrawer() {
    const drawer = $(".tool-drawer");
    drawer.hidden = true;
    $(".tool-toggle").setAttribute("aria-expanded", "false");
    $(".tool-toggle").classList.remove("active");
  }

  function selectDrawerSection(target) {
    shadow.querySelectorAll(".drawer-tab").forEach((button) => button.classList.toggle("active", button.dataset.drawerTarget === target));
    shadow.querySelectorAll(".drawer-section").forEach((section) => section.classList.toggle("active", section.dataset.drawerSection === target));
    if (target === "display") syncDisplayControls();
    if (target === "context") {
      updateContextUi();
      refreshTimestampButton();
    }
  }

  function openQuickSettings() {
    closePanels();
    closeToolDrawer();
    $(".quick-settings").hidden = false;
    $(".opacity-range").value = Math.round(preferences.backgroundOpacity * 100);
    $(".opacity-value").textContent = `${Math.round(preferences.backgroundOpacity * 100)}%`;
    $(".quick-text-opacity-range").value = Math.round(preferences.textOpacity * 100);
    $(".quick-text-opacity-value").textContent = `${Math.round(preferences.textOpacity * 100)}%`;
    $(".quick-editor-font-size").value = String(preferences.editorFontSize);
    $(".click-through-check").checked = Boolean(preferences.clickThrough);
    $(".language-select").value = preferences.language || "auto";
  }

  function syncDisplayControls() {
    const background = Math.round(preferences.backgroundOpacity * 100);
    const text = Math.round(preferences.textOpacity * 100);
    $(".background-opacity-range").value = background;
    $(".background-opacity-value").textContent = `${background}%`;
    $(".text-opacity-range").value = text;
    $(".text-opacity-value").textContent = `${text}%`;
    $(".editor-font-size").value = String(preferences.editorFontSize);
  }

  function setBackgroundOpacity(value) {
    preferences.backgroundOpacity = clamp(value, 0.2, 1);
    applyAppearance();
    syncDisplayControls();
    $(".opacity-range").value = Math.round(preferences.backgroundOpacity * 100);
    $(".opacity-value").textContent = `${Math.round(preferences.backgroundOpacity * 100)}%`;
    savePreferences();
  }

  function setTextOpacity(value) {
    preferences.textOpacity = clamp(value, 0.4, 1);
    applyAppearance();
    syncDisplayControls();
    $(".quick-text-opacity-range").value = Math.round(preferences.textOpacity * 100);
    $(".quick-text-opacity-value").textContent = `${Math.round(preferences.textOpacity * 100)}%`;
    savePreferences();
  }

  function setEditorFontSize(value) {
    preferences.editorFontSize = [12, 14, 16, 18, 20].includes(value) ? value : 14;
    applyAppearance();
    syncDisplayControls();
    $(".quick-editor-font-size").value = String(preferences.editorFontSize);
    savePreferences();
  }

  function applyVisualPreset(preset) {
    const values = {
      clear: { background: 0.9, text: 1 },
      glass: { background: 0.55, text: 1 },
      minimal: { background: 0.3, text: 0.75 }
    }[preset];
    if (!values) return;
    preferences.backgroundOpacity = values.background;
    preferences.textOpacity = values.text;
    applyAppearance();
    syncDisplayControls();
    savePreferences();
  }

  function updateContextUi() {
    const note = getCurrentNote();
    const source = note?.sources?.find((item) => item.url === location.href) || note?.sources?.at(-1);
    const text = source ? safeDomain(source.url) : uiText("当前页面尚未关联", "Current page not linked");
    $(".context-summary").textContent = text;
    $(".context-chip").textContent = source ? safeDomain(source.url) : uiText("当前网页", "Current page");
  }

  function openHelpPanel() {
    closePanels();
    closeToolDrawer();
    $(".help-panel").hidden = false;
  }

  async function openStoragePanel() {
    closePanels();
    closeToolDrawer();
    $(".storage-panel").hidden = false;
    const copy = $(".storage-copy");
    copy.textContent = uiText("正在读取保存位置……", "Reading storage location…");
    try {
      const status = await chrome.runtime.sendMessage({ type: "FN_DIRECTORY_STATUS" });
      if (status?.status === "ready") {
        const displayPath = preferences.directoryDisplayPath || status.name;
        copy.textContent = uiText(`浏览器本地：已自动保存。\n路径备注：${displayPath}\n已授权文件夹：${status.name}（浏览器出于隐私保护只提供文件夹名称）。`, `Browser storage: autosaved.\nPath label: ${displayPath}\nAuthorized folder: ${status.name}. For privacy, the browser only exposes the folder name.`);
      } else if (status?.status === "permission-required") {
        copy.textContent = uiText(`浏览器本地：已自动保存。\nMarkdown 文件夹：${status.name || "已选择的文件夹"}，但需要重新授权。`, `Browser storage: autosaved.\nMarkdown folder: ${status.name || "selected folder"}, permission required.`);
      } else {
        copy.textContent = uiText("笔记已保存在浏览器本地，但尚未配置 Markdown 文件夹。你也可以直接导出当前笔记。", "The note is saved in browser storage. No Markdown folder is configured; you can still export the current note.");
      }
    } catch {
      copy.textContent = uiText("笔记已保存在浏览器本地。无法读取 Markdown 文件夹状态。", "The note is saved in browser storage. Markdown folder status is unavailable.");
    }
  }

  function closePanels() {
    $(".notes-panel").hidden = true;
    $(".quick-settings").hidden = true;
    $(".help-panel").hidden = true;
    $(".storage-panel").hidden = true;
  }

  async function openOptionsPage() {
    closePanels();
    const result = await chrome.runtime.sendMessage({ type: "FN_OPEN_OPTIONS" }).catch(() => null);
    if (!result?.ok) toast(uiText("完整设置打开失败，请从扩展管理页进入", "Could not open settings; use the extension management page"));
  }

  function applyFormat(command, value = null) {
    const editor = $(".editor");
    editor.focus();
    restoreEditorSelection();
    document.execCommand(command, false, value);
    captureEditorSelection();
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function captureEditorSelection() {
    const selection = shadow.getSelection?.() || document.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if ($(".editor").contains(range.commonAncestorContainer)) savedEditorRange = range.cloneRange();
  }

  function restoreEditorSelection() {
    if (!savedEditorRange) return;
    const selection = shadow.getSelection?.() || document.getSelection();
    selection.removeAllRanges();
    selection.addRange(savedEditorRange);
  }

  function linkifyEditor() {
    const editor = $(".editor");
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest("a") || !/https?:\/\/[^\s<]+/i.test(node.nodeValue || "")) continue;
      targets.push(node);
    }
    let changed = false;
    for (const textNode of targets) {
      const text = textNode.nodeValue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      text.replace(/https?:\/\/[^\s<]+/gi, (match, offset) => {
        fragment.append(document.createTextNode(text.slice(cursor, offset)));
        const anchor = document.createElement("a");
        anchor.className = "note-link";
        anchor.href = match;
        anchor.textContent = match;
        fragment.append(anchor);
        cursor = offset + match.length;
        changed = true;
        return match;
      });
      fragment.append(document.createTextNode(text.slice(cursor)));
      textNode.replaceWith(fragment);
    }
    return changed;
  }

  function noteToHtml(note) {
    if (!note?.content) return "";
    if (note.contentFormat === "html") return sanitizeNoteHtml(note.content);
    return escapeHtml(note.content).replace(/\n/g, "<br>");
  }

  function sanitizeNoteHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    template.content.querySelectorAll("script,style,iframe,object,embed,form,input,button").forEach((element) => element.remove());
    template.content.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on")) element.removeAttribute(attribute.name);
        if ((name === "href" || name === "src") && !isSafeHttpUrl(attribute.value) && !attribute.value.startsWith("#")) element.removeAttribute(attribute.name);
      });
    });
    template.content.querySelectorAll("a").forEach((anchor) => anchor.classList.add("note-link"));
    return template.innerHTML;
  }

  function exportCurrentNote() {
    const note = getCurrentNote();
    if (!note) return;
    const sources = (note.sources || []).map((source) => `- [${source.pageTitle || source.url}](${source.url})${Number.isFinite(source.videoTime) ? ` @ ${formatTime(source.videoTime)}` : ""}`);
    const content = [
      "---",
      `title: "${String(note.title || "未命名笔记").replaceAll('"', '\\"')}"`,
      `created: "${note.createdAt}"`,
      `updated: "${note.updatedAt}"`,
      `note_id: "${note.id}"`,
      "---",
      "",
      `# ${note.title || "未命名笔记"}`,
      "",
      noteToHtml(note),
      ...(sources.length ? ["", "## 来源", "", ...sources] : []),
      ""
    ].join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(note.title || "未命名笔记")}.md`;
    document.documentElement.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(uiText("当前笔记已导出", "Current note exported"));
  }

  function renderNoteList() {
    const list = $(".note-list");
    const query = $(".note-search").value.trim().toLowerCase();
    const currentPageOnly = $(".current-page-only").checked;
    const url = location.href;
    const items = notes
      .filter((note) => !note.deletedAt)
      .filter((note) => !query || `${note.title} ${note.content}`.toLowerCase().includes(query))
      .filter((note) => !currentPageOnly || note.sources?.some((source) => source.url === url))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = uiText("没有找到笔记", "No notes found");
      list.append(empty);
      return;
    }

    items.forEach((note) => {
      const row = document.createElement("div");
      row.className = `note-item${note.id === currentNoteId ? " current" : ""}`;
      row.tabIndex = 0;
      row.innerHTML = `<strong></strong><small></small><button class="note-delete" title="删除笔记" aria-label="删除笔记">⌫</button>`;
      row.querySelector("strong").textContent = note.title || uiText("未命名笔记", "Untitled note");
      row.querySelector("small").textContent = relativeTime(note.updatedAt);
      row.addEventListener("click", (event) => {
        if (event.target.closest(".note-delete")) return;
        switchNote(note.id);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") switchNote(note.id);
      });
      row.querySelector(".note-delete").addEventListener("click", () => deleteNote(note.id));
      list.append(row);
    });
  }

  async function switchNote(id) {
    currentNoteId = id;
    await chrome.storage.local.set({ fnCurrentNoteId: id });
    closePanels();
    renderCurrentNote(true);
    renderTimestampChips();
    $(".editor").focus();
  }

  async function deleteNote(id) {
    const note = notes.find((item) => item.id === id);
    if (!note || !confirm(`确定删除“${note.title || "未命名笔记"}”吗？`)) return;
    note.deletedAt = new Date().toISOString();
    note.updatedAt = note.deletedAt;
    if (currentNoteId === id) {
      currentNoteId = notes.find((item) => !item.deletedAt)?.id || null;
    }
    await chrome.storage.local.set({ fnNotes: notes, fnCurrentNoteId: currentNoteId });
    if (!currentNoteId) await newNote(false);
    renderCurrentNote(true);
    renderNoteList();
  }

  function collapse() {
    preferences.collapsed = true;
    $(".shell").classList.add("collapsed");
    host.style.width = "40px";
    host.style.height = "40px";
    savePreferences();
  }

  function expand() {
    preferences.collapsed = false;
    $(".shell").classList.remove("collapsed");
    host.style.width = `${preferences.size.width}px`;
    host.style.height = `${preferences.size.height}px`;
    clampHostToViewport();
    savePreferences();
    $(".editor").focus();
  }

  async function toggleClickThrough() {
    await setClickThrough(!preferences.clickThrough);
  }

  async function setClickThrough(enabled) {
    if (enabled && !(await hasClickThroughShortcut())) {
      preferences.clickThrough = false;
      host.style.pointerEvents = "auto";
      if (shadow) $(".click-through-check").checked = false;
      toast(uiText("请先在设置页绑定鼠标穿透快捷键", "Bind the click-through shortcut in settings first"));
      return;
    }
    preferences.clickThrough = Boolean(enabled);
    host.style.pointerEvents = enabled ? "none" : "auto";
    if (shadow) $(".click-through-check").checked = enabled;
    savePreferences();
    toast(enabled ? uiText("鼠标穿透已开启 · Alt+Shift+P 关闭", "Click-through on · Alt+Shift+P to turn off") : uiText("鼠标穿透已关闭", "Click-through off"));
  }

  async function hasClickThroughShortcut() {
    try {
      const result = await chrome.runtime.sendMessage({ type: "FN_GET_SHORTCUTS" });
      return Boolean(result?.commands?.find((command) => command.name === "toggle-click-through")?.shortcut);
    } catch {
      return false;
    }
  }

  function isBlockedSite() {
    const hostName = location.hostname.toLowerCase();
    return (preferences.blockedSites || []).some((entry) => {
      const domain = String(entry).trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
      return domain && (hostName === domain || hostName.endsWith(`.${domain}`));
    });
  }

  function applyAppearance() {
    if (!host || !shadow) return;
    $(".shell").style.setProperty("--panel-alpha", String(preferences.backgroundOpacity));
    $(".shell").style.setProperty("--text-alpha", String(preferences.textOpacity));
    $(".editor").style.fontSize = `${preferences.editorFontSize}px`;
    const dark = preferences.theme === "dark" || (preferences.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    $(".shell").classList.toggle("dark", dark);
    $(".shell").classList.toggle("collapsed", Boolean(preferences.collapsed));
    host.style.pointerEvents = preferences.clickThrough ? "none" : "auto";
    applyLanguage();
  }

  function applyLanguage() {
    if (!shadow) return;
    const en = currentLanguage() === "en";
    host.lang = en ? "en" : "zh-CN";
    const set = (selector, zh, english) => {
      const element = $(selector);
      if (element) element.textContent = en ? english : zh;
    };
    const title = (selector, zh, english) => {
      const element = $(selector);
      if (element) element.title = en ? english : zh;
    };
    const leading = (selector, zh, english) => {
      const element = $(selector);
      if (element?.firstChild?.nodeType === Node.TEXT_NODE) {
        element.firstChild.textContent = en ? english : zh;
      }
    };

    set(".timestamp-button", "⏱ 时间戳", "⏱ Timestamp");
    set(".link-button", "↗ 插入网页", "↗ Insert page");
    set(".switch-button", "☰ 切换", "☰ Notes");
    set(".new-button", "＋ 新建", "+ New");
    set(".export-button", "⇩ 导出", "⇩ Export");
    set(".storage-button", "⌂ 保存位置", "⌂ Storage");
    set(".help-button", "? 使用帮助", "? Help");
    set(".notes-panel .panel-heading strong", "切换笔记", "Switch note");
    set(".wide-new", "＋ 新建笔记", "+ New note");
    set(".quick-settings .panel-heading strong", "显示设置", "Display settings");
    set(".open-options", "打开完整设置", "Open full settings");
    set(".help-panel .panel-heading strong", "使用方法", "How to use");
    set(".help-options", "打开完整设置", "Open full settings");
    set(".storage-panel .panel-heading strong", "笔记保存位置", "Note storage");
    set(".storage-export", "导出当前笔记", "Export current note");
    set(".storage-options", "设置 Markdown 文件夹", "Set Markdown folder");
    set(".recovery-card strong", "继续上次的笔记？", "Continue your last note?");
    set(".storage-status", "本地存储", "Local storage");
    leading(".display-controls label:nth-child(1)", "字号", "Size");
    leading(".display-controls label:nth-child(2)", "背景", "Background");
    leading(".display-controls label:nth-child(3)", "文字", "Text");
    set(".quick-settings > label:nth-of-type(1) span", "背景透明度", "Background opacity");
    set(".quick-settings > label:nth-of-type(2) span", "文字透明度", "Text opacity");
    set(".quick-settings > label:nth-of-type(3) span", "默认字号", "Default font size");
    title(".help-button", "快捷键与使用帮助", "Shortcuts and help");
    title(".tool-toggle", "展开或收起工具", "Show or hide tools");
    title(".settings-button", "外观设置", "Display settings");
    title(".collapse-button", "折叠", "Collapse");
    title(".close-button", "隐藏便签", "Hide note");

    $(".title").placeholder = en ? "Untitled note" : "未命名笔记";
    $(".editor").dataset.placeholder = en ? "Write your note here…" : "在这里记录……";
    $(".note-search").placeholder = en ? "Search title or content…" : "搜索标题或内容……";
    const pageOnlyText = $(".current-page-only").parentElement;
    pageOnlyText.lastChild.textContent = en ? " Notes for this page only" : " 只看当前网页相关笔记";
    const clickText = $(".click-through-check").parentElement;
    clickText.lastChild.textContent = en ? " Mouse click-through" : " 鼠标穿透";
    $(".quick-settings p").textContent = en ? "Press Alt+Shift+P to regain mouse control." : "穿透后按 Alt+Shift+P 恢复操作。";
    $(".help-grid").innerHTML = en
      ? `<kbd>Alt+Shift+N</kbd><span>Show or hide</span><kbd>Alt+Shift+M</kbd><span>New note</span><kbd>Alt+Shift+P</kbd><span>Toggle click-through</span><kbd>Ctrl+Z</kbd><span>Undo</span>`
      : `<kbd>Alt+Shift+N</kbd><span>显示或隐藏便签</span><kbd>Alt+Shift+M</kbd><span>新建笔记</span><kbd>Alt+Shift+P</kbd><span>关闭或开启鼠标穿透</span><kbd>Ctrl+Z</kbd><span>撤销输入</span>`;
    $(".help-panel ol").innerHTML = en
      ? `<li>Drag the header to move; drag the lower-right corner to resize.</li><li>Click a web link to open it in a new tab.</li><li>The note remains editable over supported fullscreen players.</li><li>Use Export to download the current note.</li><li>Background and text opacity can be adjusted independently.</li>`
      : `<li>拖动顶部可移动，拖动右下角可缩放。</li><li>点击网页链接会在新标签页打开。</li><li>全屏视频中仍可拖动和输入。</li><li>点击“导出”可单独下载当前笔记。</li><li>背景和文字透明度可以独立调节。</li>`;
    const drawerLabels = en ? ["Format", "Context", "Notes", "Display"] : ["格式", "上下文", "笔记", "显示"];
    shadow.querySelectorAll(".drawer-tab").forEach((button, index) => { button.textContent = drawerLabels[index]; });
    const presets = en ? ["Clear", "Glass", "Minimal"] : ["清晰", "半透明", "极简"];
    shadow.querySelectorAll("[data-visual-preset]").forEach((button, index) => { button.textContent = presets[index]; });
  }

  function currentLanguage() {
    if (preferences.language === "zh-CN" || preferences.language === "en") return preferences.language;
    return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  function uiText(zh, english) {
    return currentLanguage() === "en" ? english : zh;
  }

  function mountHostForContext() {
    if (!host) return;
    const fullscreenElement = document.fullscreenElement;
    const canContainOverlay = fullscreenElement && !["VIDEO", "IMG"].includes(fullscreenElement.tagName);

    try {
      if (host.matches(":popover-open")) host.hidePopover();
    } catch {}

    if (canContainOverlay) {
      host.removeAttribute("popover");
      if (host.parentNode !== fullscreenElement) fullscreenElement.append(host);
    } else {
      if (host.parentNode !== document.documentElement) document.documentElement.append(host);
      host.setAttribute("popover", "manual");
    }
  }

  function applySavedGeometry() {
    if (!host) return;
    const position = isFullscreen ? preferences.fullscreenPosition : preferences.normalPosition;
    const width = preferences.collapsed ? 44 : clamp(preferences.size?.width || 330, 280, Math.max(280, innerWidth - 8));
    const height = preferences.collapsed ? 44 : clamp(preferences.size?.height || 240, 180, Math.max(180, innerHeight - 8));
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    host.style.top = `${position?.top ?? 88}px`;
    host.style.left = position?.left != null ? `${position.left}px` : "auto";
    host.style.right = position?.right != null ? `${position.right}px` : "auto";
    requestAnimationFrame(clampHostToViewport);
  }

  function bindDrag() {
    let start = null;
    const begin = (event) => {
      const collapsedHandle = event.currentTarget.classList.contains("collapsed-badge");
      if (event.button !== 0 || (!collapsedHandle && event.target.closest("button,input,textarea"))) return;
      const rect = host.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, collapsedHandle, moved: false };
      if (collapsedHandle) collapsedDragConsumed = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const move = (event) => {
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) start.moved = true;
      host.style.left = `${start.left + event.clientX - start.x}px`;
      host.style.top = `${start.top + event.clientY - start.y}px`;
      host.style.right = "auto";
      clampHostToViewport();
    };
    const end = () => {
      if (!start) return;
      collapsedDragConsumed = start.collapsedHandle && start.moved;
      start = null;
      saveCurrentPosition();
    };
    $(".header").addEventListener("pointerdown", begin);
    $(".header").addEventListener("pointermove", move);
    $(".header").addEventListener("pointerup", end);
    $(".collapsed-badge").addEventListener("pointerdown", begin);
    $(".collapsed-badge").addEventListener("pointermove", move);
    $(".collapsed-badge").addEventListener("pointerup", end);
  }

  function bindResize() {
    let start = null;
    const handle = $(".resize-handle");
    handle.addEventListener("pointerdown", (event) => {
      const rect = host.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!start) return;
      const width = clamp(start.width + event.clientX - start.x, 280, Math.max(280, innerWidth - host.getBoundingClientRect().left - 4));
      const height = clamp(start.height + event.clientY - start.y, 180, Math.max(180, innerHeight - host.getBoundingClientRect().top - 4));
      host.style.width = `${width}px`;
      host.style.height = `${height}px`;
    });
    handle.addEventListener("pointerup", () => {
      if (!start) return;
      start = null;
      const rect = host.getBoundingClientRect();
      preferences.size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      savePreferences();
    });
  }

  function saveCurrentPosition() {
    const rect = host.getBoundingClientRect();
    const key = isFullscreen ? "fullscreenPosition" : "normalPosition";
    preferences[key] = { left: Math.round(rect.left), top: Math.round(rect.top), right: null };
    savePreferences();
  }

  function clampHostToViewport() {
    if (!host || host.hidden) return;
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(4, innerWidth - rect.width - 4);
    const maxTop = Math.max(4, innerHeight - rect.height - 4);
    const left = clamp(rect.left, 4, maxLeft);
    const top = clamp(rect.top, 4, maxTop);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
  }

  async function savePreferences() {
    await chrome.storage.local.set({ fnPreferences: preferences });
  }

  async function saveTabState() {
    try {
      await chrome.runtime.sendMessage({ type: "FN_SET_TAB_STATE", state: tabState });
    } catch {}
  }

  function updateSaveStatus() {
    const note = getCurrentNote();
    if (!note) return;
    if (note.syncStatus === "synced") showSaveStatus(note.fileName ? `${uiText("已同步", "Synced")} · ${note.fileName}` : uiText("已保存并同步", "Saved and synced"), "ok");
    else if (note.syncStatus === "error") showSaveStatus(uiText("已保存到本地 · 文件同步失败", "Saved locally · file sync failed"), "error");
    else showSaveStatus(uiText("已保存到本地 · 文件待同步", "Saved locally · file pending"), "pending");
  }

  function showSaveStatus(text, kind) {
    if (!shadow) return;
    const status = $(".save-status");
    status.classList.toggle("pending", kind === "pending");
    status.classList.toggle("error", kind === "error");
    status.querySelector("span").textContent = text;
  }

  function toast(message) {
    if (!shadow) return;
    const element = $(".toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => element.classList.remove("show"), 1800);
  }

  function getCurrentNote() {
    return notes.find((note) => note.id === currentNoteId && !note.deletedAt) || null;
  }

  function mergeNotes(local, incoming) {
    const localById = new Map(local.map((note) => [note.id, note]));
    return incoming.map((note) => {
      const existing = localById.get(note.id);
      if (!existing) return note;
      return (existing.version || 0) > (note.version || 0) ? existing : note;
    });
  }

  function $(selector) {
    return shadow.querySelector(selector);
  }

  function cleanPageTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function escapeMarkdown(value) {
    return String(value || "").replace(/[\[\]]/g, "\\$&");
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function isSafeHttpUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function openSafeUrl(value) {
    if (!isSafeHttpUrl(value)) return;
    window.open(new URL(value, location.href).href, "_blank", "noopener,noreferrer");
  }

  function safeDomain(value) {
    try {
      return new URL(value, location.href).hostname.replace(/^www\./, "") || uiText("当前网页", "Current page");
    } catch {
      return uiText("当前网页", "Current page");
    }
  }

  function safeFileName(value) {
    return String(value || "未命名笔记").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 120) || "未命名笔记";
  }

  function area(element) {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(Number(value) || min, min), max);
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function relativeTime(iso) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso || 0).getTime()) / 1000));
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86400)} 天前`;
  }
})();

