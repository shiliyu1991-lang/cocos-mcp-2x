# 更新日志

本项目的所有重要变更都记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-06-27

### 新增

- **浏览器预览运行时日志捕获**：面板新增「浏览器预览日志捕获」开关。开启后扩展会
  - 在扩展进程内起一个轻量 HTTP 接收器（端口 = bridge 端口 + 1，默认 `6021`）；
  - 就地处理项目的预览模板（`<project>/preview-templates/`，按 `index.html` / `index.ejs` / `index.jade` 优先级），注入一段上报脚本，hook `console.*`（web 端 `cc.log` 走 `console`）并经 `navigator.sendBeacon` 把日志回传；
  - 日志落进同一个 500 条环形缓冲、标记 `source: "runtime"`，`read_console` 可同时读到编辑器与浏览器运行时日志。
  - 注入用 `cocos-mcp-2x runtime log reporter` 哨兵注释围栏标记，关闭时仅剥离注入块（不破坏用户自定义模板，可逐字节还原）；仅影响**预览**，不影响正式构建。

### 变更

- **强化 `read_console` 工具描述**：前置说明本工具同时捕获编辑器日志与运行中游戏的网页/预览日志，并明确指引「读 Cocos 游戏日志请用本工具，不要用 claude-in-chrome 等通用浏览器工具」（后者读不到编辑器的预览标签页）。补充 `sources` / `levels` / `contains` / `since` 等过滤用法与「无 runtime 日志时去面板开启捕获」的兜底提示。
- README 增补运行时日志说明、`read_console` 查询过滤技巧，以及「AI 怎么知道有这些日志」的维护备注（工具描述是 AI 唯一的说明入口，改后需重启 server 刷新）。

### 移除

- **移除 psd2prefab 集成**：PSD → 预制体属于独立插件（`cocos-psd-prefab-2x`），不应内置于 MCP 插件。删除 `tools/psd2prefab/` 目录、`main.js` 的 `psd_to_prefab` 处理器与 `panel-convert-psd` IPC、以及面板里的「PSD → 预制体」整栏 UI 与事件绑定。

## [0.3.1]

- 通过受管场景 IPC 持久化节点编辑；资源刷新改为 fire-and-forget。

## [0.3.0]

- cocos-mcp-2x 插件首个版本。
