export const HOOK_PLUGIN_CONSOLE_PREFIX = "[HookPlugin:";
export const HOOK_PLUGIN_SCRIPT_SOURCE_PREFIX = "wmpf-debugger-hook-";

export type HookPluginConsoleLog = {
    level: "info" | "warn" | "error";
    message: string;
};

type RuntimeConsolePayload = {
    method?: string;
    params?: {
        type?: string;
        args?: Array<{
            type?: string;
            subtype?: string;
            value?: unknown;
            unserializableValue?: unknown;
            description?: string;
        }>;
        stackTrace?: {
            callFrames?: Array<{
                url?: string;
            }>;
        };
    };
};

export function buildHookPluginConsolePrefix(pluginName: string): string {
    return `${HOOK_PLUGIN_CONSOLE_PREFIX}${String(pluginName)}]`;
}

export function extractHookPluginConsoleLog(payload: string): HookPluginConsoleLog | null {
    const parsed = tryParsePayload(payload);
    if (!parsed || parsed.method !== "Runtime.consoleAPICalled" || !parsed.params) {
        return null;
    }

    const params = parsed.params;
    const parts = Array.isArray(params.args)
        ? params.args.map(formatConsoleArgument).filter(Boolean)
        : [];
    const joinedMessage = parts.join(" ").trim();
    const hasPluginPrefix = parts.length > 0 && parts[0].startsWith(HOOK_PLUGIN_CONSOLE_PREFIX);
    const fromHookScript = stackTraceContainsHookPluginScript(params.stackTrace);

    if (!hasPluginPrefix && !fromHookScript) {
        return null;
    }

    const baseMessage = joinedMessage || "[HookPlugin] 空日志";
    return {
        level: mapConsoleTypeToLevel(params.type),
        message: hasPluginPrefix ? baseMessage : `[HookPlugin] ${baseMessage}`,
    };
}

function tryParsePayload(payload: string): RuntimeConsolePayload | null {
    try {
        return JSON.parse(payload) as RuntimeConsolePayload;
    } catch {
        return null;
    }
}

function formatConsoleArgument(arg: {
    type?: string;
    subtype?: string;
    value?: unknown;
    unserializableValue?: unknown;
    description?: string;
}): string {
    if (typeof arg.value === "string") {
        return arg.value;
    }
    if (arg.value !== undefined) {
        return String(arg.value);
    }
    if (arg.unserializableValue !== undefined) {
        return String(arg.unserializableValue);
    }
    if (typeof arg.description === "string" && arg.description.trim().length > 0) {
        return arg.description;
    }
    if (typeof arg.subtype === "string" && arg.subtype.trim().length > 0) {
        return `[${arg.subtype}]`;
    }
    if (typeof arg.type === "string" && arg.type.trim().length > 0) {
        return `[${arg.type}]`;
    }
    return "";
}

function stackTraceContainsHookPluginScript(stackTrace?: {
    callFrames?: Array<{
        url?: string;
    }>;
}): boolean {
    const callFrames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : [];
    return callFrames.some((frame) => typeof frame.url === "string" && frame.url.includes(HOOK_PLUGIN_SCRIPT_SOURCE_PREFIX));
}

function mapConsoleTypeToLevel(type?: string): "info" | "warn" | "error" {
    if (type === "warning") {
        return "warn";
    }
    if (type === "error" || type === "assert") {
        return "error";
    }
    return "info";
}
