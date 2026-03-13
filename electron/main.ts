import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import path from "node:path";
import { DebugService, LogEntry } from "./debugService";

let mainWindow: BrowserWindow | null = null;
const debugService = new DebugService();

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
ipcMain.handle("debugger:start", async (_event, config: { debugPort: number; cdpPort: number }) => {
    try {
        await debugService.start({
            debugPort: config.debugPort,
            cdpPort: config.cdpPort,
            verbose: false,
        });
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:stop", async () => {
    try {
        await debugService.stop();
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:getProcesses", async () => {
    try {
        const processes = await debugService.getProcesses();
        return { success: true, data: processes };
    } catch (e: any) {
        return { success: false, error: e.message || String(e), data: [] };
    }
});

ipcMain.handle("debugger:getVersions", async () => {
    try {
        const versions = await debugService.getAvailableVersions();
        return { success: true, data: versions };
    } catch (e: any) {
        return { success: false, error: e.message || String(e), data: [] };
    }
});

ipcMain.handle("debugger:getStatus", () => {
    return { running: debugService.isRunning() };
});

ipcMain.handle("debugger:openDevTools", async (_event, port: number) => {
    const url = `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${port}`;
    try {
        await shell.openExternal(url);
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

// Hook plugin controls
ipcMain.handle("debugger:getHookPlugins", () => {
    try {
        const plugins = debugService.getHookPlugins();
        return { success: true, data: plugins };
    } catch (e: any) {
        return { success: false, error: e.message || String(e), data: [] };
    }
});

ipcMain.handle("debugger:addHookPlugin", async (_event, name: string, script: string, source: "inline" | "file", filePath?: string) => {
    try {
        const plugin = await debugService.addHookPlugin(name, script, source, filePath);
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:removeHookPlugin", async (_event, id: string) => {
    try {
        const removed = await debugService.removeHookPlugin(id);
        return { success: true, data: removed };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:updateHookPlugin", async (_event, id: string, updates: { name?: string; script?: string }) => {
    try {
        const plugin = await debugService.updateHookPlugin(id, updates);
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:toggleHookPlugin", async (_event, id: string, enabled: boolean) => {
    try {
        const plugin = await debugService.toggleHookPlugin(id, enabled);
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle("debugger:importHookFile", async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: "Import Hook Script",
            filters: [
                { name: "JavaScript Files", extensions: ["js"] },
                { name: "All Files", extensions: ["*"] },
            ],
            properties: ["openFile"],
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: "cancelled" };
        }

        const filePath = result.filePaths[0];
        const plugin = await debugService.importHookFile(filePath);
        return { success: true, data: plugin };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
});

// --- Service event forwarding ---

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

// --- App lifecycle ---

app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", async () => {
    if (debugService.isRunning()) {
        try {
            await debugService.stop();
        } catch (e) {
            // Ignore errors during shutdown
        }
    }
    app.quit();
});
