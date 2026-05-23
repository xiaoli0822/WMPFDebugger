import { contextBridge, ipcRenderer } from "electron";
import { BuiltinHookTemplate } from "./builtinHookTemplates";

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
    openDevTools: (port: number) => Promise<{ success: boolean; error?: string; url?: string; scheme?: string; browser?: string }>;
    getHookPlugins: () => Promise<{ success: boolean; error?: string; data: HookPlugin[] }>;
    getBuiltinHookTemplates: () => Promise<{ success: boolean; error?: string; data: BuiltinHookTemplate[] }>;
    createHookPluginFromTemplate: (templateId: string) => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    addHookPlugin: (name: string, script: string, source: "inline" | "file", filePath?: string) => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    removeHookPlugin: (id: string) => Promise<{ success: boolean; error?: string; data?: boolean }>;
    updateHookPlugin: (id: string, updates: { name?: string; script?: string }) => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    toggleHookPlugin: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    importHookFile: () => Promise<{ success: boolean; error?: string; data?: HookPlugin }>;
    exportHookPluginsConfig: () => Promise<{
        success: boolean;
        error?: string;
        data?: {
            filePath: string;
            pluginCount: number;
        };
    }>;
    importHookPluginsConfig: () => Promise<{
        success: boolean;
        error?: string;
        data?: {
            filePath: string;
            pluginCount: number;
            plugins: HookPlugin[];
        };
    }>;
    onLog: (callback: (entry: { timestamp: string; level: string; message: string }) => void) => void;
    onStatusChange: (callback: (running: boolean) => void) => void;
}

export interface WindowAPI {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
}

const validatePort = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1024 || value > 65535) {
        throw new Error(`${label}必须是 1024 到 65535 之间的整数`);
    }
    return value;
};

const validateString = (value: unknown, label: string, maxLength: number, allowEmpty = false): string => {
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

const validateSource = (value: unknown): "inline" | "file" => {
    if (value !== "inline" && value !== "file") {
        throw new Error("插件来源必须是 inline 或 file");
    }
    return value;
};

const validateUpdates = (value: unknown): { name?: string; script?: string } => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("插件更新内容必须是对象");
    }

    const input = value as { name?: unknown; script?: unknown };
    const updates: { name?: string; script?: string } = {};
    if (input.name !== undefined) {
        updates.name = validateString(input.name, "插件名称", 120);
    }
    if (input.script !== undefined) {
        updates.script = validateString(input.script, "插件脚本", 1_000_000, true);
    }
    return updates;
};

contextBridge.exposeInMainWorld("debuggerAPI", {
    start: (config: { debugPort: number; cdpPort: number }) => ipcRenderer.invoke("debugger:start", {
        debugPort: validatePort(config?.debugPort, "调试端口"),
        cdpPort: validatePort(config?.cdpPort, "CDP 端口"),
    }),
    stop: () => ipcRenderer.invoke("debugger:stop"),
    getProcesses: () => ipcRenderer.invoke("debugger:getProcesses"),
    getVersions: () => ipcRenderer.invoke("debugger:getVersions"),
    getStatus: () => ipcRenderer.invoke("debugger:getStatus"),
    openDevTools: (port: number) => ipcRenderer.invoke("debugger:openDevTools", validatePort(port, "CDP 端口")),
    getHookPlugins: () => ipcRenderer.invoke("debugger:getHookPlugins"),
    getBuiltinHookTemplates: () => ipcRenderer.invoke("debugger:getBuiltinHookTemplates"),
    createHookPluginFromTemplate: (templateId: string) => ipcRenderer.invoke(
        "debugger:createHookPluginFromTemplate",
        validateString(templateId, "模板 ID", 200)
    ),
    addHookPlugin: (name: string, script: string, source: "inline" | "file", filePath?: string) => {
        if (source !== "inline" || filePath !== undefined) {
            throw new Error("请使用“导入文件”添加文件型 Hook 插件");
        }
        return ipcRenderer.invoke(
            "debugger:addHookPlugin",
            validateString(name, "插件名称", 120),
            validateString(script, "插件脚本", 1_000_000, true),
            validateSource(source)
        );
    },
    removeHookPlugin: (id: string) => ipcRenderer.invoke("debugger:removeHookPlugin", validateString(id, "插件 ID", 120)),
    updateHookPlugin: (id: string, updates: { name?: string; script?: string }) => ipcRenderer.invoke(
        "debugger:updateHookPlugin",
        validateString(id, "插件 ID", 120),
        validateUpdates(updates)
    ),
    toggleHookPlugin: (id: string, enabled: boolean) => {
        if (typeof enabled !== "boolean") {
            throw new Error("启用状态必须是布尔值");
        }
        return ipcRenderer.invoke("debugger:toggleHookPlugin", validateString(id, "插件 ID", 120), enabled);
    },
    importHookFile: () => ipcRenderer.invoke("debugger:importHookFile"),
    exportHookPluginsConfig: () => ipcRenderer.invoke("debugger:exportHookPluginsConfig"),
    importHookPluginsConfig: () => ipcRenderer.invoke("debugger:importHookPluginsConfig"),
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
