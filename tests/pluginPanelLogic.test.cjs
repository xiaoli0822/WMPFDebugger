"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildDeleteConfirmationMessage,
    createDeleteCancellationLog,
    createDeleteFailureLog,
    createDeleteSuccessLog,
    filterPlugins,
} = require("./helpers/pluginPanelLogic.cjs");

const samplePlugins = [
    {
        id: "inline-enabled",
        name: "WASM Patch",
        script: "console.log('wasm');",
        enabled: true,
        source: "inline",
    },
    {
        id: "file-disabled",
        name: "Memory Hook",
        script: "Interceptor.attach(ptr('0x1234'), {});",
        enabled: false,
        source: "file",
        filePath: "C:/hooks/memory-hook.js",
    },
    null,
];

test("filterPlugins 按关键字大小写无关匹配名称、脚本和路径", () => {
    assert.deepEqual(
        filterPlugins(samplePlugins, { keyword: "wasm" }).map((plugin) => plugin.id),
        ["inline-enabled"]
    );
    assert.deepEqual(
        filterPlugins(samplePlugins, { keyword: "0X1234" }).map((plugin) => plugin.id),
        ["file-disabled"]
    );
    assert.deepEqual(
        filterPlugins(samplePlugins, { keyword: "memory-hook.js" }).map((plugin) => plugin.id),
        ["file-disabled"]
    );
});

test("filterPlugins 按启用状态筛选插件", () => {
    assert.deepEqual(
        filterPlugins(samplePlugins, { enabled: "enabled" }).map((plugin) => plugin.id),
        ["inline-enabled"]
    );
    assert.deepEqual(
        filterPlugins(samplePlugins, { enabled: "disabled" }).map((plugin) => plugin.id),
        ["file-disabled"]
    );
});

test("buildDeleteConfirmationMessage 输出中文确认文案", () => {
    assert.equal(
        buildDeleteConfirmationMessage("内存 Hook"),
        "确定要删除插件“内存 Hook”吗？此操作不可撤销。"
    );
});

test("删除确认相关日志文案与现有交互保持一致", () => {
    assert.deepEqual(createDeleteCancellationLog("WASM Patch"), {
        level: "info",
        message: "已取消删除插件：“WASM Patch”",
    });
    assert.deepEqual(createDeleteSuccessLog("WASM Patch"), {
        level: "info",
        message: "已删除插件：“WASM Patch”",
    });
    assert.deepEqual(createDeleteFailureLog("WASM Patch", "权限不足"), {
        level: "error",
        message: "删除“WASM Patch”失败：权限不足",
    });
});
