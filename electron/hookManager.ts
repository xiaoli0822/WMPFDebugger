import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
    plugins: HookPlugin[];
}

export class HookManager {
    private plugins: HookPlugin[] = [];
    private configPath: string;
    private configDir: string;

    constructor(projectRoot: string) {
        this.configDir = path.join(projectRoot, ".aone_copilot");
        this.configPath = path.join(this.configDir, "hook-scripts.json");
    }

    /**
     * Load persisted plugin configuration from disk.
     * Handles migration from old single-script format.
     */
    async load(): Promise<void> {
        try {
            const content = await fs.readFile(this.configPath, "utf-8");
            const parsed = JSON.parse(content);

            // Migration: detect old single-script format { script, enabled }
            if (parsed.script !== undefined && parsed.plugins === undefined) {
                const oldScript = parsed.script || "";
                const oldEnabled = parsed.enabled || false;
                if (oldScript.trim().length > 0) {
                    this.plugins = [{
                        id: this.generateId(),
                        name: "Migrated Script",
                        script: oldScript,
                        enabled: oldEnabled,
                        source: "inline",
                        createdAt: Date.now(),
                    }];
                } else {
                    this.plugins = [];
                }
                // Persist in new format immediately
                await this.save();
            } else {
                const config: HookPluginsConfig = parsed;
                this.plugins = config.plugins || [];
            }
        } catch (e) {
            // File doesn't exist or is invalid, use defaults
            this.plugins = [];
        }
    }

    /**
     * Persist current plugin configuration to disk.
     */
    async save(): Promise<void> {
        try {
            await fs.mkdir(this.configDir, { recursive: true });
            const config: HookPluginsConfig = {
                plugins: this.plugins,
            };
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), "utf-8");
        } catch (e) {
            throw new Error(`Failed to save hook config: ${e}`);
        }
    }

    /**
     * Add a new plugin and persist to disk.
     */
    async addPlugin(name: string, script: string, source: "inline" | "file", filePath?: string): Promise<HookPlugin> {
        const plugin: HookPlugin = {
            id: this.generateId(),
            name,
            script,
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
     * Remove a plugin by ID and persist to disk.
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
     * Update a plugin's properties (name, script) and persist to disk.
     */
    async updatePlugin(id: string, updates: { name?: string; script?: string }): Promise<HookPlugin | null> {
        const plugin = this.plugins.find((p) => p.id === id);
        if (!plugin) {
            return null;
        }
        if (updates.name !== undefined) {
            plugin.name = updates.name;
        }
        if (updates.script !== undefined) {
            plugin.script = updates.script;
        }
        await this.save();
        return plugin;
    }

    /**
     * Toggle a single plugin's enabled state and persist to disk.
     */
    async togglePlugin(id: string, enabled: boolean): Promise<HookPlugin | null> {
        const plugin = this.plugins.find((p) => p.id === id);
        if (!plugin) {
            return null;
        }
        // Cannot enable a plugin with empty script
        if (enabled && (!plugin.script || plugin.script.trim().length === 0)) {
            plugin.enabled = false;
        } else {
            plugin.enabled = enabled;
        }
        await this.save();
        return plugin;
    }

    /**
     * Get all plugins.
     */
    getPlugins(): HookPlugin[] {
        return [...this.plugins];
    }

    /**
     * Get a single plugin by ID.
     */
    getPlugin(id: string): HookPlugin | null {
        return this.plugins.find((p) => p.id === id) || null;
    }

    /**
     * Get the combined script of all enabled plugins.
     * Each plugin's script is wrapped in a try-catch and labeled with a comment header.
     */
    getEnabledScripts(): string {
        const enabledPlugins = this.plugins.filter(
            (p) => p.enabled && p.script && p.script.trim().length > 0
        );
        if (enabledPlugins.length === 0) {
            return "";
        }
        return enabledPlugins
            .map((p) => `// === Hook Plugin: ${p.name} (${p.id}) ===\ntry {\n${p.script}\n} catch(__hookErr__) { console.error("[HookPlugin:${p.name}]", __hookErr__); }`)
            .join("\n\n");
    }

    /**
     * Check if there are any enabled plugins with non-empty scripts.
     */
    hasEnabledPlugins(): boolean {
        return this.plugins.some(
            (p) => p.enabled && p.script && p.script.trim().length > 0
        );
    }

    /**
     * Get a unique identifier (hash) based on all enabled plugins' content.
     * Used to detect changes and avoid duplicate injection.
     */
    getIdentifier(): string {
        const combined = this.getEnabledScripts();
        if (!combined || combined.trim().length === 0) {
            return "";
        }
        return crypto.createHash("md5").update(combined).digest("hex");
    }

    /**
     * Import a JS file as a new plugin.
     * Reads the file content and uses the filename (without extension) as the plugin name.
     */
    async importFromFile(filePath: string): Promise<HookPlugin> {
        let content: string;
        try {
            content = await fs.readFile(filePath, "utf-8");
        } catch (e) {
            throw new Error(`Failed to read file: ${filePath} - ${e}`);
        }

        const fileName = path.basename(filePath, path.extname(filePath));
        return this.addPlugin(fileName, content, "file", filePath);
    }

    private generateId(): string {
        return crypto.randomUUID();
    }
}
