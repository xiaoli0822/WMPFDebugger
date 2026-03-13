import { contextBridge, ipcRenderer } from "electron";

export interface HookPlugin {
    id: string;
    name: string;
    script: string;
    enabled: boolean;
    source: "inline" | "file";
    filePath?: string;
    createdAt: number;
}

export interface DebuggerAPI {
    start: (config: { debugPort: number; cdpPort: number }) => Promise<{ success: boolean; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    getProcesses: () => Promise<{
        success: boolean;
        error?: string;
        data: Array<{
            pid: number;
            name: string;
            path: string;
            version: number;
            isParent: boolean;
        }>;
    }>;
    getVersions: () => Promise<{ success: boolean; error?: string; data: number[] }>;
    getStatus: () => Promise<{ running: boolean }>;
    openDevTools: (port: number) => Promise<{ success: boolean; error?: string }>;
    getHookPlugins: () => Promise<{ success: boolean; error?: string; data: HookPlugin[] }>;
    addHookPlugin: (name: string, script: string, source: "inline" | "file", filePath?: string) => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    removeHookPlugin: (id: string) => Promise<{ success: boolean; error?: string; data?: boolean }>;
    updateHookPlugin: (id: string, updates: { name?: string; script?: string }) => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    toggleHookPlugin: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    importHookFile: () => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    onLog: (callback: (entry: { timestamp: string; level: string; message: string }) => void) => void;
    onStatusChange: (callback: (running: boolean) => void) => void;
}

export interface WindowAPI {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
}

contextBridge.exposeInMainWorld("debuggerAPI", {
    start: (config: { debugPort: number; cdpPort: number }) => ipcRenderer.invoke("debugger:start", config),
    stop: () => ipcRenderer.invoke("debugger:stop"),
    getProcesses: () => ipcRenderer.invoke("debugger:getProcesses"),
    getVersions: () => ipcRenderer.invoke("debugger:getVersions"),
    getStatus: () => ipcRenderer.invoke("debugger:getStatus"),
    openDevTools: (port: number) => ipcRenderer.invoke("debugger:openDevTools", port),
    getHookPlugins: () => ipcRenderer.invoke("debugger:getHookPlugins"),
    addHookPlugin: (name: string, script: string, source: "inline" | "file", filePath?: string) => ipcRenderer.invoke("debugger:addHookPlugin", name, script, source, filePath),
    removeHookPlugin: (id: string) => ipcRenderer.invoke("debugger:removeHookPlugin", id),
    updateHookPlugin: (id: string, updates: { name?: string; script?: string }) => ipcRenderer.invoke("debugger:updateHookPlugin", id, updates),
    toggleHookPlugin: (id: string, enabled: boolean) => ipcRenderer.invoke("debugger:toggleHookPlugin", id, enabled),
    importHookFile: () => ipcRenderer.invoke("debugger:importHookFile"),
    onLog: (callback: (entry: { timestamp: string; level: string; message: string }) => void) => {
        ipcRenderer.on("debugger:log", (_event, entry) => callback(entry));
    },
    onStatusChange: (callback: (running: boolean) => void) => {
        ipcRenderer.on("debugger:statusChange", (_event, running) => callback(running));
    },
} as DebuggerAPI);

contextBridge.exposeInMainWorld("windowAPI", {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
} as WindowAPI);
