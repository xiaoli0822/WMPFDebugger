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
        maxRenderedEntries = 400,
        duplicateCollapseThreshold = 3,
    } = options;

    let entries = [];
    let filterValue = levelFilter ? levelFilter.value : "all";
    let searchQuery = searchInput ? searchInput.value : "";
    let pendingRender = false;
    let pendingScrollToBottom = false;
    let lastRenderKey = "";

    if (clearButton) {
        clearButton.addEventListener("click", () => {
            entries = [];
            scheduleRender();
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
                .map((entry) => {
                    const duplicateSuffix = entry.repeatCount > 1 ? ` [重复 ${entry.repeatCount} 次]` : "";
                    return `[${entry.timestamp}] [${getLogLevelLabel(entry.level)}] ${entry.message}${duplicateSuffix}`;
                })
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
            scheduleRender();
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", () => {
            searchQuery = searchInput.value;
            scheduleRender();
        });
    }

    function initialize(initialEntries) {
        entries = Array.isArray(initialEntries)
            ? initialEntries.map((entry) => normalizeEntry(entry))
            : [];
        renderLogEntries();
    }

    function addLog(entry) {
        const normalized = normalizeEntry(entry);
        const lastEntry = entries[entries.length - 1];

        if (canCollapseEntry(lastEntry, normalized)) {
            lastEntry.repeatCount += 1;
            lastEntry.lastTimestamp = normalized.timestamp;
        } else {
            entries.push(normalized);
        }

        trimEntries();
        scheduleRender(true);
    }

    function scheduleRender(scrollToBottom = false) {
        pendingScrollToBottom = pendingScrollToBottom || scrollToBottom;
        if (pendingRender) {
            return;
        }

        pendingRender = true;
        requestAnimationFrame(() => {
            pendingRender = false;
            const shouldScroll = pendingScrollToBottom;
            pendingScrollToBottom = false;
            renderLogEntries(shouldScroll);
        });
    }

    function renderLogEntries(scrollToBottom = false) {
        const visibleLogs = getVisibleLogEntries();
        const nextRenderKey = buildRenderKey(visibleLogs);
        const canAppendIncrementally =
            scrollToBottom &&
            filterValue === "all" &&
            !searchQuery.trim() &&
            canUseIncrementalAppend(visibleLogs, nextRenderKey);

        if (canAppendIncrementally) {
            renderIncrementalEntries(visibleLogs);
        } else {
            renderFullEntries(visibleLogs);
        }

        lastRenderKey = nextRenderKey;

        if (scrollToBottom) {
            container.scrollTop = container.scrollHeight;
        }
    }

    function renderIncrementalEntries(visibleLogs) {
        const renderedCount = container.childElementCount;
        const nextCount = visibleLogs.length;

        if (nextCount < renderedCount) {
            renderFullEntries(visibleLogs);
            return;
        }

        if (nextCount === renderedCount && nextCount > 0) {
            const lastVisibleEntry = visibleLogs[nextCount - 1];
            const lastElement = container.lastElementChild;
            if (!lastElement) {
                renderFullEntries(visibleLogs);
                return;
            }

            updateLogEntryElement(lastElement, lastVisibleEntry);
            return;
        }

        const fragment = document.createDocumentFragment();
        for (let index = renderedCount; index < nextCount; index += 1) {
            fragment.appendChild(createLogEntryElement(visibleLogs[index]));
        }
        container.appendChild(fragment);
    }

    function renderFullEntries(visibleLogs) {
        container.replaceChildren();

        if (visibleLogs.length === 0) {
            const empty = document.createElement("div");
            empty.className = "log-empty";
            empty.textContent = entries.length === 0 ? "暂无日志。" : "没有匹配当前筛选条件的日志。";
            container.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        visibleLogs.forEach((entry) => {
            fragment.appendChild(createLogEntryElement(entry));
        });
        container.appendChild(fragment);
    }

    function getVisibleLogEntries() {
        const keyword = searchQuery.trim().toLowerCase();
        const filtered = entries.filter((entry) => {
            if (filterValue !== "all" && entry.level !== filterValue) {
                return false;
            }
            if (!keyword) {
                return true;
            }

            const repeatText = entry.repeatCount > 1 ? ` 重复 ${entry.repeatCount}` : "";
            return `${entry.lastTimestamp} ${getLogLevelLabel(entry.level)} ${entry.message}${repeatText}`
                .toLowerCase()
                .includes(keyword);
        });

        if (filtered.length <= maxRenderedEntries) {
            return filtered;
        }
        return filtered.slice(filtered.length - maxRenderedEntries);
    }

    function createLogEntryElement(entry) {
        const logEntry = document.createElement("div");
        logEntry.className = `log-entry log-${entry.level}`;

        const timeSpan = document.createElement("span");
        timeSpan.className = "log-time";
        timeSpan.textContent = entry.lastTimestamp;

        const msgSpan = document.createElement("span");
        msgSpan.className = "log-message";
        msgSpan.textContent = entry.message;

        logEntry.appendChild(timeSpan);
        logEntry.appendChild(msgSpan);

        if (entry.repeatCount >= duplicateCollapseThreshold) {
            const repeatBadge = document.createElement("span");
            repeatBadge.className = "log-repeat-badge";
            repeatBadge.textContent = `x${entry.repeatCount}`;
            logEntry.appendChild(repeatBadge);
        }

        return logEntry;
    }

    function updateLogEntryElement(element, entry) {
        if (!(element instanceof HTMLElement)) {
            return;
        }

        element.className = `log-entry log-${entry.level}`;
        const timeSpan = element.querySelector(".log-time");
        const msgSpan = element.querySelector(".log-message");
        let badge = element.querySelector(".log-repeat-badge");

        if (timeSpan) {
            timeSpan.textContent = entry.lastTimestamp;
        }
        if (msgSpan) {
            msgSpan.textContent = entry.message;
        }

        if (entry.repeatCount >= duplicateCollapseThreshold) {
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "log-repeat-badge";
                element.appendChild(badge);
            }
            badge.textContent = `x${entry.repeatCount}`;
        } else if (badge) {
            badge.remove();
        }
    }

    function trimEntries() {
        while (entries.length > maxEntries) {
            entries.shift();
        }
    }

    function canCollapseEntry(previous, next) {
        return Boolean(
            previous &&
            previous.level === next.level &&
            previous.message === next.message
        );
    }

    function canUseIncrementalAppend(visibleLogs, nextRenderKey) {
        if (container.childElementCount === 0) {
            return false;
        }
        if (container.firstElementChild && container.firstElementChild.classList.contains("log-empty")) {
            return false;
        }
        if (!lastRenderKey) {
            return false;
        }

        const previousKeys = lastRenderKey.split("\n");
        const currentKeys = visibleLogs.map(getEntryKey);
        if (currentKeys.length < previousKeys.length) {
            return false;
        }

        const prefix = currentKeys.slice(0, previousKeys.length).join("\n");
        return prefix === lastRenderKey && nextRenderKey.startsWith(prefix);
    }

    function buildRenderKey(visibleLogs) {
        return visibleLogs.map(getEntryKey).join("\n");
    }

    function getEntryKey(entry) {
        return `${entry.level}\u0000${entry.message}\u0000${entry.lastTimestamp}\u0000${entry.repeatCount}`;
    }

    function normalizeEntry(entry) {
        return {
            timestamp: String((entry && entry.timestamp) || getCurrentTime()),
            lastTimestamp: String((entry && entry.timestamp) || getCurrentTime()),
            level: normalizeLogLevel(entry && entry.level),
            message: String((entry && entry.message) || ""),
            repeatCount: 1,
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
