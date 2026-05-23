"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

require("ts-node/register");

const { getBuiltinHookTemplates } = require("../electron/builtinHookTemplates.ts");
const { HookManager } = require("../electron/hookManager.ts");

test("内置模板注册表返回 4 个唯一模板，且脚本可通过语法检查", () => {
    const templates = getBuiltinHookTemplates();

    assert.equal(templates.length, 4);
    assert.equal(new Set(templates.map((template) => template.id)).size, 4);
    assert.deepEqual(
        templates.map((template) => template.id),
        [
            "builtin-wasm-memory-observer",
            "builtin-loop-observer",
            "builtin-wasm-export-observer",
            "builtin-binary-resource-observer",
        ]
    );

    for (const template of templates) {
        assert.ok(template.id);
        assert.ok(template.name);
        assert.ok(template.description);
        assert.ok(template.category);
        assert.ok(Array.isArray(template.tags));
        assert.ok(template.script.trim().length > 0);
        assert.doesNotThrow(() => new Function(template.script));
    }
});

test("从模板复制插件时生成内联禁用插件，并处理重名追加序号", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wmpf-hook-manager-"));
    try {
        const hookManager = new HookManager({ configDir: tempDir });
        await hookManager.load();

        const first = await hookManager.createPluginFromTemplate("builtin-wasm-memory-observer");
        const second = await hookManager.createPluginFromTemplate("builtin-wasm-memory-observer");

        assert.equal(first.source, "inline");
        assert.equal(first.enabled, false);
        assert.equal(first.name, "WASM / 内存观察模板");

        assert.equal(second.source, "inline");
        assert.equal(second.enabled, false);
        assert.equal(second.name, "WASM / 内存观察模板 2");

        const persistedRaw = await fs.readFile(path.join(tempDir, "hook-scripts.json"), "utf-8");
        const persisted = JSON.parse(persistedRaw);
        assert.equal(persisted.plugins.length, 2);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
