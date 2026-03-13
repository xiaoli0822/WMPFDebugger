### multi-plugin-hook-system ###
将现有的单一 Hook Script 功能升级为多插件管理系统，支持导入 JS 文件、管理多个插件、每个插件独立开关控制。


# 多插件 Hook 注入系统

## Proposed Changes

### 1. HookManager 重构为多插件管理

#### [MODIFY] [hookManager.ts](file:///C:/Users/lql/Desktop/WMPFDebugger/electron/hookManager.ts)
- 新增 `HookPlugin` 接口：
  ```typescript
  interface HookPlugin {
      id: string;          // UUID
      name: string;        // 插件名称（文件名或用户自定义）
      script: string;      // JS 脚本内容
      enabled: boolean;    // 独立开关
      source: "inline" | "file";  // 来源：手动输入 or 文件导入
      filePath?: string;   // 如果是文件导入，记录原始路径
      createdAt: number;   // 创建时间戳
  }
  ```
- 将 `HookConfig` 改为 `HookPluginsConfig`：
  ```typescript
  interface HookPluginsConfig {
      plugins: HookPlugin[];
  }
  ```
- 重写 HookManager 类方法：
  - `addPlugin(name, script, source, filePath?)` - 添加插件
  - `removePlugin(id)` - 删除插件
  - `updatePlugin(id, updates)` - 更新插件（名称/脚本/开关）
  - `togglePlugin(id, enabled)` - 切换单个插件开关
  - `getPlugins()` - 获取所有插件列表
  - `getPlugin(id)` - 获取单个插件
  - `getEnabledScripts()` - 获取所有启用的插件脚本（合并为一个字符串）
  - `hasEnabledPlugins()` - 是否有任何启用的插件
  - `getIdentifier()` - 基于所有启用插件内容的组合 hash
  - `importFromFile(filePath)` - 从 JS 文件导入插件（读取文件内容，以文件名作为插件名）
- 持久化文件路径不变：`.aone_copilot/hook-scripts.json`

---

### 2. DebugService 适配多插件

#### [MODIFY] [debugService.ts](file:///C:/Users/lql/Desktop/WMPFDebugger/electron/debugService.ts)
- 替换旧的单一 hook API 为多插件 API：
  - `addHookPlugin(name, script, source, filePath?)` → 添加插件
  - `removeHookPlugin(id)` → 删除插件
  - `updateHookPlugin(id, updates)` → 更新插件
  - `toggleHookPlugin(id, enabled)` → 切换插件开关
  - `getHookPlugins()` → 获取所有插件
  - `importHookFile(filePath)` → 导入 JS 文件
- 移除旧的 `setHookScript/getHookScript/setHookEnabled/isHookEnabled`
- 修改 `performHookInjection()`：
  - 调用 `hookManager.getEnabledScripts()` 获取合并后的脚本
  - 调用 `hookManager.hasEnabledPlugins()` 判断是否需要注入
  - 使用 `hookManager.getIdentifier()` 进行去重

---

### 3. IPC 通道重构

#### [MODIFY] [main.ts](file:///C:/Users/lql/Desktop/WMPFDebugger/electron/main.ts)
- 移除旧的 4 个 hook IPC handlers
- 新增 IPC handlers：
  - `debugger:getHookPlugins` - 获取插件列表
  - `debugger:addHookPlugin` - 添加插件（inline 方式）
  - `debugger:removeHookPlugin` - 删除插件
  - `debugger:updateHookPlugin` - 更新插件
  - `debugger:toggleHookPlugin` - 切换插件开关
  - `debugger:importHookFile` - 导入 JS 文件（使用 Electron `dialog.showOpenDialog` 打开文件选择器）

#### [MODIFY] [preload.ts](file:///C:/Users/lql/Desktop/WMPFDebugger/electron/preload.ts)
- 替换旧的 4 个 hook API 为新的多插件 API
- 更新 `DebuggerAPI` 接口定义

---

### 4. UI 界面重构 - 插件管理面板

#### [MODIFY] [index.html](file:///C:/Users/lql/Desktop/WMPFDebugger/renderer/index.html)
- 替换现有的 Hook Script 卡片为 "Hook Plugins" 卡片：
  - **卡片头部**：标题 "Hook Plugins" + "Import File" 按钮 + "Add Inline" 按钮
  - **插件列表区域** `#plugin-list`：动态渲染的插件条目列表
    - 每个插件条目包含：
      - 插件名称（可点击展开/收起编辑器）
      - 来源标签（`file` / `inline`）
      - 独立 toggle 开关
      - 删除按钮
    - 展开后显示：
      - 只读/可编辑的代码预览区（inline 可编辑，file 只读）
      - Save 按钮（仅 inline 模式）
  - **空状态**：无插件时显示提示文字

#### [MODIFY] [styles.css](file:///C:/Users/lql/Desktop/WMPFDebugger/renderer/styles.css)
- 移除旧的 `.hook-card` 相关样式（保留 `.toggle-switch`）
- 新增插件管理样式：
  - `.plugin-list` - 插件列表容器
  - `.plugin-item` - 单个插件条目（可折叠）
  - `.plugin-item-header` - 插件头部（名称 + 标签 + 开关 + 删除）
  - `.plugin-item-body` - 展开的编辑区域
  - `.plugin-name` - 插件名称
  - `.plugin-source-tag` - 来源标签（file/inline）
  - `.plugin-textarea` - 代码编辑区
  - `.plugin-actions` - 操作按钮区
  - `.plugin-empty` - 空状态提示
  - `.plugin-delete-btn` - 删除按钮（红色 X）
  - `.plugin-item.expanded` - 展开状态

#### [MODIFY] [renderer.js](file:///C:/Users/lql/Desktop/WMPFDebugger/renderer/renderer.js)
- 移除旧的 hook 单脚本相关逻辑和 DOM 引用
- 新增插件管理交互逻辑：
  - `renderPluginList(plugins)` - 渲染插件列表
  - `createPluginItem(plugin)` - 创建单个插件 DOM 元素
  - "Import File" 按钮：调用 `api.importHookFile()` 打开文件选择器
  - "Add Inline" 按钮：调用 `api.addHookPlugin()` 添加空白内联插件
  - 每个插件的 toggle 开关：调用 `api.toggleHookPlugin(id, enabled)`
  - 每个插件的删除按钮：确认后调用 `api.removeHookPlugin(id)`
  - 展开/收起插件编辑器
  - inline 插件的 Save 按钮：调用 `api.updateHookPlugin(id, {script})`
  - `init()` 中加载插件列表

---

## Verification Plan

### Automated Tests
- 运行 `npm run build:electron` 验证 TypeScript 编译无错误

### Manual Verification
1. 启动应用，验证 Hook Plugins 面板正常显示
2. 点击 "Add Inline" 添加内联插件，输入代码并保存
3. 点击 "Import File" 导入 .js 文件，验证文件内容正确加载
4. 验证每个插件的独立开关可以单独控制
5. 验证删除插件功能
6. 关闭重新打开应用，验证插件列表持久化
7. 启动调试服务，验证只有启用的插件被注入


updateAtTime: 2026/3/13 13:46:13

planId: 2de97300-8ee1-4ab2-8fd9-1e060f871482