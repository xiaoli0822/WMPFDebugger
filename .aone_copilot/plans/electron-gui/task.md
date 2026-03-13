### electron-gui ###

# 任务清单

## 1. 项目基础设施搭建

- [x] 1.1 修改 `package.json`：添加 Electron 依赖、scripts 脚本、修改 main 入口
- [x] 1.2 创建 `tsconfig.electron.json`：Electron 专用 TypeScript 编译配置
- [x] 1.3 修改 `.gitignore`：添加 `dist-electron/` 忽略规则

## 2. 核心服务重构

- [x] 2.1 创建 `electron/debugService.ts`：将 `src/index.ts` 的核心逻辑重构为 DebugService 类
  - [x] 2.1.1 实现 `start(config)` 方法：启动 Debug Server + Proxy Server + Frida 注入
  - [x] 2.1.2 实现 `stop()` 方法：优雅关闭所有服务
  - [x] 2.1.3 实现 `getProcesses()` 方法：枚举 WeChatAppEx 进程
  - [x] 2.1.4 实现 `getAvailableVersions()` 方法：扫描 frida/config 目录获取支持版本列表
  - [x] 2.1.5 将所有 console.log 替换为事件发射机制

## 3. Electron 主进程

- [x] 3.1 创建 `electron/main.ts`：Electron 主进程入口
  - [x] 3.1.1 创建 BrowserWindow 窗口配置
  - [x] 3.1.2 注册所有 IPC 事件处理器（start/stop/getProcesses/getVersions/openDevTools）
  - [x] 3.1.3 管理应用生命周期（ready/window-all-closed/activate）
- [x] 3.2 创建 `electron/preload.ts`：Preload 脚本，通过 contextBridge 暴露安全 API

## 4. GUI 渲染进程

- [x] 4.1 创建 `renderer/index.html`：GUI 主页面结构
  - [x] 4.1.1 顶部标题栏（应用名称 + 窗口控制按钮）
  - [x] 4.1.2 状态指示区 + 控制面板（启停按钮、端口配置）
  - [x] 4.1.3 信息面板（WMPF 版本、进程列表表格）
  - [x] 4.1.4 日志面板（实时滚动日志区域）
  - [x] 4.1.5 底部操作栏（打开 DevTools 按钮、刷新进程按钮）
- [x] 4.2 创建 `renderer/styles.css`：现代风格样式
  - [x] 4.2.1 整体布局和配色方案（深色主题 + 蓝紫色调）
  - [x] 4.2.2 状态指示器脉冲动画
  - [x] 4.2.3 按钮交互动画和卡片样式
  - [x] 4.2.4 日志面板样式（等宽字体、多级别颜色）
- [x] 4.3 创建 `renderer/renderer.js`：渲染进程交互逻辑
  - [x] 4.3.1 启动/停止服务交互逻辑
  - [x] 4.3.2 日志实时显示和自动滚动
  - [x] 4.3.3 进程列表刷新和版本检测
  - [x] 4.3.4 端口配置验证和 DevTools 链接打开

## 5. 编译和验证

- [ ] 5.1 安装依赖：`npm install`（需用户手动执行，Electron 包较大）
- [ ] 5.2 执行 TypeScript 编译：`npm run build:electron`
- [ ] 5.3 启动 Electron 应用验证 GUI 显示正常：`npm start`
- [ ] 5.4 验证原有 CLI 模式仍可用：`npx ts-node src/index.ts`


updateAtTime: 2026/3/13 11:10:55

planId: b2d1b65e-deae-4049-9d96-7ef9ebfb8af5