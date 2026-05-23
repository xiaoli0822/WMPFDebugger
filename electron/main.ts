import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { DebugService, LogEntry } from "./debugService";

let mainWindow: BrowserWindow | null = null;
let debugService: DebugService | null = null;

type BrowserType = "chrome" | "edge" | "system" | "unknown";

type Settings = {
    preferredBrowserPath?: string;
};

const getProjectRoot = (): string => {
    return path.join(__dirname, "..");
};

const getSettingsPath = (): string => {
    return path.join(getConfigDir(), "settings.json");
};

const getConfigDir = (): string => {
    return path.join(app.getPath("userData"), "WMPFDebugger");
};

const getLegacyHookConfigPath = (): string => {
    return path.join(getProjectRoot(), ".aone_copilot", "hook-scripts.json");
};

const getDebugService = (): DebugService => {
    if (!debugService) {
        debugService = new DebugService(getConfigDir(), getLegacyHookConfigPath());
        debugService.on("log", (entry: LogEntry) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("debugger:log", entry);
            }
        });
        debugService.on("statusChange", (running: boolean) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("debugger:statusChange", running);
            }
        });
    }
    return debugService;
};

const loadSettings = async (): Promise<Settings> => {
    try {
        const raw = await fs.readFile(getSettingsPath(), "utf-8");
        return JSON.parse(raw) as Settings;
    } catch {
        return {};
    }
};

const saveSettings = async (settings: Settings): Promise<void> => {
    const settingsPath = getSettingsPath();
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
};

const fileExists = async (filePath: string): Promise<boolean> => {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

const normalizePort = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1024 || value > 65535) {
        throw new Error(`${label}必须是 1024 到 65535 之间的整数`);
    }
    return value;
};

const normalizeString = (value: unknown, label: string, maxLength: number, allowEmpty = false): string => {
    if (typeof value !== "string") {
        throw new Error(`${label}必须是字符串`);
    }
    if (!allowEmpty && value.trim().length === 0) {
        throw new Error(`${label}不能为空`);
    }
    if (value.length > maxLength) {
        throw new Error(`${label}过长`);
    }
    return value;
};

const normalizeSource = (value: unknown): "inline" | "file" => {
    if (value !== "inline" && value !== "file") {
        throw new Error("插件来源必须是 inline 或 file");
    }
    return value;
};

const normalizePluginUpdates = (value: unknown): { name?: string; script?: string } => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("插件更新内容必须是对象");
    }
    const updates = value as { name?: unknown; script?: unknown };
    const normalized: { name?: string; script?: string } = {};
    if (updates.name !== undefined) {
        normalized.name = normalizeString(updates.name, "插件名称", 120);
    }
    if (updates.script !== undefined) {
        normalized.script = normalizeString(updates.script, "插件脚本", 1_000_000, true);
    }
    return normalized;
};

const normalizeJsonFilePath = (value: unknown, label: string, appendExtension = false): string => {
    let filePath = normalizeString(value, label, 4096);
    if (appendExtension && path.extname(filePath).length === 0) {
        filePath = `${filePath}.json`;
    }
    if (path.extname(filePath).toLowerCase() !== ".json") {
        throw new Error(`${label} must be a .json file`);
    }
    return filePath;
};

const createHookConfigExportName = (): string => {
    const now = new Date();
    const parts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "-",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
    ];
    return `hook-plugins-${parts.join("")}.json`;
};

const inferBrowserType = (exePath: string): BrowserType => {
    const lower = path.basename(exePath).toLowerCase();
    if (lower.includes("chrome")) return "chrome";
    if (lower.includes("msedge") || lower.includes("edge")) return "edge";
    return "unknown";
};

const getBrowserCandidates = (): Array<{ path: string; type: BrowserType }> => {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "";

    const chrome = [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    ];

    const edge = [
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];

    return [
        ...chrome.map((p) => ({ path: p, type: "chrome" as const })),
        ...edge.map((p) => ({ path: p, type: "edge" as const })),
    ].filter((p) => p.path && p.path.trim().length > 0);
};

const getDevtoolsUrlForBrowser = (
    browserType: BrowserType,
    targetPort: number,
    browserDebugPort = targetPort + 1
): { url: string; scheme: string } => {
    return {
        url: `http://127.0.0.1:${browserDebugPort}/devtools/inspector.html?ws=127.0.0.1:${targetPort}`,
        scheme: browserType === "edge" ? "edge-devtools-http" : "chrome-devtools-http",
    };
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = (): Promise<number> => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
            server.close(() => reject(new Error("unable-to-resolve-port")));
            return;
        }
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(address.port);
        });
    });
});

const waitForBrowserDebugEndpoint = async (port: number, timeoutMs = 10_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await new Promise<boolean>((resolve) => {
            const request = http.get(
                {
                    hostname: "127.0.0.1",
                    port,
                    path: "/json/version",
                    timeout: 1_000,
                },
                (response) => {
                    response.resume();
                    resolve((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 500);
                }
            );

            request.once("error", () => resolve(false));
            request.once("timeout", () => {
                request.destroy();
                resolve(false);
            });
        });

        if (ready) {
            return true;
        }

        await delay(250);
    }

    return false;
};

const openDevtoolsInBrowser = async (exePath: string, url: string, extraArgs: string[] = []): Promise<boolean> => {
    const attempts: string[][] = [
        [...extraArgs, "--new-window", url, "--no-first-run", "--no-default-browser-check"],
        [...extraArgs, url, "--no-first-run", "--no-default-browser-check"],
    ];

    for (const args of attempts) {
        try {
            const child = spawn(exePath, args, {
                detached: true,
                stdio: "ignore",
            });
            const didSpawn = await new Promise<boolean>((resolve) => {
                let settled = false;
                const settle = (ok: boolean) => {
                    if (settled) return;
                    settled = true;
                    resolve(ok);
                };

                child.once("spawn", () => {
                    child.unref();
                    settle(true);
                });
                child.once("error", () => settle(false));
            });

            if (didSpawn) {
                return true;
            }
        } catch {
            // Try next argument strategy
        }
    }

    return false;
};

const tryOpenDevtoolsTarget = async (
    browserType: BrowserType,
    port: number,
    exePath?: string
): Promise<{ success: boolean; url?: string; scheme?: string }> => {
    if (!exePath) {
        return { success: false };
    }

    const browserDebugPort = await getFreePort();
    const devtools = getDevtoolsUrlForBrowser(browserType, port, browserDebugPort);
    const profileDir = path.join(getConfigDir(), "devtools-browser-profiles", `${browserType}-${browserDebugPort}`);
    await fs.mkdir(profileDir, { recursive: true });

    const hostStarted = await openDevtoolsInBrowser(
        exePath,
        "about:blank",
        [`--remote-debugging-port=${browserDebugPort}`, `--user-data-dir=${profileDir}`]
    );
    if (!hostStarted) {
        return { success: false };
    }

    const endpointReady = await waitForBrowserDebugEndpoint(browserDebugPort);
    if (!endpointReady) {
        return { success: false };
    }

    const opened = await openDevtoolsInBrowser(
        exePath,
        devtools.url,
        [`--remote-debugging-port=${browserDebugPort}`, `--user-data-dir=${profileDir}`]
    );
    return opened ? { success: true, url: devtools.url, scheme: devtools.scheme } : { success: false };
};

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        frame: false,
        backgroundColor: "#1e1e2e",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
        icon: path.join(__dirname, "..", "screenshots", "console.png"),
    });

    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

// --- IPC Handlers ---

// Window controls
ipcMain.on("window:minimize", () => {
    mainWindow?.minimize();
});

ipcMain.on("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});

ipcMain.on("window:close", () => {
    mainWindow?.close();
});

// Debug service controls
ipcMain.handle("debugger:start", async (_event, config: { debugPort?: unknown; cdpPort?: unknown }) => {
    try {
        const debugPort = normalizePort(config?.debugPort, "调试端口");
        const cdpPort = normalizePort(config?.cdpPort, "CDP 端口");
        if (debugPort === cdpPort) {
            throw new Error("调试端口和 CDP 端口不能相同");
        }
        await getDebugService().start({
            debugPort,
            cdpPort,
            verbose: false,
        });
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:stop", async () => {
    try {
        await getDebugService().stop();
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:getProcesses", async () => {
    try {
        const result = await getDebugService().getProcesses();
        if (result.error) {
            return { success: false, error: result.error, data: [] };
        }
        return { success: true, data: result.processes };
    } catch (e: any) {
        return { success: false, error: e.message || String(e), data: [] };
    }
});

ipcMain.handle("debugger:getVersions", async () => {
    try {
        const versions = await getDebugService().getAvailableVersions();
        return { success: true, data: versions };
    } catch (e: any) {
        return { success: false, error: e.message || String(e), data: [] };
    }
});

ipcMain.handle("debugger:getStatus", () => {
    const service = getDebugService();
    return { running: service.isRunning(), busy: service.isBusy() };
});

ipcMain.handle("debugger:openDevTools", async (_event, port: number) => {
    try {
        const cdpPort = normalizePort(port, "CDP 端口");
        if (!getDebugService().isRunning()) {
            const fallback = getDevtoolsUrlForBrowser("unknown", cdpPort);
            return { success: false, error: "service-not-running", url: fallback.url, scheme: fallback.scheme };
        }

        // 1) Use saved preferred browser if available
        const settings = await loadSettings();
        if (settings.preferredBrowserPath && await fileExists(settings.preferredBrowserPath)) {
            const browserType = inferBrowserType(settings.preferredBrowserPath);
            const openResult = await tryOpenDevtoolsTarget(browserType, cdpPort, settings.preferredBrowserPath);
            if (openResult.success) return { success: true, browser: browserType, url: openResult.url, scheme: openResult.scheme };
        }

        // 2) Auto-detect Chrome/Edge
        const candidates = getBrowserCandidates();
        for (const candidate of candidates) {
            if (await fileExists(candidate.path)) {
                const openResult = await tryOpenDevtoolsTarget(candidate.type, cdpPort, candidate.path);
                if (openResult.success) return { success: true, browser: candidate.type, url: openResult.url, scheme: openResult.scheme };
            }
        }

        // 3) Ask user to locate a browser executable
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: "选择浏览器可执行文件",
            filters: [
                { name: "可执行文件", extensions: ["exe"] },
            ],
            properties: ["openFile"],
        });

        if (result.canceled || result.filePaths.length === 0) {
            const fallback = getDevtoolsUrlForBrowser("unknown", cdpPort);
            return { success: false, error: "cancelled", url: fallback.url, scheme: fallback.scheme };
        }

        const selectedPath = result.filePaths[0];
        if (path.extname(selectedPath).toLowerCase() !== ".exe" || !await fileExists(selectedPath)) {
            const fallback = getDevtoolsUrlForBrowser("unknown", cdpPort);
            return { success: false, error: "invalid-browser-executable", url: fallback.url, scheme: fallback.scheme };
        }
        const selectedType = inferBrowserType(selectedPath);
        const openResult = await tryOpenDevtoolsTarget(selectedType, cdpPort, selectedPath);
        if (openResult.success) {
            await saveSettings({ preferredBrowserPath: selectedPath });
            return { success: true, browser: selectedType, url: openResult.url, scheme: openResult.scheme };
        }

        // 4) Report a stable manual URL instead of triggering an unhandled custom protocol prompt
        const fallback = getDevtoolsUrlForBrowser("unknown", cdpPort);
        return { success: false, error: "unable-to-open-devtools", url: fallback.url, scheme: fallback.scheme };
    } catch (e: any) {
        const fallbackPort = typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
            ? port
            : 62000;
        const fallback = getDevtoolsUrlForBrowser("unknown", fallbackPort);
        return { success: false, error: e.message || String(e), url: fallback.url, scheme: fallback.scheme };
    }
});

// Hook plugin controls
ipcMain.handle("debugger:getHookPlugins", async () => {
    try {
        const plugins = await getDebugService().getHookPlugins();
        return { success: true, data: plugins };
    } catch (e: any) {
        return { success: false, error: e.message || String(e), data: [] };
    }
});

ipcMain.handle("debugger:getBuiltinHookTemplates", async () => {
    try {
        const templates = await getDebugService().getBuiltinHookTemplates();
        return { success: true, data: templates };
    } catch (e: any) {
        return { success: false, error: e.message || String(e), data: [] };
    }
});

ipcMain.handle("debugger:createHookPluginFromTemplate", async (_event, templateId: unknown) => {
    try {
        const plugin = await getDebugService().createHookPluginFromTemplate(
            normalizeString(templateId, "模板 ID", 200)
        );
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:addHookPlugin", async (_event, name: unknown, script: unknown, source: unknown, filePath?: unknown) => {
    try {
        const normalizedSource = normalizeSource(source);
        if (normalizedSource !== "inline" || filePath !== undefined) {
            throw new Error("请使用“导入文件”添加文件型 Hook 插件");
        }
        const normalizedFilePath = filePath === undefined
            ? undefined
            : normalizeString(filePath, "插件文件路径", 4096);
        const plugin = await getDebugService().addHookPlugin(
            normalizeString(name, "插件名称", 120),
            normalizeString(script, "插件脚本", 1_000_000, true),
            normalizedSource,
            normalizedFilePath
        );
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:removeHookPlugin", async (_event, id: unknown) => {
    try {
        const removed = await getDebugService().removeHookPlugin(normalizeString(id, "插件 ID", 120));
        return { success: true, data: removed };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:updateHookPlugin", async (_event, id: unknown, updates: unknown) => {
    try {
        const plugin = await getDebugService().updateHookPlugin(
            normalizeString(id, "插件 ID", 120),
            normalizePluginUpdates(updates)
        );
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:toggleHookPlugin", async (_event, id: unknown, enabled: unknown) => {
    try {
        if (typeof enabled !== "boolean") {
            throw new Error("启用状态必须是布尔值");
        }
        const plugin = await getDebugService().toggleHookPlugin(normalizeString(id, "插件 ID", 120), enabled);
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:importHookFile", async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: "导入 Hook 脚本",
            filters: [
                { name: "JavaScript 文件", extensions: ["js"] },
            ],
            properties: ["openFile"],
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: "cancelled" };
        }

        const filePath = result.filePaths[0];
        if (path.extname(filePath).toLowerCase() !== ".js") {
            return { success: false, error: "只能导入 .js Hook 文件" };
        }
        const plugin = await getDebugService().importHookFile(filePath);
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:exportHookPluginsConfig", async () => {
    try {
        if (!mainWindow || mainWindow.isDestroyed()) {
            throw new Error("Main window is unavailable");
        }

        const result = await dialog.showSaveDialog(mainWindow, {
            title: "\u5bfc\u51fa Hook \u63d2\u4ef6\u914d\u7f6e",
            defaultPath: path.join(app.getPath("documents"), createHookConfigExportName()),
            filters: [
                { name: "JSON", extensions: ["json"] },
            ],
        });

        if (result.canceled || !result.filePath) {
            return { success: false, error: "cancelled" };
        }

        const exportResult = await getDebugService().exportHookPluginsConfig(
            normalizeJsonFilePath(result.filePath, "Hook plugin config path", true)
        );
        return { success: true, data: exportResult };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:importHookPluginsConfig", async () => {
    try {
        if (!mainWindow || mainWindow.isDestroyed()) {
            throw new Error("Main window is unavailable");
        }

        const result = await dialog.showOpenDialog(mainWindow, {
            title: "\u5bfc\u5165 Hook \u63d2\u4ef6\u914d\u7f6e",
            filters: [
                { name: "JSON", extensions: ["json"] },
            ],
            properties: ["openFile"],
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: "cancelled" };
        }

        const filePath = normalizeJsonFilePath(result.filePaths[0], "Hook plugin config path");
        if (!await fileExists(filePath)) {
            return { success: false, error: `File not found: ${filePath}` };
        }

        const plugins = await getDebugService().importHookPluginsConfig(filePath);
        return {
            success: true,
            data: {
                filePath,
                pluginCount: plugins.length,
                plugins,
            },
        };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

// --- App lifecycle ---

app.whenReady().then(() => {
    getDebugService();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", async () => {
    if (debugService?.isRunning() || debugService?.isBusy()) {
        try {
            await debugService.stop();
        } catch (e) {
            // 忽略关闭阶段的错误。
        }
    }
    app.quit();
});
