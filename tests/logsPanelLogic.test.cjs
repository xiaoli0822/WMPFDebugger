"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    appendLog,
    getVisibleLogEntries,
} = require("./helpers/logsPanelLogic.cjs");

test("appendLog 会折叠连续重复日志并更新最后时间戳", () => {
    let entries = [];
    entries = appendLog(entries, { timestamp: "10:00:00", level: "info", message: "重复日志" });
    entries = appendLog(entries, { timestamp: "10:00:01", level: "info", message: "重复日志" });
    entries = appendLog(entries, { timestamp: "10:00:02", level: "info", message: "重复日志" });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].repeatCount, 3);
    assert.equal(entries[0].timestamp, "10:00:00");
    assert.equal(entries[0].lastTimestamp, "10:00:02");
});

test("appendLog 仅折叠相邻且相同级别的日志", () => {
    let entries = [];
    entries = appendLog(entries, { timestamp: "10:00:00", level: "info", message: "A" });
    entries = appendLog(entries, { timestamp: "10:00:01", level: "warn", message: "A" });
    entries = appendLog(entries, { timestamp: "10:00:02", level: "info", message: "A" });

    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => entry.repeatCount), [1, 1, 1]);
});

test("getVisibleLogEntries 只返回最近的渲染窗口", () => {
    let entries = [];
    for (let index = 0; index < 8; index += 1) {
        entries = appendLog(entries, {
            timestamp: `10:00:0${index}`,
            level: "info",
            message: `日志-${index}`,
        });
    }

    const visible = getVisibleLogEntries(entries, { maxRenderedEntries: 3 });
    assert.deepEqual(
        visible.map((entry) => entry.message),
        ["日志-5", "日志-6", "日志-7"]
    );
});

test("getVisibleLogEntries 搜索时可命中重复次数文本", () => {
    let entries = [];
    entries = appendLog(entries, { timestamp: "10:00:00", level: "info", message: "定时器回调" });
    entries = appendLog(entries, { timestamp: "10:00:01", level: "info", message: "定时器回调" });
    entries = appendLog(entries, { timestamp: "10:00:02", level: "info", message: "定时器回调" });

    const visible = getVisibleLogEntries(entries, { searchQuery: "重复 3" });
    assert.equal(visible.length, 1);
    assert.equal(visible[0].repeatCount, 3);
});
