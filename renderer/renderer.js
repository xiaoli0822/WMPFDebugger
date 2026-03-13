// WMPFDebugger Renderer
// Note: debuggerAPI and windowAPI are injected by preload via contextBridge
// They exist as global constants, so we must NOT redeclare them with const/let

;(function() {
"use strict";

const api = window.debuggerAPI;
const winAPI = window.windowAPI;

// ===== DOM Elements =====
const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const debugPortInput = document.getElementById("debug-port");
const cdpPortInput = document.getElementById("cdp-port");
const btnRefreshProcesses = document.getElementById("btn-refresh-processes");
const versionTags = document.getElementById("version-tags");
const processList = document.getElementById("process-list");
const logContainer = document.getElementById("log-container");
const btnClearLogs = document.getElementById("btn-clear-logs");
const btnOpenDevtools = document.getElementById("btn-open-devtools");
const bottomInfo = document.getElementById("bottom-info");
const btnMinimize = document.getElementById("btn-minimize");
const btnMaximize = document.getElementById("btn-maximize");
const btnClose = document.getElementById("btn-close");

// Plugin elements
const pluginList = document.getElementById("plugin-list");
const btnImportFile = document.getElementById("btn-import-file");
const btnAddInline = document.getElementById("btn-add-inline");

// ===== State =====
let isRunning = false;
let plugins = [];
let expandedPluginId = null;
let pluginSavedScripts = {};
const MAX_LOG_ENTRIES = 1000;

// ===== Safety check =====
if (!api || !winAPI) {
    console.error("Preload APIs not available. debuggerAPI:", api, "windowAPI:", winAPI);
    document.body.innerHTML = '<div style="color:red;padding:40px;font-size:16px;">Error: Preload script failed to load. Please check the console for details.</div>';
    return;
}

// ===== Window Controls =====
btnMinimize.addEventListener("click", () => winAPI.minimize());
btnMaximize.addEventListener("click", () => winAPI.maximize());
btnClose.addEventListener("click", () => winAPI.close());

// ===== Service Controls =====
btnStart.addEventListener("click", async () => {
    const debugPort = parseInt(debugPortInput.value, 10);
    const cdpPort = parseInt(cdpPortInput.value, 10);

    if (!validatePort(debugPort) || !validatePort(cdpPort)) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: "Invalid port number. Must be between 1024 and 65535." });
        return;
    }

    if (debugPort === cdpPort) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: "Debug port and CDP port must be different." });
        return;
    }

    setLoading(true);
    addLog({ timestamp: getCurrentTime(), level: "info", message: "Starting debug services..." });

    const result = await api.start({ debugPort, cdpPort });
    if (!result.success) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `Failed to start: ${result.error}` });
        setLoading(false);
    }
});

btnStop.addEventListener("click", async () => {
    setLoading(true);
    addLog({ timestamp: getCurrentTime(), level: "info", message: "Stopping debug services..." });

    const result = await api.stop();
    if (!result.success) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `Failed to stop: ${result.error}` });
        setLoading(false);
    }
});

// ===== Process & Version Controls =====
btnRefreshProcesses.addEventListener("click", async () => {
    btnRefreshProcesses.disabled = true;
    btnRefreshProcesses.innerHTML = '<span class="spinner"></span> Scanning...';

    const result = await api.getProcesses();
    if (result.success && result.data.length > 0) {
        renderProcessList(result.data);
        addLog({ timestamp: getCurrentTime(), level: "success", message: `Found ${result.data.length} WeChatAppEx process(es)` });
    } else if (result.success && result.data.length === 0) {
        processList.innerHTML = '<div class="process-empty">No WeChatAppEx processes found. Is WeChat running?</div>';
        addLog({ timestamp: getCurrentTime(), level: "warn", message: "No WeChatAppEx processes found" });
    } else {
        processList.innerHTML = '<div class="process-empty">Error scanning processes</div>';
        addLog({ timestamp: getCurrentTime(), level: "error", message: `Process scan failed: ${result.error}` });
    }

    btnRefreshProcesses.disabled = false;
    btnRefreshProcesses.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
        </svg>
        Refresh`;
});

btnClearLogs.addEventListener("click", () => {
    logContainer.innerHTML = "";
    addLog({ timestamp: getCurrentTime(), level: "info", message: "Logs cleared" });
});

btnOpenDevtools.addEventListener("click", async () => {
    const cdpPort = parseInt(cdpPortInput.value, 10);
    if (!validatePort(cdpPort)) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: "Invalid CDP port" });
        return;
    }

    addLog({ timestamp: getCurrentTime(), level: "info", message: `Opening DevTools at port ${cdpPort}...` });
    const result = await api.openDevTools(cdpPort);
    if (!result.success) {
        addLog({ timestamp: getCurrentTime(), level: "warn", message: `Could not open DevTools automatically: ${result.error}` });
        addLog({ timestamp: getCurrentTime(), level: "info", message: `Please manually navigate to: devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${cdpPort}` });
    }
});

// ===== Plugin Controls =====
btnImportFile.addEventListener("click", async () => {
    btnImportFile.disabled = true;
    const result = await api.importHookFile();
    if (result.success && result.data) {
        addLog({ timestamp: getCurrentTime(), level: "success", message: `Imported plugin: "${result.data.name}"` });
        await loadPlugins();
    } else if (result.error && result.error !== "cancelled") {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `Import failed: ${result.error}` });
    }
    btnImportFile.disabled = false;
});

btnAddInline.addEventListener("click", async () => {
    btnAddInline.disabled = true;
    const name = "Inline Script " + (plugins.length + 1);
    const result = await api.addHookPlugin(name, "", "inline");
    if (result.success && result.data) {
        addLog({ timestamp: getCurrentTime(), level: "success", message: `Added inline plugin: "${result.data.name}"` });
        expandedPluginId = result.data.id;
        await loadPlugins();
    } else {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `Failed to add plugin: ${result.error}` });
    }
    btnAddInline.disabled = false;
});

async function loadPlugins() {
    const result = await api.getHookPlugins();
    if (result.success) {
        plugins = result.data || [];
        pluginSavedScripts = {};
        plugins.forEach(function(p) { pluginSavedScripts[p.id] = p.script; });
        renderPluginList();
    }
}

function renderPluginList() {
    if (plugins.length === 0) {
        pluginList.innerHTML = '<div class="plugin-empty">No plugins added. Click "Import File" or "Add Inline" to get started.</div>';
        return;
    }

    pluginList.innerHTML = "";
    plugins.forEach(function(plugin) {
        pluginList.appendChild(createPluginItem(plugin));
    });
}

function createPluginItem(plugin) {
    const item = document.createElement("div");
    item.className = "plugin-item" + (expandedPluginId === plugin.id ? " expanded" : "");
    item.dataset.pluginId = plugin.id;

    // Header
    const header = document.createElement("div");
    header.className = "plugin-item-header";

    // Expand icon
    const expandIcon = document.createElement("span");
    expandIcon.className = "plugin-expand-icon";
    expandIcon.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l8 7-8 7z"/></svg>';

    // Name
    const nameSpan = document.createElement("span");
    nameSpan.className = "plugin-name";
    nameSpan.textContent = plugin.name;
    nameSpan.title = plugin.name;

    // Source tag
    const sourceTag = document.createElement("span");
    sourceTag.className = "plugin-source-tag " + (plugin.source === "file" ? "tag-file" : "tag-inline");
    sourceTag.textContent = plugin.source;

    // Toggle
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "toggle-switch";
    toggleLabel.addEventListener("click", function(e) { e.stopPropagation(); });

    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = plugin.enabled;
    toggleInput.addEventListener("change", async function(e) {
        e.stopPropagation();
        const enabled = toggleInput.checked;
        const res = await api.toggleHookPlugin(plugin.id, enabled);
        if (!res.success) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `Failed to toggle "${plugin.name}": ${res.error}` });
            toggleInput.checked = !enabled;
        } else {
            addLog({ timestamp: getCurrentTime(), level: "info", message: `Plugin "${plugin.name}" ${enabled ? "enabled" : "disabled"}` });
        }
    });

    const toggleSlider = document.createElement("span");
    toggleSlider.className = "toggle-slider";

    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(toggleSlider);

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "plugin-delete-btn";
    deleteBtn.title = "Delete plugin";
    deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
    deleteBtn.addEventListener("click", async function(e) {
        e.stopPropagation();
        const res = await api.removeHookPlugin(plugin.id);
        if (res.success) {
            addLog({ timestamp: getCurrentTime(), level: "info", message: `Removed plugin: "${plugin.name}"` });
            if (expandedPluginId === plugin.id) {
                expandedPluginId = null;
            }
            await loadPlugins();
        } else {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `Failed to remove "${plugin.name}": ${res.error}` });
        }
    });

    header.appendChild(expandIcon);
    header.appendChild(nameSpan);
    header.appendChild(sourceTag);
    header.appendChild(toggleLabel);
    header.appendChild(deleteBtn);

    // Click header to expand/collapse
    header.addEventListener("click", function() {
        if (expandedPluginId === plugin.id) {
            expandedPluginId = null;
        } else {
            expandedPluginId = plugin.id;
        }
        renderPluginList();
    });

    // Body
    const body = document.createElement("div");
    body.className = "plugin-item-body";

    // File path hint (for file-sourced plugins)
    if (plugin.source === "file" && plugin.filePath) {
        const filePathDiv = document.createElement("div");
        filePathDiv.className = "plugin-file-path";
        filePathDiv.textContent = plugin.filePath;
        filePathDiv.title = plugin.filePath;
        body.appendChild(filePathDiv);
    }

    // Textarea
    const textarea = document.createElement("textarea");
    textarea.className = "plugin-textarea";
    textarea.value = plugin.script;
    textarea.spellcheck = false;
    textarea.placeholder = "// Enter JavaScript code here...";

    if (plugin.source === "file") {
        textarea.readOnly = true;
    } else {
        // Tab key support for inline plugins
        textarea.addEventListener("keydown", function(e) {
            if (e.key === "Tab") {
                e.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.value = textarea.value.substring(0, start) + "    " + textarea.value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 4;
                updatePluginUnsavedHint(plugin.id, textarea, body);
            }
        });

        textarea.addEventListener("input", function() {
            updatePluginUnsavedHint(plugin.id, textarea, body);
        });
    }

    body.appendChild(textarea);

    // Actions (only for inline plugins)
    if (plugin.source === "inline") {
        const actions = document.createElement("div");
        actions.className = "plugin-actions";

        const saveBtn = document.createElement("button");
        saveBtn.className = "btn btn-small btn-primary";
        saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg> Save';
        saveBtn.addEventListener("click", async function() {
            saveBtn.disabled = true;
            const script = textarea.value;
            const res = await api.updateHookPlugin(plugin.id, { script: script });
            if (res.success) {
                pluginSavedScripts[plugin.id] = script;
                updatePluginUnsavedHint(plugin.id, textarea, body);
                addLog({ timestamp: getCurrentTime(), level: "success", message: `Plugin "${plugin.name}" saved (${script.length} chars)` });
            } else {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `Failed to save "${plugin.name}": ${res.error}` });
            }
            saveBtn.disabled = false;
        });

        actions.appendChild(saveBtn);
        body.appendChild(actions);
    }

    item.appendChild(header);
    item.appendChild(body);

    return item;
}

function updatePluginUnsavedHint(pluginId, textarea, bodyEl) {
    let hint = bodyEl.querySelector(".plugin-unsaved-hint");
    const saved = pluginSavedScripts[pluginId] || "";
    if (textarea.value !== saved) {
        if (!hint) {
            hint = document.createElement("div");
            hint.className = "plugin-unsaved-hint";
            hint.textContent = "Unsaved changes";
            bodyEl.appendChild(hint);
        }
    } else {
        if (hint) {
            hint.remove();
        }
    }
}

// ===== Event Listeners from Main Process =====
api.onLog((entry) => {
    addLog(entry);
});

api.onStatusChange((running) => {
    isRunning = running;
    updateStatusUI(running);
    setLoading(false);
});

// ===== UI Helper Functions =====

function updateStatusUI(running) {
    if (running) {
        statusIndicator.classList.add("running");
        statusText.textContent = "Running";
        statusText.style.color = "var(--color-success)";
        btnStart.disabled = true;
        btnStop.disabled = false;
        debugPortInput.disabled = true;
        cdpPortInput.disabled = true;
        bottomInfo.textContent = `Debug: ${debugPortInput.value} | CDP: ${cdpPortInput.value}`;
    } else {
        statusIndicator.classList.remove("running");
        statusText.textContent = "Stopped";
        statusText.style.color = "var(--text-secondary)";
        btnStart.disabled = false;
        btnStop.disabled = true;
        debugPortInput.disabled = false;
        cdpPortInput.disabled = false;
        bottomInfo.textContent = "Ready";
    }
}

function setLoading(loading) {
    if (loading) {
        btnStart.disabled = true;
        btnStop.disabled = true;
    }
}

function addLog(entry) {
    const logEntry = document.createElement("div");
    logEntry.className = `log-entry log-${entry.level}`;

    const timeSpan = document.createElement("span");
    timeSpan.className = "log-time";
    timeSpan.textContent = entry.timestamp;

    const msgSpan = document.createElement("span");
    msgSpan.className = "log-message";
    msgSpan.textContent = entry.message;

    logEntry.appendChild(timeSpan);
    logEntry.appendChild(msgSpan);
    logContainer.appendChild(logEntry);

    // Limit log entries
    while (logContainer.children.length > MAX_LOG_ENTRIES) {
        logContainer.removeChild(logContainer.firstChild);
    }

    // Auto-scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;
}

function renderProcessList(processes) {
    processList.innerHTML = "";
    for (const proc of processes) {
        const item = document.createElement("div");
        item.className = "process-item";

        const left = document.createElement("div");
        left.className = "process-item-left";

        const pid = document.createElement("span");
        pid.className = "process-pid";
        pid.textContent = `PID ${proc.pid}`;

        const version = document.createElement("span");
        version.className = "process-version";
        version.textContent = `v${proc.version}`;

        left.appendChild(pid);
        left.appendChild(version);

        item.appendChild(left);

        if (proc.isParent) {
            const badge = document.createElement("span");
            badge.className = "process-badge";
            badge.textContent = "Parent";
            item.appendChild(badge);
        }

        processList.appendChild(item);
    }
}

function validatePort(port) {
    return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function getCurrentTime() {
    const now = new Date();
    return now.toLocaleTimeString("en-US", { hour12: false });
}

// ===== Initialization =====
async function init() {
    // Load supported versions
    const versionsResult = await api.getVersions();
    if (versionsResult.success && versionsResult.data.length > 0) {
        versionTags.innerHTML = "";
        versionsResult.data.forEach((version, index) => {
            const tag = document.createElement("span");
            tag.className = index === 0 ? "tag tag-latest" : "tag";
            tag.textContent = String(version);
            versionTags.appendChild(tag);
        });
    }

    // Check current status
    const statusResult = await api.getStatus();
    if (statusResult.running) {
        updateStatusUI(true);
    }

    // Load saved hook plugins
    await loadPlugins();
}

init();

})();
