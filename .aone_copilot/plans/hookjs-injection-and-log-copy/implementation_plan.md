### hookjs-injection-and-log-copy ###
修复日志面板文本不可复制的问题，并实现 HookJS 代码注入功能，包括 HookManager 状态管理、CDP 协议注入、UI 面板和完整的鲁棒性处理。


# HookJS 注入功能与日志复制修复

## Proposed Changes

### 1. 日志复制修复 (CSS)

#### [MODIFY] [styles.css](file:///C:/Users/lql/Desktop/WMPFDebugger/renderer/styles.css)
- 在 `.log-container` 和 `.log-entry` 上添加 `user-select: text` 和 `cursor: text`，覆盖 body 的 `user-select: none`
- 确保日志文本可以被选中和复制

---

### 2. HookManager 主进程状态管理

#### [NEW] [hookManager.ts](file:///C:/Users/lql/Desktop/WMPFDebugger/electron/hookManager.ts)
- 实现 `HookManager` 类，负责：
  - 持久化存储用户输入的 Hook 脚本字符串（使用 JSON 文件存储在项目根目录 `.aone_copilot/hook-scripts.json`）
  - 提供 `getScript()` / `setScript()` / `isEnabled()` / `setEnabled()` 接口
  - 脚本为空时自动禁用注入
  - 提供 `getIdentifier()` 方法返回脚本内容的 hash，用于去重判断

---

### 3. CDP 协议注入逻辑 (DebugService 适配)

#### [MODIFY] [debugService.ts](file:///C:/Users/lql/Desktop/WMPFDebugger/electron/debugService.ts)
- 引入 `HookManager` 实例
- 新增 `setHookScript(script: string)` 和 `getHookScript()` 公开方法
- 新增 `setHookEnabled(enabled: boolean)` 和 `isHookEnabled()` 方法
- 在 `startProxyServer()` 的 `proxyWss.on("connection")` 回调中，当 CDP 客户端连接时：
  1. 使用内部 ID 计数器生成唯一的 CDP 请求 ID（从 900000 开始，避免与 DevTools 的 ID 冲突）
  2. 先发送 `{"id": <id>, "method": "Page.enable"}` 指令
  3. 监听 `cdpmessage` 事件，等待 `Page.enable` 的响应（匹配 id）
  4. 收到响应后发送 `{"id": <id+1>, "method": "Page.addScriptToEvaluateOnNewDocument", "params": {"source": "<script>"}}`
  5. 记录注入结果日志
- **鲁棒性处理**：
  - 脚本为空或未启用时跳过注入
  - 使用 `Set` 记录已注入的 CDP 客户端（通过 WebSocket 实例引用），避免重复注入
  - 客户端断开时从 Set 中移除
  - CDP 客户端重连时重新注入
  - 注入超时处理（5秒无响应则放弃）

> [!IMPORTANT]
> 注入指令通过 `debugMessageEmitter.emit("proxymessage", JSON.stringify(cdpCommand))` 发送，经过 protobuf 编码后转发给微信客户端。响应通过 `debugMessageEmitter.on("cdpmessage")` 接收。注入的 CDP 请求 ID 使用 900000+ 的高位段，避免与 DevTools 正常请求冲突。

---

### 4. IPC 通道扩展

#### [MODIFY] [main.ts](file:///C:/Users/lql/Desktop/WMPFDebugger/electron/main.ts)
- 新增 IPC handlers：
  - `debugger:setHookScript` - 设置 Hook 脚本内容
  - `debugger:getHookScript` - 获取当前 Hook 脚本内容
  - `debugger:setHookEnabled` - 启用/禁用 Hook 注入
  - `debugger:isHookEnabled` - 查询 Hook 启用状态
- 移除 `mainWindow.webContents.openDevTools()` 调试代码

#### [MODIFY] [preload.ts](file:///C:/Users/lql/Desktop/WMPFDebugger/electron/preload.ts)
- 在 `DebuggerAPI` 接口中新增：
  - `setHookScript(script: string)` → `Promise<{success: boolean}>`
  - `getHookScript()` → `Promise<{success: boolean; data: string}>`
  - `setHookEnabled(enabled: boolean)` → `Promise<{success: boolean}>`
  - `isHookEnabled()` → `Promise<{success: boolean; data: boolean}>`
- 在 `contextBridge.exposeInMainWorld` 中添加对应的 `ipcRenderer.invoke` 调用

---

### 5. UI 界面 - Hook Script 面板

#### [MODIFY] [index.html](file:///C:/Users/lql/Desktop/WMPFDebugger/renderer/index.html)
- 在左侧面板（WMPF Information 卡片下方）添加新的 "Hook Script" 卡片：
  - 卡片头部：标题 "Hook Script" + 启用/禁用开关（toggle switch）
  - 代码输入区：`<textarea>` 代码编辑器，等宽字体，深色背景
  - 底部操作栏：
    - "Save" 按钮（保存脚本到主进程）
    - "Clear" 按钮（清空脚本）
  - 状态提示：显示"Saved"/"Unsaved changes"

#### [MODIFY] [styles.css](file:///C:/Users/lql/Desktop/WMPFDebugger/renderer/styles.css)
- 新增 Hook Script 卡片样式：
  - `.hook-card` - 卡片容器
  - `.hook-textarea` - 代码编辑区样式（等宽字体、深色背景、语法高亮色调）
  - `.toggle-switch` - 开关组件样式（滑动开关动画）
  - `.hook-status` - 保存状态指示器
  - `.hook-actions` - 底部操作栏

#### [MODIFY] [renderer.js](file:///C:/Users/lql/Desktop/WMPFDebugger/renderer/renderer.js)
- 新增 Hook Script 面板交互逻辑：
  - 获取 DOM 元素引用
  - Toggle 开关事件：调用 `api.setHookEnabled()`
  - Save 按钮事件：调用 `api.setHookScript(textarea.value)`，显示保存成功日志
  - Clear 按钮事件：清空 textarea 并调用 `api.setHookScript("")`
  - `init()` 中加载已保存的脚本和启用状态
  - textarea 内容变化时显示 "Unsaved changes" 状态

---

## Verification Plan

### Automated Tests
- 运行 `npm run build:electron` 验证 TypeScript 编译无错误
- 运行 `npm start` 验证应用启动正常

### Manual Verification
1. 验证日志面板文本可以选中和复制（Ctrl+C）
2. 在 Hook Script 面板输入 JavaScript 代码，点击 Save，验证保存成功
3. 关闭并重新打开应用，验证脚本内容持久化
4. 启用 Hook 开关，启动调试服务，验证 CDP 客户端连接时自动注入
5. 验证脚本为空时不执行注入
6. 验证 CDP 客户端断开重连后重新注入


updateAtTime: 2026/3/13 11:39:55

planId: 2de97300-8ee1-4ab2-8fd9-1e060f871482