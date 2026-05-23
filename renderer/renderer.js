import { createLogsModule } from "./modules/logs.js";
import { createPluginModule } from "./modules/plugins.js";
import { createWorkflowModule } from "./modules/workflow.js";

;(function () {
"use strict";

const api = window.debuggerAPI;
const winAPI = window.windowAPI;

if (!api || !winAPI) {
    console.error("Preload APIs are unavailable.", { debuggerAPI: api, windowAPI: winAPI });
    document.body.replaceChildren(createPreloadErrorElement());
    return;
}

const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const debugPortInput = document.getElementById("debug-port");
const cdpPortInput = document.getElementById("cdp-port");
const btnRefreshProcesses = document.getElementById("btn-refresh-processes");
const versionTags = document.getElementById("version-tags");
const processList = document.getElementById("process-list");
const btnCopyLogs = document.getElementById("btn-copy-logs");
const btnClearLogs = document.getElementById("btn-clear-logs");
const logLevelFilter = document.getElementById("log-level-filter");
const logSearchInput = document.getElementById("log-search-input");
const logContainer = document.getElementById("log-container");
const btnOpenDevtools = document.getElementById("btn-open-devtools");
const bottomInfo = document.getElementById("bottom-info");
const btnMinimize = document.getElementById("btn-minimize");
const btnMaximize = document.getElementById("btn-maximize");
const btnClose = document.getElementById("btn-close");
const workflowBadge = document.getElementById("workflow-badge");
const workflowTip = document.getElementById("workflow-tip");
const workflowStepProcessRow = document.getElementById("workflow-step-process-row");
const workflowStepServiceRow = document.getElementById("workflow-step-service-row");
const workflowStepDevtoolsRow = document.getElementById("workflow-step-devtools-row");
const workflowStepProcess = document.getElementById("workflow-step-process");
const workflowStepService = document.getElementById("workflow-step-service");
const workflowStepDevtools = document.getElementById("workflow-step-devtools");
const pluginList = document.getElementById("plugin-list");
const builtinTemplateList = document.getElementById("builtin-template-list");
const pluginSummary = document.getElementById("plugin-summary");
const pluginSearchInput = document.getElementById("plugin-search-input");
const pluginEnabledFilter = document.getElementById("plugin-enabled-filter");
const btnImportFile = document.getElementById("btn-import-file");
const btnAddInline = document.getElementById("btn-add-inline");
const btnExportPlugins = document.getElementById("btn-export-plugins");
const btnImportPlugins = document.getElementById("btn-import-plugins");

let isRunning = false;
let processRecords = [];
let processScanError = "";
let hasScannedProcesses = false;
let isScanningProcesses = false;
let isOpeningDevtools = false;
let pendingServiceAction = null;

const REFRESH_BUTTON_ICON = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
    </svg>`;

const logsModule = createLogsModule({
    container: logContainer,
    clearButton: btnClearLogs,
    copyButton: btnCopyLogs,
    levelFilter: logLevelFilter,
    searchInput: logSearchInput,
    getCurrentTime,
    formatErrorMessage,
});

const workflowModule = createWorkflowModule({
    badge: workflowBadge,
    tip: workflowTip,
    stepProcessRow: workflowStepProcessRow,
    stepServiceRow: workflowStepServiceRow,
    stepDevtoolsRow: workflowStepDevtoolsRow,
    stepProcess: workflowStepProcess,
    stepService: workflowStepService,
    stepDevtools: workflowStepDevtools,
    debugPortInput,
    cdpPortInput,
    formatErrorMessage,
});

const pluginModule = createPluginModule({
    api,
    elements: {
        pluginList,
        builtinTemplateList,
        pluginSummary,
        pluginSearchInput,
        pluginEnabledFilter,
        btnImportFile,
        btnAddInline,
        btnExportPlugins,
        btnImportPlugins,
    },
    addLog,
    getCurrentTime,
    formatErrorMessage,
    createEmptyMessage,
    logPluginReloadHint,
});

btnMinimize.addEventListener("click", () => winAPI.minimize());
btnMaximize.addEventListener("click", () => winAPI.maximize());
btnClose.addEventListener("click", () => winAPI.close());

btnStart.addEventListener("click", async () => {
    if (pendingServiceAction) {
        return;
    }

    const debugPort = parsePortInput(debugPortInput);
    const cdpPort = parsePortInput(cdpPortInput);

    if (debugPort === null || cdpPort === null) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: "端口号无效，必须在 1024 到 65535 之间。" });
        (debugPort === null ? debugPortInput : cdpPortInput).focus();
        return;
    }

    if (debugPort === cdpPort) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: "调试端口和 CDP 端口不能相同。" });
        cdpPortInput.focus();
        return;
    }

    if (!hasScannedProcesses || (!processRecords.length && !processScanError)) {
        await refreshProcesses({ silent: true });
    }

    if (processScanError) {
        addLog({
            timestamp: getCurrentTime(),
            level: "error",
            message: `进程扫描成功前无法启动：${formatErrorMessage(processScanError)}`,
        });
        updateWorkflowUI();
        return;
    }

    if (processRecords.length === 0) {
        addLog({
            timestamp: getCurrentTime(),
            level: "warn",
            message: "未检测到 WMPF 进程。请先启动微信小程序后再试。",
        });
        updateWorkflowUI();
        return;
    }

    pendingServiceAction = "start";
    syncControlState();
    addLog({ timestamp: getCurrentTime(), level: "info", message: "正在启动调试服务..." });

    try {
        const result = await api.start({ debugPort, cdpPort });
        if (!result.success) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `启动失败：${formatErrorMessage(result.error)}` });
        } else {
            addLog({ timestamp: getCurrentTime(), level: "success", message: "调试服务已启动。下一步：打开 DevTools。" });
        }
    } catch (error) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `启动失败：${formatErrorMessage(error)}` });
    } finally {
        pendingServiceAction = null;
        syncControlState();
        updateWorkflowUI();
    }
});

btnStop.addEventListener("click", async () => {
    if (pendingServiceAction) {
        return;
    }

    pendingServiceAction = "stop";
    syncControlState();
    addLog({ timestamp: getCurrentTime(), level: "info", message: "正在停止调试服务..." });

    try {
        const result = await api.stop();
        if (!result.success) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `停止失败：${formatErrorMessage(result.error)}` });
        }
    } catch (error) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `停止失败：${formatErrorMessage(error)}` });
    } finally {
        pendingServiceAction = null;
        syncControlState();
        updateWorkflowUI();
    }
});

btnRefreshProcesses.addEventListener("click", async () => {
    await refreshProcesses();
});

btnOpenDevtools.addEventListener("click", async () => {
    if (!isRunning) {
        addLog({ timestamp: getCurrentTime(), level: "warn", message: "请先启动调试服务，再打开 DevTools。" });
        return;
    }

    const cdpPort = parsePortInput(cdpPortInput);
    if (cdpPort === null) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: "CDP 端口无效。" });
        cdpPortInput.focus();
        return;
    }

    isOpeningDevtools = true;
    syncControlState();
    addLog({ timestamp: getCurrentTime(), level: "info", message: `正在通过端口 ${cdpPort} 打开 DevTools...` });

    try {
        const result = await api.openDevTools(cdpPort);
        if (result.success) {
            const browser = formatBrowserName(result.browser);
            addLog({ timestamp: getCurrentTime(), level: "success", message: `已通过 ${browser} 打开 DevTools。` });
            if (result.url) {
                addLog({ timestamp: getCurrentTime(), level: "info", message: `DevTools 地址：${result.url}` });
            }
        } else {
            addLog({
                timestamp: getCurrentTime(),
                level: "warn",
                message: `无法自动打开 DevTools：${formatErrorMessage(result.error)}`,
            });
            if (result.url) {
                addLog({ timestamp: getCurrentTime(), level: "info", message: `请手动打开：${result.url}` });
            }
        }
    } catch (error) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `打开 DevTools 失败：${formatErrorMessage(error)}` });
    } finally {
        isOpeningDevtools = false;
        syncControlState();
        updateWorkflowUI();
    }
});

api.onLog((entry) => {
    addLog(entry);
});

api.onStatusChange((running) => {
    isRunning = Boolean(running);
    updateStatusUI(isRunning);
    syncControlState();
    updateWorkflowUI();
});

function addLog(entry) {
    logsModule.addLog(entry);
}

function updateStatusUI(running) {
    if (running) {
        statusIndicator.classList.add("running");
        statusText.textContent = "运行中";
        statusText.style.color = "var(--color-success)";
        bottomInfo.textContent = `调试端口：${debugPortInput.value} | CDP：${cdpPortInput.value}`;
        return;
    }

    statusIndicator.classList.remove("running");
    statusText.textContent = "已停止";
    statusText.style.color = "var(--text-secondary)";
    bottomInfo.textContent = hasScannedProcesses ? "已准备好执行下一步" : "正在准备环境";
}

function syncControlState() {
    const serviceBusy = pendingServiceAction !== null;
    btnStart.disabled = serviceBusy || isRunning || isScanningProcesses;
    btnStop.disabled = serviceBusy || !isRunning;
    btnOpenDevtools.disabled = serviceBusy || isOpeningDevtools || !isRunning;
    debugPortInput.disabled = serviceBusy || isRunning;
    cdpPortInput.disabled = serviceBusy || isRunning;
    btnRefreshProcesses.disabled = isScanningProcesses;
    setRefreshButtonContent(isScanningProcesses);
}

function updateWorkflowUI() {
    workflowModule.update({
        isScanningProcesses,
        processScanError,
        processRecords,
        isRunning,
    });
}

async function refreshProcesses(options = {}) {
    isScanningProcesses = true;
    syncControlState();
    updateWorkflowUI();

    try {
        const result = await api.getProcesses();
        hasScannedProcesses = true;
        if (result.success) {
            processRecords = Array.isArray(result.data) ? result.data : [];
            processScanError = "";
            renderProcessList(processRecords);
            if (!options.silent) {
                if (processRecords.length > 0) {
                    addLog({ timestamp: getCurrentTime(), level: "success", message: `找到 ${processRecords.length} 个 WeChatAppEx 进程。` });
                } else {
                    addLog({ timestamp: getCurrentTime(), level: "warn", message: "未检测到 WMPF 进程。请启动微信小程序后重新扫描。" });
                }
            }
        } else {
            processRecords = [];
            processScanError = result.error || "Unknown scan error";
            processList.replaceChildren(createEmptyMessage("process-empty", "进程扫描失败。请查看日志后重试。"));
            if (!options.silent) {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `进程扫描失败：${formatErrorMessage(processScanError)}` });
            }
        }
    } catch (error) {
        hasScannedProcesses = true;
        processRecords = [];
        processScanError = formatErrorMessage(error);
        processList.replaceChildren(createEmptyMessage("process-empty", "进程扫描失败。请查看日志后重试。"));
        if (!options.silent) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `进程扫描失败：${processScanError}` });
        }
    } finally {
        isScanningProcesses = false;
        syncControlState();
        updateWorkflowUI();
        updateStatusUI(isRunning);
    }
}

function renderProcessList(processes) {
    processList.replaceChildren();
    if (!processes.length) {
        processList.appendChild(createEmptyMessage("process-empty", "未检测到 WMPF 进程。请启动微信小程序后重新扫描。"));
        return;
    }

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
            badge.textContent = "父进程";
            item.appendChild(badge);
        }

        processList.appendChild(item);
    }
}

function parsePortInput(input) {
    const raw = String(input.value).trim();
    if (!/^\d+$/.test(raw)) {
        return null;
    }

    const port = Number(raw);
    return validatePort(port) ? port : null;
}

function validatePort(port) {
    return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function createEmptyMessage(className, text) {
    const element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    return element;
}

function createPreloadErrorElement() {
    const element = document.createElement("div");
    element.style.color = "red";
    element.style.padding = "40px";
    element.style.fontSize = "16px";
    element.textContent = "错误：Preload 脚本加载失败，请查看控制台详情。";
    return element;
}

function getCurrentTime() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function logPluginReloadHint(subject) {
    addLog({
        timestamp: getCurrentTime(),
        level: "info",
        message: `${subject} 会在重新打开 DevTools 或刷新目标页面后生效。`,
    });
}

function formatBrowserName(browser) {
    const names = {
        chrome: "Chrome",
        edge: "Edge",
        system: "系统默认浏览器",
        unknown: "浏览器",
    };
    return names[String(browser || "unknown")] || String(browser);
}

function formatErrorMessage(error) {
    const raw = error instanceof Error ? error.message : String(error || "未知错误");
    const known = {
        "service-not-running": "调试服务未运行",
        "invalid-browser-executable": "浏览器可执行文件无效",
        "cancelled": "操作已取消",
        "unable-to-open-devtools": "未能启动浏览器内置 DevTools 前端",
        "unknown error": "未知错误",
        "Unknown scan error": "未知扫描错误",
    };

    return known[raw] || raw;
}

function setRefreshButtonContent(scanning) {
    btnRefreshProcesses.replaceChildren();
    if (scanning) {
        const spinner = document.createElement("span");
        spinner.className = "spinner";
        btnRefreshProcesses.appendChild(spinner);
        btnRefreshProcesses.appendChild(document.createTextNode(" 扫描中..."));
        return;
    }

    const template = document.createElement("template");
    template.innerHTML = REFRESH_BUTTON_ICON.trim();
    btnRefreshProcesses.appendChild(template.content.firstElementChild);
    btnRefreshProcesses.appendChild(document.createTextNode(" 刷新"));
}

async function init() {
    logsModule.initialize([{
        timestamp: "--:--:--",
        level: "info",
        message: "欢迎使用 WMPFDebugger。点击“启动”开始调试。",
    }]);

    try {
        const versionsResult = await api.getVersions();
        if (versionsResult.success && Array.isArray(versionsResult.data) && versionsResult.data.length > 0) {
            versionTags.replaceChildren();
            versionsResult.data.forEach((version, index) => {
                const tag = document.createElement("span");
                tag.className = index === 0 ? "tag tag-latest" : "tag";
                tag.textContent = String(version);
                versionTags.appendChild(tag);
            });
        } else if (!versionsResult.success) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `加载支持版本失败：${formatErrorMessage(versionsResult.error)}` });
        }
    } catch (error) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `加载支持版本失败：${formatErrorMessage(error)}` });
    }

    try {
        const statusResult = await api.getStatus();
        isRunning = Boolean(statusResult.running);
        updateStatusUI(isRunning);
    } catch (error) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `加载服务状态失败：${formatErrorMessage(error)}` });
    }

    try {
        await pluginModule.loadPlugins();
    } catch (error) {
        addLog({ timestamp: getCurrentTime(), level: "error", message: `加载插件失败：${formatErrorMessage(error)}` });
    }

    try {
        await refreshProcesses({ silent: true });
    } finally {
        syncControlState();
        updateWorkflowUI();
    }
}

setRefreshButtonContent(false);
init();

})();
