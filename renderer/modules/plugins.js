export function createPluginModule(options) {
    const {
        api,
        elements,
        addLog,
        getCurrentTime,
        formatErrorMessage,
        createEmptyMessage,
        logPluginReloadHint,
    } = options;

    const {
        pluginList,
        builtinTemplateList,
        pluginSummary,
        pluginSearchInput,
        pluginEnabledFilter,
        btnImportFile,
        btnAddInline,
        btnExportPlugins,
        btnImportPlugins,
    } = elements;

    let plugins = [];
    let builtinTemplates = [];
    let expandedPluginId = null;
    let expandedTemplateId = null;
    let pendingFocusPluginId = null;
    let pluginSavedScripts = {};
    let searchQuery = "";
    let enabledFilter = "all";

    if (pluginSearchInput) {
        pluginSearchInput.addEventListener("input", () => {
            searchQuery = pluginSearchInput.value;
            renderBuiltinTemplates();
            renderPluginList();
        });
    }

    if (pluginEnabledFilter) {
        pluginEnabledFilter.addEventListener("change", () => {
            enabledFilter = pluginEnabledFilter.value;
            renderPluginList();
        });
    }

    if (btnImportFile) {
        btnImportFile.addEventListener("click", handleImportFile);
    }

    if (btnAddInline) {
        btnAddInline.addEventListener("click", handleAddInline);
    }

    if (btnExportPlugins) {
        btnExportPlugins.addEventListener("click", handleExportPlugins);
    }

    if (btnImportPlugins) {
        btnImportPlugins.addEventListener("click", handleImportPlugins);
    }

    async function loadPlugins() {
        await Promise.all([
            loadBuiltinTemplates(),
            loadUserPlugins(),
        ]);
    }

    async function loadBuiltinTemplates() {
        if (typeof api.getBuiltinHookTemplates !== "function") {
            builtinTemplates = [];
            renderBuiltinTemplates();
            return;
        }

        try {
            const result = await api.getBuiltinHookTemplates();
            if (result.success) {
                builtinTemplates = Array.isArray(result.data) ? result.data : [];
                renderBuiltinTemplates();
            } else {
                builtinTemplates = [];
                renderBuiltinTemplates(`加载内置模板失败：${formatErrorMessage(result.error)}`);
            }
        } catch (error) {
            builtinTemplates = [];
            renderBuiltinTemplates(`加载内置模板失败：${formatErrorMessage(error)}`);
        }
    }

    async function loadUserPlugins() {
        try {
            const result = await api.getHookPlugins();
            if (result.success) {
                plugins = Array.isArray(result.data) ? result.data : [];
                pluginSavedScripts = {};
                plugins.forEach((plugin) => {
                    pluginSavedScripts[plugin.id] = plugin.script || "";
                });
                renderPluginList();
            } else {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `加载插件失败：${formatErrorMessage(result.error)}` });
            }
        } catch (error) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `加载插件失败：${formatErrorMessage(error)}` });
        }
    }

    function renderBuiltinTemplates(errorMessage = "") {
        if (!builtinTemplateList) {
            return;
        }

        builtinTemplateList.replaceChildren();

        if (errorMessage) {
            builtinTemplateList.appendChild(createEmptyMessage("plugin-empty", errorMessage));
            return;
        }

        const visibleTemplates = getVisibleTemplates();
        if (builtinTemplates.length === 0) {
            builtinTemplateList.appendChild(createEmptyMessage("plugin-empty", "当前没有可用的内置模板。"));
            return;
        }

        if (visibleTemplates.length === 0) {
            builtinTemplateList.appendChild(createEmptyMessage("plugin-empty", "没有匹配当前搜索条件的内置模板。"));
            return;
        }

        visibleTemplates.forEach((template) => {
            builtinTemplateList.appendChild(createBuiltinTemplateItem(template));
        });
    }

    function renderPluginList() {
        const visiblePlugins = getVisiblePlugins();
        updatePluginSummary(visiblePlugins.length, plugins.length);
        pluginList.replaceChildren();

        if (plugins.length === 0) {
            pluginList.appendChild(createEmptyMessage("plugin-empty", "还没有插件。点击“导入文件”或“新建内联”开始。"));
            return;
        }

        if (visiblePlugins.length === 0) {
            pluginList.appendChild(createEmptyMessage("plugin-empty", "没有匹配当前搜索或筛选条件的插件。"));
            return;
        }

        visiblePlugins.forEach((plugin) => {
            pluginList.appendChild(createPluginItem(plugin));
        });

        focusPendingPluginEditor();
    }

    function getVisibleTemplates() {
        const keyword = searchQuery.trim().toLowerCase();
        return builtinTemplates.filter((template) => {
            if (!keyword) {
                return true;
            }

            const searchText = [
                template.name,
                template.description,
                template.category,
                ...(Array.isArray(template.tags) ? template.tags : []),
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();

            return searchText.includes(keyword);
        });
    }

    function getVisiblePlugins() {
        const keyword = searchQuery.trim().toLowerCase();
        return plugins.filter((plugin) => {
            if (enabledFilter === "enabled" && !plugin.enabled) {
                return false;
            }
            if (enabledFilter === "disabled" && plugin.enabled) {
                return false;
            }

            if (!keyword) {
                return true;
            }

            const searchText = [
                plugin.name,
                plugin.source,
                plugin.filePath,
                plugin.script,
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();

            return searchText.includes(keyword);
        });
    }

    function updatePluginSummary(visibleCount, totalCount) {
        if (!pluginSummary) {
            return;
        }
        pluginSummary.textContent = `显示 ${visibleCount} / ${totalCount} 个插件`;
    }

    function createBuiltinTemplateItem(template) {
        const item = document.createElement("div");
        item.className = "builtin-template-item";

        const header = document.createElement("div");
        header.className = "builtin-template-header";

        const titleWrap = document.createElement("div");
        titleWrap.className = "builtin-template-title-wrap";

        const nameEl = document.createElement("div");
        nameEl.className = "builtin-template-name";
        nameEl.textContent = template.name;

        const descEl = document.createElement("div");
        descEl.className = "builtin-template-desc";
        descEl.textContent = template.description;

        titleWrap.appendChild(nameEl);
        titleWrap.appendChild(descEl);

        const actions = document.createElement("div");
        actions.className = "builtin-template-actions";

        const previewBtn = document.createElement("button");
        previewBtn.className = "btn btn-small btn-secondary";
        previewBtn.textContent = expandedTemplateId === template.id ? "收起脚本" : "预览脚本";
        previewBtn.addEventListener("click", () => {
            expandedTemplateId = expandedTemplateId === template.id ? null : template.id;
            renderBuiltinTemplates();
        });

        const copyBtn = document.createElement("button");
        copyBtn.className = "btn btn-small btn-secondary";
        copyBtn.textContent = "复制为插件";
        copyBtn.addEventListener("click", async () => {
            copyBtn.disabled = true;
            try {
                if (typeof api.createHookPluginFromTemplate !== "function") {
                    throw new Error("当前版本未注入 createHookPluginFromTemplate");
                }
                const result = await api.createHookPluginFromTemplate(template.id);
                if (result.success && result.data) {
                    expandedPluginId = result.data.id;
                    pendingFocusPluginId = result.data.id;
                    addLog({
                        timestamp: getCurrentTime(),
                        level: "success",
                        message: `已从模板创建插件：“${result.data.name}”`,
                    });
                    await loadUserPlugins();
                } else {
                    addLog({
                        timestamp: getCurrentTime(),
                        level: "error",
                        message: `创建模板插件失败：${formatErrorMessage(result.error)}`,
                    });
                }
            } catch (error) {
                addLog({
                    timestamp: getCurrentTime(),
                    level: "error",
                    message: `创建模板插件失败：${formatErrorMessage(error)}`,
                });
            } finally {
                copyBtn.disabled = false;
            }
        });

        actions.appendChild(previewBtn);
        actions.appendChild(copyBtn);

        header.appendChild(titleWrap);
        header.appendChild(actions);

        const meta = document.createElement("div");
        meta.className = "builtin-template-meta";
        const lineCount = String(template.script || "").split(/\r?\n/).length;
        meta.textContent = `${template.category} · ${lineCount} 行脚本`;

        const tags = document.createElement("div");
        tags.className = "builtin-template-tags";
        (Array.isArray(template.tags) ? template.tags : []).forEach((tag) => {
            const tagEl = document.createElement("span");
            tagEl.className = "builtin-template-tag";
            tagEl.textContent = tag;
            tags.appendChild(tagEl);
        });

        item.appendChild(header);
        item.appendChild(meta);
        item.appendChild(tags);

        if (expandedTemplateId === template.id) {
            const preview = document.createElement("textarea");
            preview.className = "plugin-textarea builtin-template-preview";
            preview.readOnly = true;
            preview.value = template.script || "";
            preview.spellcheck = false;
            item.appendChild(preview);
        }
        return item;
    }

    function createPluginItem(plugin) {
        const item = document.createElement("div");
        item.className = "plugin-item" + (expandedPluginId === plugin.id ? " expanded" : "");
        item.dataset.pluginId = plugin.id;

        const header = document.createElement("div");
        header.className = "plugin-item-header";

        const expandIcon = document.createElement("span");
        expandIcon.className = "plugin-expand-icon";
        expandIcon.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l8 7-8 7z"/></svg>';

        const nameSpan = document.createElement("span");
        nameSpan.className = "plugin-name";
        nameSpan.textContent = plugin.name;
        nameSpan.title = plugin.name;

        const sourceTag = document.createElement("span");
        sourceTag.className = "plugin-source-tag " + (plugin.source === "file" ? "tag-file" : "tag-inline");
        sourceTag.textContent = plugin.source === "file" ? "文件" : "内联";

        const toggleLabel = document.createElement("label");
        toggleLabel.className = "toggle-switch";
        toggleLabel.addEventListener("click", (event) => event.stopPropagation());

        const toggleInput = document.createElement("input");
        toggleInput.type = "checkbox";
        toggleInput.checked = Boolean(plugin.enabled);
        toggleInput.addEventListener("change", async (event) => {
            event.stopPropagation();
            const intendedEnabled = toggleInput.checked;
            toggleInput.disabled = true;

            try {
                const result = await api.toggleHookPlugin(plugin.id, intendedEnabled);
                if (!result.success) {
                    addLog({ timestamp: getCurrentTime(), level: "error", message: `切换“${plugin.name}”失败：${formatErrorMessage(result.error)}` });
                    toggleInput.checked = !intendedEnabled;
                    return;
                }

                const actualEnabled = Boolean(result.data && result.data.enabled);
                toggleInput.checked = actualEnabled;
                if (intendedEnabled && !actualEnabled) {
                    addLog({ timestamp: getCurrentTime(), level: "warn", message: `插件“${plugin.name}”脚本为空，仍保持禁用。` });
                } else {
                    addLog({ timestamp: getCurrentTime(), level: "info", message: `插件“${plugin.name}”已${actualEnabled ? "启用" : "禁用"}` });
                    logPluginReloadHint(`插件“${plugin.name}”`);
                }
                await loadUserPlugins();
            } catch (error) {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `切换“${plugin.name}”失败：${formatErrorMessage(error)}` });
                toggleInput.checked = !intendedEnabled;
            } finally {
                toggleInput.disabled = false;
            }
        });

        const toggleSlider = document.createElement("span");
        toggleSlider.className = "toggle-slider";
        toggleLabel.appendChild(toggleInput);
        toggleLabel.appendChild(toggleSlider);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "plugin-delete-btn";
        deleteBtn.title = "删除插件";
        deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
        deleteBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (!window.confirm(`确定要删除插件“${plugin.name}”吗？此操作不可撤销。`)) {
                addLog({ timestamp: getCurrentTime(), level: "info", message: `已取消删除插件：“${plugin.name}”` });
                return;
            }

            deleteBtn.disabled = true;
            try {
                const result = await api.removeHookPlugin(plugin.id);
                if (result.success) {
                    addLog({ timestamp: getCurrentTime(), level: "info", message: `已删除插件：“${plugin.name}”` });
                    if (expandedPluginId === plugin.id) {
                        expandedPluginId = null;
                    }
                    await loadUserPlugins();
                } else {
                    addLog({ timestamp: getCurrentTime(), level: "error", message: `删除“${plugin.name}”失败：${formatErrorMessage(result.error)}` });
                }
            } catch (error) {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `删除“${plugin.name}”失败：${formatErrorMessage(error)}` });
            } finally {
                deleteBtn.disabled = false;
            }
        });

        header.appendChild(expandIcon);
        header.appendChild(nameSpan);
        header.appendChild(sourceTag);
        header.appendChild(toggleLabel);
        header.appendChild(deleteBtn);
        header.addEventListener("click", () => {
            expandedPluginId = expandedPluginId === plugin.id ? null : plugin.id;
            renderPluginList();
        });

        const body = document.createElement("div");
        body.className = "plugin-item-body";

        if (plugin.source === "file" && plugin.filePath) {
            const filePathDiv = document.createElement("div");
            filePathDiv.className = "plugin-file-path";
            filePathDiv.textContent = plugin.filePath;
            filePathDiv.title = plugin.filePath;
            body.appendChild(filePathDiv);
        }

        const textarea = document.createElement("textarea");
        textarea.className = "plugin-textarea";
        textarea.value = plugin.script || "";
        textarea.spellcheck = false;
        textarea.placeholder = "// 在这里输入 JavaScript 代码...";

        if (plugin.source === "file") {
            textarea.readOnly = true;
        } else {
            textarea.addEventListener("keydown", (event) => {
                if (event.key !== "Tab") {
                    return;
                }
                event.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.value = textarea.value.slice(0, start) + "    " + textarea.value.slice(end);
                textarea.selectionStart = start + 4;
                textarea.selectionEnd = start + 4;
                updatePluginUnsavedHint(plugin.id, textarea, body);
            });

            textarea.addEventListener("input", () => {
                updatePluginUnsavedHint(plugin.id, textarea, body);
            });
        }

        body.appendChild(textarea);

        if (plugin.source === "inline") {
            const actions = document.createElement("div");
            actions.className = "plugin-actions";

            const saveBtn = document.createElement("button");
            saveBtn.className = "btn btn-small btn-primary";
            saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg>';
            saveBtn.appendChild(document.createTextNode(" 保存"));
            saveBtn.addEventListener("click", async () => {
                saveBtn.disabled = true;
                try {
                    const script = textarea.value;
                    const result = await api.updateHookPlugin(plugin.id, { script });
                    if (result.success) {
                        pluginSavedScripts[plugin.id] = script;
                        addLog({ timestamp: getCurrentTime(), level: "success", message: `插件“${plugin.name}”已保存（${script.length} 个字符）` });
                        logPluginReloadHint(`已保存的插件“${plugin.name}”`);
                        await loadUserPlugins();
                    } else {
                        addLog({ timestamp: getCurrentTime(), level: "error", message: `保存“${plugin.name}”失败：${formatErrorMessage(result.error)}` });
                    }
                } catch (error) {
                    addLog({ timestamp: getCurrentTime(), level: "error", message: `保存“${plugin.name}”失败：${formatErrorMessage(error)}` });
                } finally {
                    saveBtn.disabled = false;
                }
            });

            actions.appendChild(saveBtn);
            body.appendChild(actions);
        }

        const statusHint = document.createElement("div");
        statusHint.className = "plugin-status-hint";
        if (plugin.source === "inline" && !String(plugin.script || "").trim()) {
            statusHint.classList.add("warning");
            statusHint.textContent = "脚本为空，暂时不能启用此插件。";
        } else if (plugin.enabled) {
            statusHint.classList.add("info");
            statusHint.textContent = "启用后的变更会在重新打开 DevTools 或刷新目标页面后生效。";
        } else if (plugin.source === "file") {
            statusHint.textContent = "导入的脚本在这里保持只读；需要生效时请启用插件。";
        } else {
            statusHint.textContent = "请先保存编辑；准备应用时再启用插件。";
        }
        body.appendChild(statusHint);

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
                hint.textContent = "有未保存的更改";
                bodyEl.appendChild(hint);
            }
            return;
        }

        if (hint) {
            hint.remove();
        }
    }

    async function handleImportFile() {
        btnImportFile.disabled = true;
        try {
            const result = await api.importHookFile();
            if (result.success && result.data) {
                addLog({ timestamp: getCurrentTime(), level: "success", message: `已导入插件：“${result.data.name}”` });
                await loadUserPlugins();
            } else if (result.error && result.error !== "cancelled") {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `导入失败：${formatErrorMessage(result.error)}` });
            }
        } catch (error) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `导入失败：${formatErrorMessage(error)}` });
        } finally {
            btnImportFile.disabled = false;
        }
    }

    async function handleAddInline() {
        btnAddInline.disabled = true;
        const name = "内联脚本 " + (plugins.length + 1);
        try {
            const result = await api.addHookPlugin(name, "", "inline");
            if (result.success && result.data) {
                addLog({ timestamp: getCurrentTime(), level: "success", message: `已新建内联插件：“${result.data.name}”` });
                expandedPluginId = result.data.id;
                pendingFocusPluginId = result.data.id;
                await loadUserPlugins();
            } else {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `新建插件失败：${formatErrorMessage(result.error)}` });
            }
        } catch (error) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `新建插件失败：${formatErrorMessage(error)}` });
        } finally {
            btnAddInline.disabled = false;
        }
    }

    async function handleExportPlugins() {
        const exportMethod = typeof api.exportHookPluginsConfig === "function"
            ? "exportHookPluginsConfig"
            : "exportHookPlugins";
        if (!ensureApiMethod(exportMethod)) {
            return;
        }

        btnExportPlugins.disabled = true;
        try {
            const result = await api[exportMethod]();
            if (result && result.success) {
                addLog({ timestamp: getCurrentTime(), level: "success", message: "插件配置已导出。" });
            } else if (result && result.error && result.error !== "cancelled") {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `导出插件配置失败：${formatErrorMessage(result.error)}` });
            }
        } catch (error) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `导出插件配置失败：${formatErrorMessage(error)}` });
        } finally {
            btnExportPlugins.disabled = false;
        }
    }

    async function handleImportPlugins() {
        const importMethod = typeof api.importHookPluginsConfig === "function"
            ? "importHookPluginsConfig"
            : "importHookPlugins";
        if (!ensureApiMethod(importMethod)) {
            return;
        }

        btnImportPlugins.disabled = true;
        try {
            const result = await api[importMethod]();
            if (result && result.success) {
                addLog({ timestamp: getCurrentTime(), level: "success", message: "插件配置已导入。" });
                await loadUserPlugins();
            } else if (result && result.error && result.error !== "cancelled") {
                addLog({ timestamp: getCurrentTime(), level: "error", message: `导入插件配置失败：${formatErrorMessage(result.error)}` });
            }
        } catch (error) {
            addLog({ timestamp: getCurrentTime(), level: "error", message: `导入插件配置失败：${formatErrorMessage(error)}` });
        } finally {
            btnImportPlugins.disabled = false;
        }
    }

    function ensureApiMethod(methodName) {
        if (typeof api[methodName] === "function") {
            return true;
        }

        addLog({
            timestamp: getCurrentTime(),
            level: "warn",
            message: `当前版本尚未注入 debuggerAPI.${methodName}()，按钮已按预留接口接线。`,
        });
        return false;
    }

    function focusPendingPluginEditor() {
        if (!pendingFocusPluginId) {
            return;
        }

        const pluginId = pendingFocusPluginId;
        pendingFocusPluginId = null;
        setTimeout(() => {
            const item = Array.from(pluginList.querySelectorAll(".plugin-item")).find((element) => {
                return element.dataset.pluginId === pluginId;
            });
            const editor = item ? item.querySelector(".plugin-textarea:not([readonly])") : null;
            if (editor) {
                editor.focus();
                editor.setSelectionRange(editor.value.length, editor.value.length);
            }
        }, 0);
    }

    return {
        loadPlugins,
    };
}
