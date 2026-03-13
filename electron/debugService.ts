import { promises } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { HookManager, HookPlugin } from "./hookManager";

const codex = require("../src/third-party/RemoteDebugCodex.js");
const messageProto = require("../src/third-party/WARemoteDebugProtobuf.js");

// frida is an ESM module, must be loaded via dynamic import()
// Use Function constructor to prevent TypeScript/CommonJS from converting
// dynamic import() into require() at compile time.
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

    // Hook injection state
    private hookManager: HookManager;
    private hookIdCounter: number = 900000;
    private injectedClients: Set<WebSocket> = new Set();
    private injectedScriptIdentifiers: Map<WebSocket, string> = new Map();
    private pendingCdpResponses: Map<number, { resolve: (data: any) => void; timer: ReturnType<typeof setTimeout> }> = new Map();

    constructor() {
        super();
        this.hookManager = new HookManager(path.join(__dirname, ".."));
        this.hookManager.load().catch((e) => {
            // Silently handle load errors on startup
        });
    }

    // ===== Hook Plugin Public API =====

    async addHookPlugin(name: string, script: string, source: "inline" | "file", filePath?: string): Promise<HookPlugin> {
        const plugin = await this.hookManager.addPlugin(name, script, source, filePath);
        this.log("info", `[hook] Plugin added: "${plugin.name}" (${plugin.source})`);
        return plugin;
    }

    async removeHookPlugin(id: string): Promise<boolean> {
        const plugin = this.hookManager.getPlugin(id);
        const removed = await this.hookManager.removePlugin(id);
        if (removed && plugin) {
            this.log("info", `[hook] Plugin removed: "${plugin.name}"`);
        }
        return removed;
    }

    async updateHookPlugin(id: string, updates: { name?: string; script?: string }): Promise<HookPlugin | null> {
        const plugin = await this.hookManager.updatePlugin(id, updates);
        if (plugin) {
            this.log("info", `[hook] Plugin updated: "${plugin.name}"`);
        }
        return plugin;
    }

    async toggleHookPlugin(id: string, enabled: boolean): Promise<HookPlugin | null> {
        const plugin = await this.hookManager.togglePlugin(id, enabled);
        if (plugin) {
            this.log("info", `[hook] Plugin "${plugin.name}" ${enabled ? "enabled" : "disabled"}`);
        }
        return plugin;
    }

    getHookPlugins(): HookPlugin[] {
        return this.hookManager.getPlugins();
    }

    async importHookFile(filePath: string): Promise<HookPlugin> {
        const plugin = await this.hookManager.importFromFile(filePath);
        this.log("success", `[hook] Imported file plugin: "${plugin.name}" (${plugin.script.length} chars)`);
        return plugin;
    }

    private log(level: LogLevel, message: string): void {
        const entry: LogEntry = {
            timestamp: new Date().toLocaleTimeString("en-US", { hour12: false }),
            level,
            message,
        };
        this.emit("log", entry);
    }

    private getProjectRoot(): string {
        // In Electron, __dirname points to dist-electron/
        // Project root is one level up
        return path.join(__dirname, "..");
    }

    isRunning(): boolean {
        return this.running;
    }

    async getProcesses(): Promise<ProcessInfo[]> {
        try {
            const frida = await getFrida();
            const localDevice = await frida.getLocalDevice();
            const processes = await localDevice.enumerateProcesses({ scope: frida.Scope.Metadata });
            const wmpfProcesses = processes.filter((p) => p.name === "WeChatAppEx.exe");

            if (wmpfProcesses.length === 0) {
                return [];
            }

            const wmpfPids = wmpfProcesses.map((p) => (p.parameters.ppid ? (p.parameters.ppid as number) : 0));
            const parentPid = wmpfPids
                .sort((a, b) => wmpfPids.filter((v) => v === a).length - wmpfPids.filter((v) => v === b).length)
                .pop();

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

            return result;
        } catch (e) {
            this.log("error", `[frida] Failed to enumerate processes: ${e}`);
            return [];
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
            this.log("error", `[config] Failed to read config directory: ${e}`);
            return [];
        }
    }

    async start(config: Partial<DebugServiceConfig> = {}): Promise<void> {
        if (this.running) {
            this.log("warn", "[service] Service is already running");
            return;
        }

        this.config = { ...this.config, ...config };
        this.messageCounter = 0;

        try {
            this.startDebugServer();
            this.startProxyServer();
            await this.startFridaServer();
            this.running = true;
            this.emit("statusChange", true);
            this.log("success", "[service] All services started successfully");
        } catch (e) {
            this.log("error", `[service] Failed to start: ${e}`);
            await this.stop();
            throw e;
        }
    }

    async stop(): Promise<void> {
        this.log("info", "[service] Stopping all services...");

        // Stop Frida
        if (this.fridaScript) {
            try {
                await this.fridaScript.unload();
            } catch (e) {
                // Script may already be unloaded
            }
            this.fridaScript = null;
        }

        if (this.fridaSession) {
            try {
                await this.fridaSession.detach();
            } catch (e) {
                // Session may already be detached
            }
            this.fridaSession = null;
        }

        // Stop Debug Server
        if (this.debugWss) {
            this.debugWss.clients.forEach((client) => {
                try {
                    client.close();
                } catch (e) {
                    // Ignore close errors
                }
            });
            await new Promise<void>((resolve) => {
                this.debugWss!.close(() => resolve());
            });
            this.debugWss = null;
        }

        // Stop Proxy Server
        if (this.proxyWss) {
            this.proxyWss.clients.forEach((client) => {
                try {
                    client.close();
                } catch (e) {
                    // Ignore close errors
                }
            });
            await new Promise<void>((resolve) => {
                this.proxyWss!.close(() => resolve());
            });
            this.proxyWss = null;
        }

        // Remove all listeners from internal emitter
        this.debugMessageEmitter.removeAllListeners();

        // Clean up hook injection state
        this.injectedClients.clear();
        this.injectedScriptIdentifiers.clear();
        for (const [id, pending] of this.pendingCdpResponses) {
            clearTimeout(pending.timer);
        }
        this.pendingCdpResponses.clear();

        this.running = false;
        this.emit("statusChange", false);
        this.log("success", "[service] All services stopped");
    }

    private startDebugServer(): void {
        const port = this.config.debugPort;
        this.debugWss = new WebSocketServer({ port });
        this.log("info", `[server] Debug server running on ws://localhost:${port}`);

        const onMessage = (message: ArrayBuffer) => {
            if (this.config.verbose) {
                const hex = Array.from(new Uint8Array(message))
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("");
                this.log("info", `[client] received raw message (hex): ${hex}`);
            }

            let unwrappedData: any = null;
            try {
                const decodedData = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.decode(message);
                unwrappedData = codex.unwrapDebugMessageData(decodedData);
                if (this.config.verbose) {
                    this.log("info", `[client] [DEBUG] decoded data: ${JSON.stringify(unwrappedData)}`);
                }
            } catch (e) {
                this.log("error", `[client] err: ${e}`);
            }

            if (unwrappedData === null) {
                return;
            }

            if (unwrappedData.category === "chromeDevtoolsResult") {
                this.debugMessageEmitter.emit("cdpmessage", unwrappedData.data.payload);
            }
        };

        this.debugWss.on("connection", (ws: WebSocket) => {
            this.log("success", "[conn] Miniapp client connected");
            ws.on("message", onMessage);
            ws.on("error", (err) => {
                this.log("error", `[client] err: ${err}`);
            });
            ws.on("close", () => {
                this.log("warn", "[client] Client disconnected");
            });
        });

        this.debugMessageEmitter.on("proxymessage", (message: string) => {
            if (!this.debugWss) return;
            this.debugWss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    const rawPayload = {
                        jscontext_id: "",
                        op_id: Math.round(100 * Math.random()),
                        payload: message.toString(),
                    };
                    if (this.config.verbose) {
                        this.log("info", `[proxy] rawPayload: ${JSON.stringify(rawPayload)}`);
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
    }

    private startProxyServer(): void {
        const port = this.config.cdpPort;
        this.proxyWss = new WebSocketServer({ port });
        this.log("info", `[server] Proxy server running on ws://localhost:${port}`);

        const onMessage = (message: string) => {
            this.debugMessageEmitter.emit("proxymessage", message);
        };

        this.proxyWss.on("connection", (ws: WebSocket) => {
            this.log("success", "[conn] CDP client connected");
            ws.on("message", onMessage);
            ws.on("error", (err) => {
                this.log("error", `[client] CDP err: ${err}`);
            });
            ws.on("close", () => {
                this.log("warn", "[client] CDP client disconnected");
                // Clean up injection tracking for this client
                this.injectedClients.delete(ws);
                this.injectedScriptIdentifiers.delete(ws);
            });

            // Attempt hook script injection for this new CDP client
            this.performHookInjection(ws);
        });

        this.debugMessageEmitter.on("cdpmessage", (message: string) => {
            // Check if this is a response to one of our internal CDP requests
            try {
                const parsed = JSON.parse(message);
                if (parsed.id && this.pendingCdpResponses.has(parsed.id)) {
                    const pending = this.pendingCdpResponses.get(parsed.id)!;
                    clearTimeout(pending.timer);
                    this.pendingCdpResponses.delete(parsed.id);
                    pending.resolve(parsed);
                    return; // Don't forward internal responses to CDP clients
                }
            } catch (e) {
                // Not JSON or parse error, forward as-is
            }

            if (!this.proxyWss) return;
            this.proxyWss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
        });
    }

    /**
     * Send a CDP command via the debug message emitter and wait for the response.
     * Uses high-range IDs (900000+) to avoid conflicts with DevTools requests.
     * Returns the parsed CDP response or null on timeout.
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
                this.log("warn", `[hook] CDP command timed out: ${method} (id: ${id})`);
                resolve(null);
            }, 5000);

            this.pendingCdpResponses.set(id, { resolve, timer });
            this.debugMessageEmitter.emit("proxymessage", JSON.stringify(command));
        });
    }

    /**
     * Perform hook script injection for a newly connected CDP client.
     * Combines all enabled plugins into a single script and injects via CDP.
     * Steps:
     * 1. Check if any plugins are enabled with non-empty scripts
     * 2. Check if this client has already been injected with the same combined script
     * 3. Send Page.enable to activate the Page domain
     * 4. Send Page.addScriptToEvaluateOnNewDocument with the combined script
     * 5. Track the injection to avoid duplicates
     */
    private async performHookInjection(ws: WebSocket): Promise<void> {
        // Check if any plugins are enabled
        if (!this.hookManager.hasEnabledPlugins()) {
            return;
        }

        const combinedScript = this.hookManager.getEnabledScripts();
        if (!combinedScript || combinedScript.trim().length === 0) {
            return;
        }

        // Check for duplicate injection (same client, same combined script)
        const currentIdentifier = this.hookManager.getIdentifier();
        if (this.injectedClients.has(ws)) {
            const previousIdentifier = this.injectedScriptIdentifiers.get(ws);
            if (previousIdentifier === currentIdentifier) {
                this.log("info", "[hook] Plugins already injected for this client, skipping");
                return;
            }
        }

        const enabledCount = this.hookManager.getPlugins().filter((p) => p.enabled && p.script && p.script.trim().length > 0).length;
        this.log("info", `[hook] Starting injection of ${enabledCount} enabled plugin(s)...`);

        try {
            // Step 1: Enable the Page domain
            const enableResult = await this.sendCdpCommand("Page.enable");
            if (enableResult === null) {
                this.log("error", "[hook] Failed to enable Page domain (timeout)");
                return;
            }

            if (enableResult.error) {
                this.log("error", `[hook] Page.enable failed: ${JSON.stringify(enableResult.error)}`);
                return;
            }

            this.log("info", "[hook] Page domain enabled");

            // Verify client is still connected before proceeding
            if (ws.readyState !== WebSocket.OPEN) {
                this.log("warn", "[hook] CDP client disconnected before injection could complete");
                return;
            }

            // Step 2: Add combined script to evaluate on new document
            const addScriptResult = await this.sendCdpCommand("Page.addScriptToEvaluateOnNewDocument", {
                source: combinedScript,
            });

            if (addScriptResult === null) {
                this.log("error", "[hook] Failed to add script (timeout)");
                return;
            }

            if (addScriptResult.error) {
                this.log("error", `[hook] addScriptToEvaluateOnNewDocument failed: ${JSON.stringify(addScriptResult.error)}`);
                return;
            }

            // Track successful injection
            this.injectedClients.add(ws);
            this.injectedScriptIdentifiers.set(ws, currentIdentifier);

            const identifier = addScriptResult.result?.identifier || "unknown";
            this.log("success", `[hook] ${enabledCount} plugin(s) injected successfully (identifier: ${identifier}, ${combinedScript.length} chars)`);
        } catch (e) {
            this.log("error", `[hook] Injection error: ${e}`);
        }
    }

    private async startFridaServer(): Promise<void> {
        const frida = await getFrida();
        const localDevice = await frida.getLocalDevice();
        const processes = await localDevice.enumerateProcesses({ scope: frida.Scope.Metadata });
        const wmpfProcesses = processes.filter((p) => p.name === "WeChatAppEx.exe");
        const wmpfPids = wmpfProcesses.map((p) => (p.parameters.ppid ? (p.parameters.ppid as number) : 0));

        // Find the parent process
        const wmpfPid = wmpfPids
            .sort((a, b) => wmpfPids.filter((v) => v === a).length - wmpfPids.filter((v) => v === b).length)
            .pop();

        if (wmpfPid === undefined) {
            throw new Error("[frida] WeChatAppEx.exe process not found");
        }

        const wmpfProcess = processes.filter((p) => p.pid === wmpfPid)[0];
        const wmpfProcessPath = (wmpfProcess.parameters.path as string) || "";
        const wmpfVersionMatch = wmpfProcessPath.match(/\d+/g);
        const wmpfVersion = wmpfVersionMatch ? Number(wmpfVersionMatch[wmpfVersionMatch.length - 1]) : 0;

        if (wmpfVersion === 0) {
            throw new Error("[frida] Error finding WMPF version");
        }

        this.log("info", `[frida] Found WMPF process, version: ${wmpfVersion}, pid: ${wmpfPid}`);

        // Attach to process
        this.fridaSession = await localDevice.attach(Number(wmpfPid));

        // Find hook script
        const projectRoot = this.getProjectRoot();
        let scriptContent: string | null = null;
        try {
            scriptContent = (await promises.readFile(path.join(projectRoot, "frida/hook.js"))).toString();
        } catch (e) {
            throw new Error("[frida] hook script not found");
        }

        let configContent: string | null = null;
        try {
            configContent = (
                await promises.readFile(path.join(projectRoot, "frida/config", `addresses.${wmpfVersion}.json`))
            ).toString();
            configContent = JSON.stringify(JSON.parse(configContent));
        } catch (e) {
            throw new Error(`[frida] Version config not found: ${wmpfVersion}`);
        }

        if (scriptContent === null || configContent === null) {
            throw new Error("[frida] Unable to find hook script or config");
        }

        // Load script
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
        this.log("success", `[frida] Script loaded, WMPF version: ${wmpfVersion}, pid: ${wmpfPid}`);
    }
}
