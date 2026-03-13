### multi-plugin-hook-system ###

# 多插件 Hook 注入系统 - 任务清单

## 1. HookManager 重构
- [x] 重写 `electron/hookManager.ts`：多插件数据模型 + CRUD 方法 + 文件导入 + 合并脚本

## 2. DebugService 适配
- [x] 修改 `electron/debugService.ts`：替换旧 hook API 为多插件 API
- [x] 修改 `electron/debugService.ts`：更新 `performHookInjection()` 使用合并脚本

## 3. IPC 通道重构
- [x] 修改 `electron/main.ts`：替换旧 IPC handlers 为多插件 handlers（含文件选择器）
- [x] 修改 `electron/preload.ts`：更新 DebuggerAPI 接口和 contextBridge

## 4. UI 界面重构
- [x] 修改 `renderer/index.html`：替换 Hook Script 卡片为 Hook Plugins 插件管理面板
- [x] 修改 `renderer/styles.css`：替换旧样式为插件列表样式
- [x] 修改 `renderer/renderer.js`：实现插件管理交互逻辑（列表渲染、CRUD、展开收起）

## 5. 编译验证
- [x] 运行 `npm run build:electron` 验证编译无错误
- [ ] 运行 `npm start` 验证应用启动和功能正常（需用户手动验证）


updateAtTime: 2026/3/13 13:46:13

planId: 2de97300-8ee1-4ab2-8fd9-1e060f871482