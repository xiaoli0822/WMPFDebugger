import { promises } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { BuiltinHookTemplate } from "./builtinHookTemplates";
import { HookManager, HookPlugin } from "./hookManager";

const codex = require("../src/third-party/RemoteDebugCodex.js");
const messageProto = require("../src/third-party/WARemoteDebugProtobuf.js");

// frida 是 ESM 模块，需要通过 dynamic import() 加载。
// 使用 Function 构造器可避免 TypeScript/CommonJS 在编译时将
// dynamic import() 转换成 require()。
let fridaModule: typeof import("frida") | null = null;
async function getFrida(): Promise<typeof import("frida")> {
    if (!fridaModule) {
        fridaModule = await (new Function('return import("frida")'))() as typeof import("frida");
    }
    return fridaModule;
}

export interface ProcessInfo {
    pid: number;
    name: string;
    path: string;
    version: number;
    isParent: boolean;
}

export interface ProcessScanResult {
    processes: ProcessInfo[];
    error?: string;
}

export interface DebugServiceConfig {
    debugPort: number;
    cdpPort: number;
    verbose: boolean;
}

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
}

export class DebugService extends EventEmitter {
    private debugWss: WebSocketServer | null = null;
    private proxyWss: WebSocketServer | null = null;
    private fridaSession: any | null = null;
    private fridaScript: any | null = null;
    private debugMessageEmitter: EventEmitter = new EventEmitter();
    private messageCounter: number = 0;
    private running: boolean = false;
    private config: DebugServiceConfig = {
        debugPort: 9421,
        cdpPort: 62000,
        verbose: false,
    };

    // Hook 注入状态
    private hookManager: HookManager;
    private hookIdCounter: number = 900000;
    private injectedClients: Set<WebSocket> = new Set();
    private injectedScriptIdentifiers: Map<WebSocket, string> = new Map();
    private pendingCdpResponses: Map<number, { resolve: (data: any) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private backendConnected: boolean = false;
    private injectionFailureCounts: Map<WebSocket, number> = new Map();
    private hookManagerLoadPromise: Promise<void>;
    private operationPromise: Promise<void> = Promise.resolve();
    private starting: boolean = false;
    private stopping: boolean = false;

    constructor(configDir: string, legacyConfigPath?: string) {
        super();
        this.hookManager = new HookManager({
            configDir,
            legacyConfigPath,
        });
        this.hookManagerLoadPromise = this.hookManager.load().catch((e) => {
            this.log("error", `[hook] 加载 Hook 插件失败：${e instanceof Error ? e.message : String(e)}`);
        });
    }

    // ===== Hook 插件公开 API =====

    async addHookPlugin(name: string, script: string, source: "inline" | "file", filePath?: string): Promise<HookPlugin> {
        await this.ensureHookManagerLoaded();
        const plugin = await this.hookManager.addPlugin(name, script, source, filePath);
        this.resetHookInjectionState("插件列表已变更");
        this.retryHookInjectionForOpenClients();
        this.log("info", `[hook] 已添加插件：“${plugin.name}”（${plugin.source === "file" ? "文件" : "内联"}）`);
        return plugin;
    }

    async removeHookPlugin(id: string): Promise<boolean> {
        await this.ensureHookManagerLoaded();
        const plugin = this.hookManager.getPlugin(id);
        const removed = await this.hookManager.removePlugin(id);
        if (removed && plugin) {
            this.resetHookInjectionState("插件列表已变更");
            this.retryHookInjectionForOpenClients();
            this.log("info", `[hook] 已删除插件：“${plugin.name}”`);
        }
        return removed;
    }

    async updateHookPlugin(id: string, updates: { name?: string; script?: string }): Promise<HookPlugin | null> {
        await this.ensureHookManagerLoaded();
        const plugin = await this.hookManager.updatePlugin(id, updates);
        if (plugin) {
            this.resetHookInjectionState("插件内容已变更");
            this.retryHookInjectionForOpenClients();
            this.log("info", `[hook] 已更新插件：“${plugin.name}”`);
        }
        return plugin;
    }

    async toggleHookPlugin(id: string, enabled: boolean): Promise<HookPlugin | null> {
        await this.ensureHookManagerLoaded();
        const plugin = await this.hookManager.togglePlugin(id, enabled);
        if (plugin) {
            this.resetHookInjectionState("插件启用状态已变更");
            this.retryHookInjectionForOpenClients();
            this.log("info", `[hook] 插件“${plugin.name}”已${enabled ? "启用" : "禁用"}`);
        }
        return plugin;
    }

    async getHookPlugins(): Promise<HookPlugin[]> {
        await this.ensureHookManagerLoaded();
        return this.hookManager.getPlugins();
    }

    async getBuiltinHookTemplates(): Promise<BuiltinHookTemplate[]> {
        await this.ensureHookManagerLoaded();
        return this.hookManager.getBuiltinTemplates();
    }

    async createHookPluginFromTemplate(templateId: string): Promise<HookPlugin> {
        await this.ensureHookManagerLoaded();
        const plugin = await this.hookManager.createPluginFromTemplate(templateId);
        this.log("success", `[hook] 已从内置模板创建插件：“${plugin.name}”`);
        return plugin;
    }

    async exportHookPluginsConfig(filePath: string): Promise<{ filePath: string; pluginCount: number }> {
        await this.ensureHookManagerLoaded();
        const result = await this.hookManager.exportConfig(filePath);
        this.log("success", `[hook] Exported ${result.pluginCount} plugin(s) to ${result.filePath}`);
        return result;
    }

    async importHookPluginsConfig(filePath: string): Promise<HookPlugin[]> {
        await this.ensureHookManagerLoaded();
        const plugins = await this.hookManager.importConfig(filePath);
        this.resetHookInjectionState("hook plugin config imported");
        this.retryHookInjectionForOpenClients();
        this.log("success", `[hook] Imported ${plugins.length} plugin(s) from ${filePath}`);
        return plugins;
    }

    async importHookFile(filePath: string): Promise<HookPlugin> {
        await this.ensureHookManagerLoaded();
        const plugin = await this.hookManager.importFromFile(filePath);
        this.resetHookInjectionState("插件列表已变更");
        this.retryHookInjectionForOpenClients();
        this.log("success", `[hook] 已导入文件插件：“${plugin.name}”（${plugin.script.length} 个字符）`);
        return plugin;
    }

    private log(level: LogLevel, message: string): void {
        const entry: LogEntry = {
            timestamp: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            level,
            message,
        };
        this.emit("log", entry);
    }

    private getProjectRoot(): string {
        // Electron 中 __dirname 指向 dist-electron/，项目根目录在上一级。
        return path.join(__dirname, "..");
    }

    isRunning(): boolean {
        return this.running;
    }

    isBusy(): boolean {
        return this.starting || this.stopping;
    }

    async getProcesses(): Promise<ProcessScanResult> {
        try {
            const { wmpfProcesses, parentPid } = await this.enumerateWmpfProcesses();

            const result: ProcessInfo[] = [];
            for (const proc of wmpfProcesses) {
                const procPath = (proc.parameters.path as string) || "";
                const versionMatch = procPath.match(/\d+/g);
                const version = versionMatch ? Number(versionMatch[versionMatch.length - 1]) : 0;

                result.push({
                    pid: proc.pid,
                    name: proc.name,
                    path: procPath,
                    version,
                    isParent: proc.pid === parentPid,
                });
            }

            return { processes: result };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            this.log("error", `[frida] 枚举进程失败：${error}`);
            return { processes: [], error };
        }
    }

    async getAvailableVersions(): Promise<number[]> {
        const projectRoot = this.getProjectRoot();
        const configDir = path.join(projectRoot, "frida", "config");
        try {
            const files = await promises.readdir(configDir);
            const versions = files
                .filter((f) => f.startsWith("addresses.") && f.endsWith(".json"))
                .map((f) => {
                    const match = f.match(/addresses\.(\d+)\.json/);
                    return match ? Number(match[1]) : 0;
                })
                .filter((v) => v > 0)
                .sort((a, b) => b - a);
            return versions;
        } catch (e) {
            this.log("error", `[config] 读取配置目录失败：${e}`);
            return [];
        }
    }

    async start(config: Partial<DebugServiceConfig> = {}): Promise<void> {
        return this.runExclusive(async () => {
            await this.startInternal(config);
        });
    }

    private async startInternal(config: Partial<DebugServiceConfig> = {}): Promise<void> {
        if (this.running) {
            this.log("warn", "[service] 服务已在运行");
            return;
        }
        if (this.starting || this.stopping) {
            throw new Error("[service] 服务操作正在进行中");
        }

        const nextConfig = { ...this.config, ...config };
        this.validateConfig(nextConfig);

        this.starting = true;
        this.config = nextConfig;
        this.messageCounter = 0;

        try {
            await this.startDebugServer();
            await this.startProxyServer();
            await this.startFridaServer();
            this.running = true;
            this.emit("statusChange", true);
            this.log("success", "[service] 所有服务已启动");
        } catch (e) {
            this.log("error", `[service] 启动失败：${e}`);
            await this.stopInternal();
            throw e;
        } finally {
            this.starting = false;
        }
    }

    async stop(): Promise<void> {
        return this.runExclusive(async () => {
            await this.stopInternal();
        });
    }

    private async stopInternal(): Promise<void> {
        if (this.stopping) {
            return;
        }
        this.stopping = true;
        this.log("info", "[service] 正在停止所有服务...");

        try {
            // 停止 Frida
            if (this.fridaScript) {
                try {
                    await this.fridaScript.unload();
                } catch (e) {
                    // 脚本可能已经卸载。
                }
                this.fridaScript = null;
            }

            if (this.fridaSession) {
                try {
                    await this.fridaSession.detach();
                } catch (e) {
                    // 会话可能已经断开。
                }
                this.fridaSession = null;
            }

            // 停止 Debug Server
            if (this.debugWss) {
                await this.closeWebSocketServer(this.debugWss);
                this.debugWss = null;
            }

            // 停止 Proxy Server
            if (this.proxyWss) {
                await this.closeWebSocketServer(this.proxyWss);
                this.proxyWss = null;
            }

            // 移除内部事件监听
            this.debugMessageEmitter.removeAllListeners();

            // 清理 Hook 注入状态
            this.resetHookInjectionState("服务停止");
            this.backendConnected = false;
            this.clearPendingCdpResponses("服务停止");

            this.running = false;
            this.emit("statusChange", false);
            this.log("success", "[service] 所有服务已停止");
        } finally {
            this.stopping = false;
        }
    }

    private async runExclusive(operation: () => Promise<void>): Promise<void> {
        const previous = this.operationPromise;
        let release: () => void = () => undefined;
        this.operationPromise = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;
        try {
            await operation();
        } finally {
            release();
        }
    }

    private async ensureHookManagerLoaded(): Promise<void> {
        await this.hookManagerLoadPromise;
    }

    private validateConfig(config: DebugServiceConfig): void {
        const isValidPort = (port: number): boolean => Number.isInteger(port) && port >= 1024 && port <= 65535;
        if (!isValidPort(config.debugPort) || !isValidPort(config.cdpPort)) {
            throw new Error("[service] 端口必须是 1024 到 65535 之间的整数");
        }
        if (config.debugPort === config.cdpPort) {
            throw new Error("[service] 调试端口和 CDP 端口不能相同");
        }
    }

    private resetHookInjectionState(reason: string): void {
        const hadState = this.injectedClients.size > 0
            || this.injectedScriptIdentifiers.size > 0
            || this.injectionFailureCounts.size > 0;
        this.injectedClients.clear();
        this.injectedScriptIdentifiers.clear();
        this.injectionFailureCounts.clear();
        if (hadState) {
            this.log("info", `[hook] 已重置注入状态：${reason}`);
        }
    }

    private clearPendingCdpResponses(reason: string): void {
        if (this.pendingCdpResponses.size === 0) {
            return;
        }
        const pendingResponses = Array.from(this.pendingCdpResponses.values());
        this.pendingCdpResponses.clear();
        for (const pending of pendingResponses) {
            clearTimeout(pending.timer);
            pending.resolve(null);
        }
        this.log("warn", `[hook] 已取消等待中的 CDP 命令：${reason}`);
    }

    private hasConnectedBackendClients(exclude?: WebSocket): boolean {
        if (!this.debugWss) {
            return false;
        }
        for (const client of this.debugWss.clients) {
            if (client !== exclude && client.readyState === WebSocket.OPEN) {
                return true;
            }
        }
        return false;
    }

    private retryHookInjectionForOpenClients(): void {
        if (!this.proxyWss || !this.backendConnected) {
            return;
        }
        this.proxyWss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                this.retryHookInjection(client);
            }
        });
    }

    private waitForServerListening(server: WebSocketServer, label: string, port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                server.off("listening", onListening);
                server.off("error", onError);
            };
            const onListening = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(new Error(`[server] ${label} 监听端口 ${port} 失败：${error.message}`));
            };

            server.once("listening", onListening);
            server.once("error", onError);
        });
    }

    private async closeWebSocketServer(server: WebSocketServer): Promise<void> {
        server.clients.forEach((client) => {
            try {
                client.close();
            } catch (e) {
                // 忽略关闭错误。
            }
        });

        await new Promise<void>((resolve) => {
            try {
                server.close(() => resolve());
            } catch {
                resolve();
            }
        });
    }

    private async startDebugServer(): Promise<void> {
        const port = this.config.debugPort;
        const server = new WebSocketServer({ port });
        const listening = this.waitForServerListening(server, "调试服务器", port);
        this.debugWss = server;

        const onMessage = (message: ArrayBuffer) => {
            if (this.config.verbose) {
                const hex = Array.from(new Uint8Array(message))
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("");
                this.log("info", `[client] 收到原始消息（hex）：${hex}`);
            }

            let unwrappedData: any = null;
            try {
                const decodedData = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.decode(message);
                unwrappedData = codex.unwrapDebugMessageData(decodedData);
                if (this.config.verbose) {
                    this.log("info", `[client] [DEBUG] 解码数据：${JSON.stringify(unwrappedData)}`);
                }
            } catch (e) {
                this.log("error", `[client] 错误：${e}`);
            }

            if (unwrappedData === null) {
                return;
            }

            if (unwrappedData.category === "chromeDevtoolsResult") {
                this.debugMessageEmitter.emit("cdpmessage", unwrappedData.data.payload);
            }
        };

        server.on("connection", (ws: WebSocket) => {
            this.log("success", "[conn] 小程序客户端已连接");
            if (!this.backendConnected) {
                this.log("info", "[hook] 后端已连接，将为现有 DevTools 客户端重试注入");
            }
            this.backendConnected = true;
            this.resetHookInjectionState("小程序后端已连接");
            ws.on("message", onMessage);
            ws.on("error", (err) => {
                this.log("error", `[client] 错误：${err}`);
            });
            ws.on("close", () => {
                this.log("warn", "[client] 客户端已断开");
                this.backendConnected = this.hasConnectedBackendClients(ws);
                if (!this.backendConnected) {
                    this.resetHookInjectionState("小程序后端已断开");
                    this.clearPendingCdpResponses("小程序后端已断开");
                    this.log("warn", "[hook] 后端已断开。DevTools 将在重连后重试注入");
                }
            });

            // 如果已有 CDP 客户端连接，后端就绪后立即尝试注入。
            this.retryHookInjectionForOpenClients();
        });

        this.debugMessageEmitter.on("proxymessage", (message: string) => {
            if (!this.debugWss || this.debugWss !== server) return;
            server.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    const rawPayload = {
                        jscontext_id: "",
                        op_id: Math.round(100 * Math.random()),
                        payload: message.toString(),
                    };
                    if (this.config.verbose) {
                        this.log("info", `[proxy] 原始 payload：${JSON.stringify(rawPayload)}`);
                    }
                    const wrappedData = codex.wrapDebugMessageData(rawPayload, "chromeDevtools", 0);
                    const outData = {
                        seq: ++this.messageCounter,
                        category: "chromeDevtools",
                        data: wrappedData.buffer,
                        compressAlgo: 0,
                        originalSize: wrappedData.originalSize,
                    };
                    const encodedData =
                        messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.encode(outData).finish();
                    client.send(encodedData, { binary: true });
                }
            });
        });

        await listening;
        server.on("error", (error) => {
            this.log("error", `[server] 调试服务器错误：${error instanceof Error ? error.message : String(error)}`);
        });
        this.log("info", `[server] 调试服务器运行于 ws://localhost:${port}`);
    }

    private async startProxyServer(): Promise<void> {
        const port = this.config.cdpPort;
        const server = new WebSocketServer({ port });
        const listening = this.waitForServerListening(server, "代理服务器", port);
        this.proxyWss = server;

        const onMessage = (message: string) => {
            this.debugMessageEmitter.emit("proxymessage", message);
        };

        server.on("connection", (ws: WebSocket) => {
            this.log("success", "[conn] CDP 客户端已连接");
            ws.on("message", onMessage);
            ws.on("error", (err) => {
                this.log("error", `[client] CDP 错误：${err}`);
            });
            ws.on("close", () => {
                this.log("warn", "[client] CDP 客户端已断开");
                // 清理该客户端的注入跟踪状态。
                this.injectedClients.delete(ws);
                this.injectedScriptIdentifiers.delete(ws);
                this.injectionFailureCounts.delete(ws);
            });

            // 为新的 CDP 客户端尝试注入 Hook 脚本。
            this.retryHookInjection(ws);
        });

        this.debugMessageEmitter.on("cdpmessage", (message: string) => {
            // 检查这是否是内部 CDP 请求的响应。
            try {
                const parsed = JSON.parse(message);
                if (parsed.id && this.pendingCdpResponses.has(parsed.id)) {
                    const pending = this.pendingCdpResponses.get(parsed.id)!;
                    clearTimeout(pending.timer);
                    this.pendingCdpResponses.delete(parsed.id);
                    pending.resolve(parsed);
                    return; // 内部响应不转发给 CDP 客户端。
                }
            } catch (e) {
                // 非 JSON 或解析失败时按原样转发。
            }

            if (!this.proxyWss || this.proxyWss !== server) return;
            server.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
        });

        await listening;
        server.on("error", (error) => {
            this.log("error", `[server] 代理服务器错误：${error instanceof Error ? error.message : String(error)}`);
        });
        this.log("info", `[server] 代理服务器运行于 ws://localhost:${port}`);
    }

    /**
     * 通过 debug message emitter 发送 CDP 命令并等待响应。
     * 使用高位 ID（900000+）避免与 DevTools 请求冲突。
     * 超时时返回 null，否则返回已解析的 CDP 响应。
     */
    private sendCdpCommand(method: string, params?: Record<string, any>): Promise<any | null> {
        const id = ++this.hookIdCounter;
        const command: Record<string, any> = { id, method };
        if (params) {
            command.params = params;
        }

        return new Promise<any | null>((resolve) => {
            const timer = setTimeout(() => {
                this.pendingCdpResponses.delete(id);
                this.log("warn", `[hook] CDP 命令超时：${method}（id: ${id}）`);
                resolve(null);
            }, 5000);

            this.pendingCdpResponses.set(id, { resolve, timer });
            this.debugMessageEmitter.emit("proxymessage", JSON.stringify(command));
        });
    }

    private createGuardedHookScript(source: string, identifier: string): string {
        const stateKey = "__WMPF_DEBUGGER_HOOKS__";
        return `(() => {
const __wmpfDebuggerKey = ${JSON.stringify(stateKey)};
const __wmpfDebuggerId = ${JSON.stringify(identifier)};
const __wmpfDebuggerGlobal = globalThis;
const __wmpfDebuggerState = __wmpfDebuggerGlobal[__wmpfDebuggerKey] || {};
if (!__wmpfDebuggerGlobal[__wmpfDebuggerKey]) {
    Object.defineProperty(__wmpfDebuggerGlobal, __wmpfDebuggerKey, {
        value: __wmpfDebuggerState,
        configurable: true,
    });
}
if (__wmpfDebuggerState[__wmpfDebuggerId]) {
    console.info("[WMPFDebugger] 已跳过重复 Hook:", __wmpfDebuggerId);
    return;
}
__wmpfDebuggerState[__wmpfDebuggerId] = true;
${source}
})();
//# sourceURL=wmpf-debugger-hook-${identifier}.js`;
    }

    private async evaluateHookInCurrentContext(source: string, enabledCount: number): Promise<void> {
        const evaluateResult = await this.sendCdpCommand("Runtime.evaluate", {
            expression: source,
            awaitPromise: false,
            returnByValue: true,
        });

        if (evaluateResult === null) {
            this.log("warn", "[hook] 当前页面即时执行超时；新文档仍会自动注入");
            return;
        }

        if (evaluateResult.error) {
            this.log("warn", `[hook] 当前页面即时执行失败：${JSON.stringify(evaluateResult.error)}`);
            return;
        }

        if (evaluateResult.exceptionDetails) {
            const details = evaluateResult.exceptionDetails;
            const message = details.exception?.description || details.text || JSON.stringify(details);
            this.log("warn", `[hook] 当前页面即时执行出现异常：${message}`);
            return;
        }

        this.log("success", `[hook] 已在当前页面即时执行 ${enabledCount} 个插件`);
    }

    /**
     * 为新连接的 CDP 客户端执行 Hook 脚本注入。
     * 将所有已启用插件组合成单个脚本，并通过 CDP 注入。
     */
    private async performHookInjection(ws: WebSocket): Promise<"success" | "skipped" | "failed"> {
        // 需要小程序后端已连接，否则 CDP 命令会超时。
        if (!this.debugWss || this.debugWss.clients.size === 0 || !this.backendConnected) {
            this.log("warn", "[hook] 小程序后端未连接，暂时跳过注入");
            return "skipped";
        }

        await this.ensureHookManagerLoaded();

        // 检查是否存在已启用插件。
        if (!this.hookManager.hasEnabledPlugins()) {
            return "skipped";
        }

        const combinedScript = this.hookManager.getEnabledScripts();
        if (!combinedScript || combinedScript.trim().length === 0) {
            return "skipped";
        }

        // 检查重复注入（同一客户端、同一组合脚本）。
        const currentIdentifier = this.hookManager.getIdentifier();
        const guardedScript = this.createGuardedHookScript(combinedScript, currentIdentifier);
        if (this.injectedClients.has(ws)) {
            const previousIdentifier = this.injectedScriptIdentifiers.get(ws);
            if (previousIdentifier === currentIdentifier) {
                this.log("info", "[hook] 该客户端已注入当前插件组合，跳过");
                return "skipped";
            }
        }

        const enabledCount = this.hookManager.getPlugins().filter((p) => p.enabled && p.script && p.script.trim().length > 0).length;
        this.log("info", `[hook] 正在注入 ${enabledCount} 个已启用插件...`);

        try {
            // 步骤 1：启用 Page domain。
            const enableResult = await this.sendCdpCommand("Page.enable");
            if (enableResult === null) {
                this.log("error", "[hook] 启用 Page 域失败（超时）");
                return "failed";
            }

            if (enableResult.error) {
                this.log("error", `[hook] Page.enable 失败：${JSON.stringify(enableResult.error)}`);
                return "failed";
            }

            this.log("info", "[hook] Page 域已启用");

            // 继续前确认客户端仍然连接。
            if (ws.readyState !== WebSocket.OPEN) {
                this.log("warn", "[hook] 注入完成前 CDP 客户端已断开");
                return "failed";
            }

            // 步骤 2：添加组合脚本，让新文档加载时执行。
            const addScriptResult = await this.sendCdpCommand("Page.addScriptToEvaluateOnNewDocument", {
                source: guardedScript,
            });

            if (addScriptResult === null) {
                this.log("error", "[hook] 添加脚本失败（超时）");
                return "failed";
            }

            if (addScriptResult.error) {
                this.log("error", `[hook] addScriptToEvaluateOnNewDocument 失败：${JSON.stringify(addScriptResult.error)}`);
                return "failed";
            }

            await this.evaluateHookInCurrentContext(guardedScript, enabledCount);

            // 记录成功注入状态。
            this.injectedClients.add(ws);
            this.injectedScriptIdentifiers.set(ws, currentIdentifier);

            const identifier = addScriptResult.result?.identifier || "未知";
            this.log("success", `[hook] 已注册 ${enabledCount} 个插件用于新文档注入（标识：${identifier}，${guardedScript.length} 个字符）`);
            this.injectionFailureCounts.delete(ws);
            return "success";
        } catch (e) {
            this.log("error", `[hook] 注入错误：${e}`);
            return "failed";
        }
    }

    private async retryHookInjection(ws: WebSocket): Promise<void> {
        const maxAttempts = 3;
        const delayMs = 600;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const result = await this.performHookInjection(ws);
            if (result === "success" || result === "skipped") {
                return;
            }

            const failures = (this.injectionFailureCounts.get(ws) || 0) + 1;
            this.injectionFailureCounts.set(ws, failures);

            if (failures >= maxAttempts) {
                this.log("error", "[hook] 多次注入失败。请在后端稳定后重新打开 DevTools。");
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    private async startFridaServer(): Promise<void> {
        const frida = await getFrida();
        const localDevice = await frida.getLocalDevice();
        const { processes, parentPid } = await this.enumerateWmpfProcesses();
        const wmpfPid = parentPid;

        if (wmpfPid === undefined) {
            throw new Error("[frida] 未找到 WeChatAppEx.exe 进程");
        }

        const wmpfProcess = processes.filter((p) => p.pid === wmpfPid)[0];
        const wmpfProcessPath = (wmpfProcess.parameters.path as string) || "";
        const wmpfVersionMatch = wmpfProcessPath.match(/\d+/g);
        const wmpfVersion = wmpfVersionMatch ? Number(wmpfVersionMatch[wmpfVersionMatch.length - 1]) : 0;

        if (wmpfVersion === 0) {
            throw new Error("[frida] 无法识别 WMPF 版本");
        }

        this.log("info", `[frida] 已找到 WMPF 进程，版本：${wmpfVersion}，pid：${wmpfPid}`);

        // 附加到进程。
        this.fridaSession = await localDevice.attach(Number(wmpfPid));

        // 查找 Hook 脚本。
        const projectRoot = this.getProjectRoot();
        let scriptContent: string | null = null;
        try {
            scriptContent = (await promises.readFile(path.join(projectRoot, "frida/hook.js"))).toString();
        } catch (e) {
            throw new Error("[frida] 未找到 Hook 脚本");
        }

        let configContent: string | null = null;
        try {
            configContent = (
                await promises.readFile(path.join(projectRoot, "frida/config", `addresses.${wmpfVersion}.json`))
            ).toString();
            configContent = JSON.stringify(JSON.parse(configContent));
        } catch (e) {
            throw new Error(`[frida] 未找到版本配置：${wmpfVersion}`);
        }

        if (scriptContent === null || configContent === null) {
            throw new Error("[frida] 无法找到 Hook 脚本或配置");
        }

        // 加载脚本。
        this.fridaScript = await this.fridaSession.createScript(scriptContent.replace("@@CONFIG@@", configContent));
        this.fridaScript.message.connect((message: any) => {
            if (message.type === "send") {
                this.log("info", `[frida] ${message.payload}`);
            } else if (message.type === "error") {
                this.log("error", `[frida] ${message.description}`);
            } else {
                this.log("info", `[frida] ${JSON.stringify(message)}`);
            }
        });
        await this.fridaScript.load();
        this.log("success", `[frida] 脚本已加载，WMPF 版本：${wmpfVersion}，pid：${wmpfPid}`);
    }

    private async enumerateWmpfProcesses(): Promise<{ processes: any[]; wmpfProcesses: any[]; parentPid?: number }> {
        const frida = await getFrida();
        const localDevice = await frida.getLocalDevice();
        const processes = await localDevice.enumerateProcesses({ scope: frida.Scope.Metadata });
        const wmpfProcesses = processes.filter((p) => p.name === "WeChatAppEx.exe");

        if (wmpfProcesses.length === 0) {
            return { processes, wmpfProcesses, parentPid: undefined };
        }

        const parentPidCounts = new Map<number, number>();
        for (const proc of wmpfProcesses) {
            const parentPid = proc.parameters.ppid ? Number(proc.parameters.ppid) : 0;
            if (!Number.isInteger(parentPid) || parentPid <= 0) {
                continue;
            }
            parentPidCounts.set(parentPid, (parentPidCounts.get(parentPid) || 0) + 1);
        }

        const parentPid = Array.from(parentPidCounts.entries())
            .sort((a, b) => a[1] - b[1])
            .pop()?.[0];

        return { processes, wmpfProcesses, parentPid };
    }
}
