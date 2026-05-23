export function createLogsModule(options) {
    const {
        container,
        clearButton,
        copyButton,
        levelFilter,
        searchInput,
        getCurrentTime,
        formatErrorMessage,
        maxEntries = 1000,
    } = options;

    let entries = [];
    let filterValue = levelFilter ? levelFilter.value : "all";
    let searchQuery = searchInput ? searchInput.value : "";

    if (clearButton) {
        clearButton.addEventListener("click", () => {
            entries = [];
            renderLogEntries();
            addLog({ timestamp: getCurrentTime(), level: "info", message: "日志已清空" });
        });
    }

    if (copyButton) {
        copyButton.addEventListener("click", async () => {
            const visibleLogs = getVisibleLogEntries();
            if (visibleLogs.length === 0) {
                addLog({ timestamp: getCurrentTime(), level: "warn", message: "没有可复制的日志。" });
                return;
            }

            const text = visibleLogs
                .map((entry) => `[${entry.timestamp}] [${getLogLevelLabel(entry.level)}] ${entry.message}`)
                .join("\n");

            try {
                await copyTextToClipboard(text);
                addLog({ timestamp: getCurrentTime(), level: "success", message: `已复制 ${visibleLogs.length} 条日志。` });
            } catch (error) {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `复制日志失败：${formatErrorMessage(error)}` });
            }
        });
    }

    if (levelFilter) {
        levelFilter.addEventListener("change", () => {
            filterValue = levelFilter.value;
            renderLogEntries();
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", () => {
            searchQuery = searchInput.value;
            renderLogEntries();
        });
    }

    function initialize(initialEntries) {
        entries = Array.isArray(initialEntries) ? initialEntries.map(normalizeEntry) : [];
        renderLogEntries();
    }

    function addLog(entry) {
        entries.push(normalizeEntry(entry));

        while (entries.length > maxEntries) {
            entries.shift();
        }

        renderLogEntries(true);
    }

    function renderLogEntries(scrollToBottom = false) {
        const visibleLogs = getVisibleLogEntries();
        container.replaceChildren();

        if (visibleLogs.length === 0) {
            const empty = document.createElement("div");
            empty.className = "log-empty";
            empty.textContent = entries.length === 0 ? "暂无日志。" : "没有匹配当前筛选条件的日志。";
            container.appendChild(empty);
            return;
        }

        visibleLogs.forEach((entry) => {
            container.appendChild(createLogEntryElement(entry));
        });

        if (scrollToBottom) {
            container.scrollTop = container.scrollHeight;
        }
    }

    function getVisibleLogEntries() {
        const keyword = searchQuery.trim().toLowerCase();
        return entries.filter((entry) => {
            if (filterValue !== "all" && entry.level !== filterValue) {
                return false;
            }
            if (!keyword) {
                return true;
            }
            return `${entry.timestamp} ${getLogLevelLabel(entry.level)} ${entry.message}`.toLowerCase().includes(keyword);
        });
    }

    function createLogEntryElement(entry) {
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
        return logEntry;
    }

    function normalizeEntry(entry) {
        return {
            timestamp: String((entry && entry.timestamp) || getCurrentTime()),
            level: normalizeLogLevel(entry && entry.level),
            message: String((entry && entry.message) || ""),
        };
    }

    function normalizeLogLevel(level) {
        return ["info", "success", "warn", "error"].includes(level) ? level : "info";
    }

    function getLogLevelLabel(level) {
        const labels = {
            info: "信息",
            success: "成功",
            warn: "警告",
            error: "错误",
        };
        return labels[level] || "信息";
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "readonly");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand("copy");
        textarea.remove();
        if (!ok) {
            throw new Error("剪贴板写入失败");
        }
    }

    return {
        initialize,
        addLog,
        renderLogEntries,
        getVisibleLogEntries,
    };
}
