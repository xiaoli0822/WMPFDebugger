# WMPFDebugger TODO

## 今日执行

- [x] T-001 新增根目录 TODO 看板，用于持续记录本轮和后续优化。
- [x] T-002 增加日志级别筛选、关键词搜索、复制当前日志能力。
- [x] T-003 renderer 内维护日志状态数组，日志 DOM 仅负责渲染。
- [x] T-004 收敛文本类 `innerHTML`，固定 SVG 模板不拼接用户输入。
- [x] T-005 删除 Hook 插件前增加中文确认，避免误删。
- [x] T-006 完善 GUI 错误中文映射，覆盖 CLI、Frida、Hook 常见错误。
- [x] T-007 中文化 CLI 可见错误和日志，与 GUI 口径保持一致。
- [x] T-008 增加插件搜索和按启用状态筛选。
- [x] T-009 增加 Hook 插件配置导出 / 导入功能。
- [x] T-010 拆分 renderer 日志、插件、流程状态模块，降低单文件复杂度。
- [x] T-011 为日志筛选和插件删除确认补充轻量自动化测试。
- [x] T-012 修复小程序后端重启后 Hook 注入状态不重置的问题，并增加当前页面即时注入。
- [x] T-013 为 WASM / 内存 Hook 插件补充“幂等写法”示例和故障排查文档。

## 待手工验收

- [ ] V-005 GUI 手工验证：日志筛选、搜索、清空、复制、插件删除确认、插件配置导入导出。
- [ ] V-006 真实 WMPF 进程验证：启用 WASM / 内存类 Hook 插件后，后端断开 / 重启小程序会重新注入，并出现“已在当前页面即时执行”和“已注册 ... 新文档注入”日志。

## 已完成验证

- [x] V-001 `node --check renderer\renderer.js`，通过。
- [x] V-002 `node --check renderer\modules\logs.js`、`renderer\modules\plugins.js`、`renderer\modules\workflow.js`，通过。
- [x] V-003 `node --check frida\hook.js`，通过。
- [x] V-004 `cmd /c npm test`，通过。
- [x] V-007 `cmd /c npm run build`，通过。

## 风险记录

- R-001 当前工作区已有历史未提交改动，本轮仅叠加相关文件，不回退既有状态。
- R-002 复制日志优先使用 Clipboard API，失败时回退到临时 `textarea` + `execCommand("copy")`。
- R-003 固定 SVG 图标仍使用静态模板创建，禁止拼接用户输入。
- R-004 Hook 禁用或删除无法撤销当前页面已经执行过的 monkey patch；需要刷新或重开目标页面才能彻底清理运行时副作用。
- R-005 导入 Hook 插件配置会以导入文件中的插件列表替换当前列表，导入前建议先导出现有配置做备份。
