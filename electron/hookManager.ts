import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BuiltinHookTemplate, getBuiltinHookTemplateById, getBuiltinHookTemplates } from "./builtinHookTemplates";
import { buildHookPluginConsolePrefix } from "./hookPluginConsole";

export interface HookPlugin {
    id: string;
    name: string;
    script: string;
    enabled: boolean;
    source: "inline" | "file";
    filePath?: string;
    createdAt: number;
}

export interface HookPluginsConfig {
    version?: number;
    exportedAt?: string;
    plugins: HookPlugin[];
}

export interface HookManagerOptions {
    configDir: string;
    legacyConfigPath?: string;
    maxScriptBytes?: number;
}

export class HookManager {
    private static readonly MAX_PLUGIN_NAME_LENGTH = 120;
    private static readonly DEFAULT_MAX_SCRIPT_BYTES = 1_000_000;
    private static readonly CONFIG_VERSION = 1;

    private plugins: HookPlugin[] = [];
    private configPath: string;
    private configDir: string;
    private legacyConfigPath?: string;
    private maxScriptBytes: number;

    constructor(options: HookManagerOptions) {
        this.configDir = options.configDir;
        this.configPath = path.join(this.configDir, "hook-scripts.json");
        this.legacyConfigPath = options.legacyConfigPath;
        this.maxScriptBytes = options.maxScriptBytes ?? HookManager.DEFAULT_MAX_SCRIPT_BYTES;
    }

    async exportConfig(filePath: string): Promise<{ filePath: string; pluginCount: number }> {
        const normalizedPath = this.normalizeConfigFilePath(filePath);
        const config = this.serializeConfig(true);
        await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
        await fs.writeFile(normalizedPath, JSON.stringify(config, null, 2), "utf-8");
        return {
            filePath: normalizedPath,
            pluginCount: config.plugins.length,
        };
    }

    async importConfig(filePath: string): Promise<HookPlugin[]> {
        const normalizedPath = this.normalizeConfigFilePath(filePath);
        const content = await this.readConfigFile(normalizedPath);
        this.plugins = this.parseConfigContent(content, normalizedPath);
        await this.save();
        return this.getPlugins();
    }

    getBuiltinTemplates(): BuiltinHookTemplate[] {
        return getBuiltinHookTemplates();
    }

    async createPluginFromTemplate(templateId: string): Promise<HookPlugin> {
        const template = getBuiltinHookTemplateById(templateId);
        if (!template) {
            throw new Error(`未找到内置模板：${templateId}`);
        }

        const uniqueName = this.createUniquePluginName(template.name);
        return this.addPlugin(uniqueName, template.script, "inline");
    }

    /**
     * 从磁盘加载已保存的插件配置。
     * 兼容旧的单脚本配置格式。
     */
    async load(): Promise<void> {
        if (await this.loadFromFile(this.configPath)) {
            return;
        }

        if (this.legacyConfigPath && this.legacyConfigPath !== this.configPath) {
            if (await this.loadFromFile(this.legacyConfigPath)) {
                await this.save();
                return;
            }
        }

        this.plugins = [];
    }

    private async loadFromFile(filePath: string): Promise<boolean> {
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = JSON.parse(content);

            // 迁移：识别旧的单脚本格式 { script, enabled }
            if (parsed.script !== undefined && parsed.plugins === undefined) {
                const oldScript = parsed.script || "";
                const oldEnabled = parsed.enabled || false;
                if (oldScript.trim().length > 0) {
                    this.plugins = [{
                        id: this.generateId(),
                        name: this.normalizeName("迁移脚本"),
                        script: this.normalizeScript(oldScript),
                        enabled: oldEnabled,
                        source: "inline",
                        createdAt: Date.now(),
                    }];
                } else {
                    this.plugins = [];
                }
            } else {
                const config: HookPluginsConfig = parsed;
                this.plugins = this.normalizePlugins(config.plugins || []);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 将当前插件配置持久化到磁盘。
     */
    async save(): Promise<void> {
        try {
            await fs.mkdir(this.configDir, { recursive: true });
            const config = this.serializeConfig();
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), "utf-8");
        } catch (e) {
            throw new Error(`保存 Hook 配置失败：${e}`);
        }
    }

    /**
     * 新增插件并持久化到磁盘。
     */
    async addPlugin(name: string, script: string, source: "inline" | "file", filePath?: string): Promise<HookPlugin> {
        const plugin: HookPlugin = {
            id: this.generateId(),
            name: this.normalizeName(name),
            script: this.normalizeScript(script),
            enabled: false,
            source,
            filePath,
            createdAt: Date.now(),
        };
        this.plugins.push(plugin);
        await this.save();
        return plugin;
    }

    /**
     * 按 ID 删除插件并持久化到磁盘。
     */
    async removePlugin(id: string): Promise<boolean> {
        const index = this.plugins.findIndex((p) => p.id === id);
        if (index === -1) {
            return false;
        }
        this.plugins.splice(index, 1);
        await this.save();
        return true;
    }

    /**
     * 更新插件属性（名称、脚本）并持久化到磁盘。
     */
    async updatePlugin(id: string, updates: { name?: string; script?: string }): Promise<HookPlugin | null> {
        const plugin = this.plugins.find((p) => p.id === id);
        if (!plugin) {
            return null;
        }
        if (updates.name !== undefined) {
            plugin.name = this.normalizeName(updates.name);
        }
        if (updates.script !== undefined) {
            plugin.script = this.normalizeScript(updates.script);
        }
        await this.save();
        return plugin;
    }

    /**
     * 切换单个插件的启用状态并持久化到磁盘。
     */
    async togglePlugin(id: string, enabled: boolean): Promise<HookPlugin | null> {
        const plugin = this.plugins.find((p) => p.id === id);
        if (!plugin) {
            return null;
        }
        // 脚本为空时不能启用插件
        if (enabled && (!plugin.script || plugin.script.trim().length === 0)) {
            plugin.enabled = false;
        } else {
            plugin.enabled = enabled;
        }
        await this.save();
        return plugin;
    }

    /**
     * 获取全部插件。
     */
    getPlugins(): HookPlugin[] {
        return [...this.plugins];
    }

    /**
     * 按 ID 获取单个插件。
     */
    getPlugin(id: string): HookPlugin | null {
        return this.plugins.find((p) => p.id === id) || null;
    }

    /**
     * 获取所有已启用插件的组合脚本。
     * 每个插件脚本会用 try-catch 包裹，并带上安全注释头。
     */
    getEnabledScripts(): string {
        const enabledPlugins = this.plugins.filter(
            (p) => p.enabled && p.script && p.script.trim().length > 0
        );
        if (enabledPlugins.length === 0) {
            return "";
        }
        return enabledPlugins
            .map((p) => {
                const safeName = this.sanitizeForComment(p.name);
                const logLabel = JSON.stringify(buildHookPluginConsolePrefix(safeName));
                return `// === Hook 插件：${safeName}（${p.id}） ===\ntry {\n${this.wrapPluginScriptWithConsoleBridge(p.script, safeName)}\n} catch(__hookErr__) { console.error(${logLabel}, __hookErr__); }`;
            })
            .join("\n\n");
    }

    /**
     * 检查是否存在脚本非空的已启用插件。
     */
    hasEnabledPlugins(): boolean {
        return this.plugins.some(
            (p) => p.enabled && p.script && p.script.trim().length > 0
        );
    }

    /**
     * 基于已启用插件内容生成唯一标识（hash）。
     * 用于检测变更并避免重复注入。
     */
    getIdentifier(): string {
        const combined = this.getEnabledScripts();
        if (!combined || combined.trim().length === 0) {
            return "";
        }
        return crypto.createHash("md5").update(combined).digest("hex");
    }

    /**
     * 将 JS 文件导入为新插件。
     * 读取文件内容，并使用不带扩展名的文件名作为插件名称。
     */
    async importFromFile(filePath: string): Promise<HookPlugin> {
        if (path.extname(filePath).toLowerCase() !== ".js") {
            throw new Error("只能导入 .js Hook 文件");
        }

        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
            throw new Error(`不是文件：${filePath}`);
        }
        if (stat.size > this.maxScriptBytes) {
            throw new Error(`Hook 文件过大：${stat.size} 字节，最大 ${this.maxScriptBytes} 字节`);
        }

        let content: string;
        try {
            content = await fs.readFile(filePath, "utf-8");
        } catch (e) {
            throw new Error(`读取文件失败：${filePath} - ${e}`);
        }

        const fileName = path.basename(filePath, path.extname(filePath));
        return this.addPlugin(fileName, content, "file", filePath);
    }

    private serializeConfig(includeMetadata = false): HookPluginsConfig {
        const config: HookPluginsConfig = {
            plugins: [...this.plugins],
        };

        if (includeMetadata) {
            config.version = HookManager.CONFIG_VERSION;
            config.exportedAt = new Date().toISOString();
        }

        return config;
    }

    private async readConfigFile(filePath: string): Promise<string> {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
            throw new Error(`Not a file: ${filePath}`);
        }
        return fs.readFile(filePath, "utf-8");
    }

    private parseConfigContent(content: string, sourceLabel: string): HookPlugin[] {
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid Hook plugin config JSON: ${sourceLabel} (${reason})`);
        }

        return this.parseConfigObject(parsed);
    }

    private parseConfigObject(parsed: unknown): HookPlugin[] {
        if (Array.isArray(parsed)) {
            return this.normalizePlugins(parsed as HookPlugin[]);
        }

        if (!parsed || typeof parsed !== "object") {
            throw new Error("Hook plugin config must be an object or plugin array");
        }

        const legacy = parsed as { script?: unknown; enabled?: unknown; plugins?: unknown };
        if (legacy.script !== undefined && legacy.plugins === undefined) {
            const oldScript = typeof legacy.script === "string" ? legacy.script : "";
            const oldEnabled = legacy.enabled === true;
            if (oldScript.trim().length === 0) {
                return [];
            }

            return [{
                id: this.generateId(),
                name: this.normalizeName("Migrated Hook"),
                script: this.normalizeScript(oldScript),
                enabled: oldEnabled,
                source: "inline",
                createdAt: Date.now(),
            }];
        }

        const config = parsed as HookPluginsConfig;
        if (!Array.isArray(config.plugins)) {
            throw new Error("Hook plugin config is missing plugins array");
        }

        return this.normalizePlugins(config.plugins);
    }

    private normalizeConfigFilePath(filePath: string): string {
        if (!filePath || typeof filePath !== "string") {
            throw new Error("Hook plugin config path is required");
        }

        const normalizedPath = path.resolve(filePath);
        if (path.extname(normalizedPath).toLowerCase() !== ".json") {
            throw new Error("Hook plugin config file must be a .json file");
        }

        return normalizedPath;
    }

    private createUniquePluginName(baseName: string): string {
        const normalizedBaseName = this.normalizeName(baseName);
        const existingNames = new Set(this.plugins.map((plugin) => plugin.name));
        if (!existingNames.has(normalizedBaseName)) {
            return normalizedBaseName;
        }

        let index = 2;
        let candidate = `${normalizedBaseName} ${index}`;
        while (existingNames.has(candidate)) {
            index += 1;
            candidate = `${normalizedBaseName} ${index}`;
        }
        return candidate;
    }

    private normalizePlugins(plugins: HookPlugin[]): HookPlugin[] {
        if (!Array.isArray(plugins)) {
            return [];
        }

        return plugins
            .filter((plugin) => plugin && typeof plugin === "object")
            .map((plugin) => ({
                id: typeof plugin.id === "string" && plugin.id ? plugin.id : this.generateId(),
                name: this.normalizeName(plugin.name || "未命名 Hook"),
                script: this.normalizeScript(plugin.script || ""),
                enabled: Boolean(plugin.enabled),
                source: (plugin.source === "file" ? "file" : "inline") as "inline" | "file",
                filePath: typeof plugin.filePath === "string" ? plugin.filePath : undefined,
                createdAt: typeof plugin.createdAt === "number" ? plugin.createdAt : Date.now(),
            }))
            .map((plugin) => ({
                ...plugin,
                enabled: plugin.enabled && plugin.script.trim().length > 0,
            }));
    }

    private normalizeName(name: string): string {
        const normalized = String(name)
            .replace(/[\r\n\t]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, HookManager.MAX_PLUGIN_NAME_LENGTH);
        return normalized || "未命名 Hook";
    }

    private normalizeScript(script: string): string {
        const normalized = String(script);
        if (Buffer.byteLength(normalized, "utf-8") > this.maxScriptBytes) {
            throw new Error(`Hook 脚本过大，最大 ${this.maxScriptBytes} 字节`);
        }
        return normalized;
    }

    private sanitizeForComment(value: string): string {
        return this.normalizeName(value).replace(/\*\//g, "* /");
    }

    private wrapPluginScriptWithConsoleBridge(script: string, pluginName: string): string {
        const safeName = this.sanitizeForComment(pluginName);
        const consolePrefix = JSON.stringify(buildHookPluginConsolePrefix(safeName));
        return `(() => {\nconst __hookPluginPrefix = ${consolePrefix};\nconst __hookPluginConsole = console;\nconst __hookPluginWrapConsole = (method) => (...args) => __hookPluginConsole[method](__hookPluginPrefix, ...args);\nconst console = {\n    ...__hookPluginConsole,\n    log: __hookPluginWrapConsole("log"),\n    info: __hookPluginWrapConsole("info"),\n    warn: __hookPluginWrapConsole("warn"),\n    error: __hookPluginWrapConsole("error"),\n    debug: __hookPluginWrapConsole("debug"),\n};\n${script}\n})();`;
    }

    private generateId(): string {
        return crypto.randomUUID();
    }
}
