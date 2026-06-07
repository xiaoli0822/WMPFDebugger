"use strict";

function normalizeLogLevel(level) {
    return ["info", "success", "warn", "error"].includes(level) ? level : "info";
}

function normalizeEntry(entry, fallbackTimestamp = "00:00:00") {
    const timestamp = String((entry && entry.timestamp) || fallbackTimestamp);
    return {
        timestamp,
        lastTimestamp: timestamp,
        level: normalizeLogLevel(entry && entry.level),
        message: String((entry && entry.message) || ""),
        repeatCount: 1,
    };
}

function appendLog(entries, entry, maxEntries = 1000) {
    const nextEntries = Array.isArray(entries) ? entries.map(cloneEntry) : [];
    const normalized = normalizeEntry(entry);
    const lastEntry = nextEntries[nextEntries.length - 1];

    if (lastEntry && lastEntry.level === normalized.level && lastEntry.message === normalized.message) {
        lastEntry.repeatCount += 1;
        lastEntry.lastTimestamp = normalized.timestamp;
    } else {
        nextEntries.push(normalized);
    }

    while (nextEntries.length > maxEntries) {
        nextEntries.shift();
    }

    return nextEntries;
}

function getVisibleLogEntries(entries, options = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const filterValue = options.filterValue || "all";
    const searchQuery = String(options.searchQuery || "").trim().toLowerCase();
    const maxRenderedEntries = Number.isInteger(options.maxRenderedEntries)
        ? options.maxRenderedEntries
        : 400;

    const filtered = list.filter((entry) => {
        if (filterValue !== "all" && entry.level !== filterValue) {
            return false;
        }
        if (!searchQuery) {
            return true;
        }
        const repeatText = entry.repeatCount > 1 ? ` 重复 ${entry.repeatCount}` : "";
        return `${entry.lastTimestamp} ${entry.level} ${entry.message}${repeatText}`
            .toLowerCase()
            .includes(searchQuery);
    });

    if (filtered.length <= maxRenderedEntries) {
        return filtered.map(cloneEntry);
    }

    return filtered.slice(filtered.length - maxRenderedEntries).map(cloneEntry);
}

function cloneEntry(entry) {
    return {
        timestamp: entry.timestamp,
        lastTimestamp: entry.lastTimestamp,
        level: entry.level,
        message: entry.message,
        repeatCount: entry.repeatCount,
    };
}

module.exports = {
    appendLog,
    getVisibleLogEntries,
};
