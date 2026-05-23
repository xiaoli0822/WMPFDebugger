"use strict";

// 供轻量测试复用的纯函数，行为对齐当前插件面板中的筛选与删除确认文案。

function normalizeKeyword(keyword) {
    return String(keyword || "").trim().toLowerCase();
}

function matchesEnabledFilter(plugin, enabled) {
    if (enabled === "enabled") {
        return Boolean(plugin.enabled);
    }
    if (enabled === "disabled") {
        return !plugin.enabled;
    }
    return true;
}

function toSearchText(plugin) {
    return [
        plugin.name,
        plugin.script,
        plugin.filePath,
        plugin.source === "file" ? "文件" : "内联",
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
}

function filterPlugins(plugins, options) {
    const list = Array.isArray(plugins) ? plugins : [];
    const keyword = normalizeKeyword(options && options.keyword);
    const enabled = options && (options.enabled === "enabled" || options.enabled === "disabled")
        ? options.enabled
        : "all";

    return list.filter((plugin) => {
        if (!plugin || typeof plugin !== "object") {
            return false;
        }
        if (!matchesEnabledFilter(plugin, enabled)) {
            return false;
        }
        if (!keyword) {
            return true;
        }
        return toSearchText(plugin).includes(keyword);
    });
}

function buildDeleteConfirmationMessage(pluginName) {
    return `确定要删除插件“${String(pluginName)}”吗？此操作不可撤销。`;
}

function createDeleteCancellationLog(pluginName) {
    return {
        level: "info",
        message: `已取消删除插件：“${String(pluginName)}”`,
    };
}

function createDeleteSuccessLog(pluginName) {
    return {
        level: "info",
        message: `已删除插件：“${String(pluginName)}”`,
    };
}

function createDeleteFailureLog(pluginName, errorMessage) {
    return {
        level: "error",
        message: `删除“${String(pluginName)}”失败：${String(errorMessage || "未知错误")}`,
    };
}

module.exports = {
    buildDeleteConfirmationMessage,
    createDeleteCancellationLog,
    createDeleteFailureLog,
    createDeleteSuccessLog,
    filterPlugins,
};
