# cocos-mcp-2x

[English](./README.md) · **中文**

把 LLM（Claude Desktop / Cursor 等 MCP 客户端）接入 **Cocos Creator 2.4.x** 编辑器的插件，
让大模型能够检视并驱动你的游戏工程：读写节点、操作资源与场景、查看控制台、执行脚本。

它是 [`cocos-mcp-3x`](https://github.com/shiliyu1991-lang/cocos-mcp-3x)（Creator 3.8.x 版）的 2.4.x 移植版：**相同的 Python MCP 服务器与
WebSocket 协议**，差异只在编辑器侧调用的 2.4 扩展 API。插件**自包含**：Python MCP 服务器就打包在
插件目录内的 `./server`，扩展本身**无任何 npm 依赖、无构建步骤**。

> 在 Cocos Creator 2.4.15 上开发验证；理论上适配整个 2.4.x（含 2.4.9）。

## 工作原理

```
MCP 客户端 (Claude / Cursor)
        │  stdio / http
        ▼
Python FastMCP 服务器  ── server/src/main.py
        │  WebSocket 桥  127.0.0.1:6020/cocosmcp
        ▼
Cocos Creator 扩展     ── main.js（作为 WS 客户端连入）
        │
        ├─ Editor.assetdb / Editor.Ipc        资源、场景开关
        └─ Editor.Scene.callSceneScript ──► scene.js（场景进程，持有引擎 cc 运行时）
```

- Python 端是 WebSocket **服务端**，Cocos 扩展是**客户端**，由面板上的 *Connect* 按钮主动连入。
- 每个工具调用都通过桥发一个 JSON 信封到扩展（`main.js`），扩展按命令名分发：资源类用
  `Editor.assetdb`，节点/场景图类转发给场景脚本 `scene.js`（在场景进程里用 `cc` 引擎直接操作），
  执行完回传 `{id, success, data|error}`。

### 与 3.x 版的差异

| 关注点 | cocos-mcp-3x (3.8.x) | cocos-mcp-2x (2.4.x) |
| --- | --- | --- |
| 资源 API | `Editor.Message.request('asset-db', …)`（Promise） | `Editor.assetdb.*`（回调） |
| 场景图操作 | `Editor.Message.request('scene', …)` | `Editor.Scene.callSceneScript()` → `scene.js` |
| 控制台捕获 | hook `console.*` | hook `Editor.log/warn/error` 家族 |
| 扩展入口 | `exports.methods`（3.x） | `module.exports = { load, unload, messages }`（2.4） |
| 场景文件 | `.scene` | `.fire` |

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `get_project_info` | 工程路径、assets 根、编辑器版本、场景列表、可用桥命令 |
| `manage_scene` | 列出 / 打开 / 保存 / 当前场景（Cocos 2.x `.fire`） |
| `manage_node` | 检视或修改当前场景中的节点（多数操作按 `uuid`） |
| `manage_asset` | 通过 asset-db 检视和操作 `assets/` 下的资源 |
| `read_console` | 读取 / 清空日志缓冲（500 条环形）——**同时含编辑器日志和浏览器预览里游戏自己的运行时日志** |
| `execute_script` | 在编辑器主上下文（`Editor.*`）或场景上下文（`cc`）执行任意 JS |

> `manage_node.set_property` 的 `property` 可以是节点级变换（如 `position`、`angle`、`active`、
> `color`），也可以是组件限定路径（如 `cc.Label.string`、`cc.Sprite.enabled`）。资源型属性
> （如 spriteFrame）请用 `execute_script` 在场景上下文里设置。

## 安装到项目

把整个 `cocos-mcp-2x` 文件夹放到 Cocos 项目的 `packages/` 目录下（2.x 扩展目录是 `packages`，
不是 3.x 的 `extensions`）：

```
<你的项目>/packages/cocos-mcp-2x/
```

> 开发时也可以用目录链接（junction）指向插件源码，改动即时生效：
> `mklink /J "<项目>\packages\cocos-mcp-2x" "<插件源码路径>"`

重启编辑器（或在「扩展 → 刷新」后），菜单栏会出现 **Cocos MCP → Open Panel**。

## 首次使用：创建 Python 环境

需要本机安装 **Python 3.10+**。在插件的 `server` 目录里创建虚拟环境并安装依赖：

```bat
cd cocos-mcp-2x\server
python -m venv .venv
.venv\Scripts\python -m pip install -e .
```

> **国内网络注意**：直连 `pypi.org` 装依赖经常超时。请加国内镜像：
>
> ```bat
> .venv\Scripts\python -m pip install -e . -i https://pypi.tuna.tsinghua.edu.cn/simple
> ```
>
> （清华源，也可换阿里 `https://mirrors.aliyun.com/pypi/simple`。）

> `.venv` **不随仓库分发**（`pyvenv.cfg` 写死了本机 Python 路径，且体积大）。
> 拿到插件后各自按此步骤创建即可。面板在检测不到 `python.exe` 时也会直接给出这条命令。

依赖：`fastmcp>=2.0.0`、`websockets>=12.0`（已在 Python 3.10–3.14 上验证可装）。

## 在面板里使用

1. 打开面板：菜单 **Cocos MCP → Open Panel**。
2. **Server dir** 留空 = 使用插件自带的 `./server`（推荐）。
3. 点 **Start Server**，提示行显示 `python: found` 即就绪。
4. 点 **Connect**，绿点亮起表示 WebSocket 桥已连通。

## 配置 MCP 客户端

服务器入口为 `server/src/main.py`，支持 `stdio`（客户端默认）与 `http`（手动测试）两种传输：

```bash
cd cocos-mcp-2x/server/src
python -m main --transport stdio                    # Claude Desktop / Cursor
python -m main --transport http --http-port 8765    # 手动测试
```

环境变量（优先级 CLI 参数 > 环境变量 > 默认值）：

| 变量 | 默认值 |
| --- | --- |
| `COCOS_MCP_BRIDGE_HOST` | `127.0.0.1` |
| `COCOS_MCP_BRIDGE_PORT` | `6020` |
| `COCOS_MCP_BRIDGE_PATH` | `/cocosmcp` |
| `COCOS_MCP_REQUEST_TIMEOUT` | `30`（秒） |
| `COCOS_MCP_CONNECT_TIMEOUT` | `5`（秒） |

## 常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| 面板里 **python: NOT FOUND** | `server\.venv` 还没建。按上面「首次使用」创建虚拟环境即可；面板每 1.5 秒自动重新检测。 |
| `pip install` 一直 **超时 / Read timed out** | 直连 pypi.org 不通。加国内镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple`（见上）。 |
| 点 Start Server 后报 **端口被占用 / 没监听** | 改 **Bridge port**（默认 6020）或 **HTTP port**（默认 8799）换一个空闲端口，再 Start。Server URL 会自动跟随 Bridge port。 |
| 分不清两个端口 | **Bridge port** 是扩展↔Python 服务器的内部 WebSocket 通道；**HTTP port** 才是 MCP 客户端要连的地址（`http://127.0.0.1:8799/mcp/`）。 |
| Connect 点了不亮绿点 | 先确认 Start Server 已 running；再确认 Connect 用的 Bridge port 和 Start 时一致。 |
| 菜单里找不到 **Cocos MCP** | 确认插件放在项目的 `packages/`（不是 3.x 的 `extensions/`），并在「扩展 → 刷新」或重启编辑器。 |

## 目录结构

```
cocos-mcp-2x/
├── main.js            扩展主进程（WebSocket 客户端 + 命令处理 + 服务器生命周期）
├── scene.js           场景脚本（在场景进程里用 cc 引擎操作节点）
├── panel/index.js     面板 UI（启动服务器 / 连接）
├── package.json       2.4 扩展清单（main / scene-script / main-menu / panel）
├── SETUP.md           安装与分发详细说明
└── server/            内置的 Python MCP 服务器（与 3.x 版同源）
    ├── src/           入口 main.py、core/transport/services/utils
    ├── pyproject.toml
    └── .venv/         Python 虚拟环境（本机生成，不入库）
```

## 已知限制

- **节点编辑（create / delete / add_component / set_property）走编辑器受管命令**
  `Editor.Ipc.sendToPanel('scene', 'scene:…')`，会进 Undo 历史并标脏，`manage_scene save` 后正常落盘。
  **前提是已打开一个场景**（场景面板需处于加载状态）；没有打开场景时这些操作会直接报错。
  `scene.js` 仅做只读查询（tree/get/current）。
- `manage_asset refresh` 是 **fire-and-forget**：立即返回 `{refreshing:true}`，刷新/重编译在后台进行，
  用 `read_console` 或重新查询确认完成。
- `manage_scene open` 通过 `scene:open-by-uuid` 触发，异步切换场景。
- `read_console` 默认捕获的是**扩展主进程**经由 `Editor.log` 家族输出的日志（尽力而为），这些条目 `source: "editor"`。

### 浏览器预览运行时日志（`source: "runtime"`）

编辑器进程看不到游戏在**浏览器预览**里跑出来的 `cc.log` / `console.*`。面板「浏览器预览日志捕获」
开启后会：

1. 在扩展进程内起一个轻量 HTTP 接收器（端口 = bridge 端口 + 1，默认 `6021`）；
2. 处理项目的预览模板（`<project>/preview-templates/`），插入一段上报脚本。该脚本 hook
   `console.*`（web 端 `cc.log` 会走 `console`）并通过 `navigator.sendBeacon` 把每条日志回传给接收器，
   落进同一个环形缓冲、标记 `source: "runtime"`。

模板处理是**就地注入、不破坏你的自定义模板**：

- 若项目**已有**预览模板（`index.html` / `index.ejs` / `index.jade`，按此优先级），就把上报块
  注入进去——HTML/EJS 插在 `</body>` 前，jade 作为 `body` 下的一个 `script.` 兄弟块追加。
  注入块用 `COCOS-MCP-LOG-START / END` 注释围栏标记。
- 若项目**没有**模板，才生成一个完整的标准 2.4 `index.html`（含引擎默认脚本 + 上报块）。
- **关闭**时只把围栏内的注入块剥离（你的模板原样保留，可逐字节还原）；自己生成的那份则删除。

于是 `read_console` 能同时读到编辑器与浏览器运行时日志；play-test 时用 `read_console(sources=["runtime"])`
只看游戏自己的日志，用 `levels=["error"]` 只看报错（`window.onerror` / `unhandledrejection` 也会上报）。

常用查询过滤（`read_console` 参数）：

- `sources=["runtime"]` 看游戏日志；改完脚本/场景后用 `sources=["editor"]` 查编译报错。
- `levels=["warn","error"]` 只看告警/报错。
- `contains="S2C_"`（或你 App 的日志前缀）只看某协议/模块。心跳噪音（`KeepLive` / `waiting:false`）很多，排查时务必配合 `contains` 过滤。
- `since=<上次返回的 nextCursor>` 只拉新增条目，适合连续盯盘；`count` 默认 50、上限 500。
- `action="clear"` 清空缓冲。

`read_console` 是注册在 FastMCP 上的普通 MCP 工具，经 stdio 或 `http://127.0.0.1:8799` 暴露，**不做任何「只认某个客户端」的校验**——Cursor 或其它支持 MCP 的 IDE/AI 连上同一个 server 都能照样读到这些日志。

注意：

- **开启后需重启一次 Cocos Creator**（编辑器会缓存预览模板），之后预览时选「Browser」运行。
- 该处理仅作用于**预览**，不影响正式构建（`build-templates/`）。

### 维护备注：AI 怎么「知道」有这些日志

**AI 不读本 README**——它对每个工具的全部认知，来自该工具的 `description`（以及参数的 `Annotated` 说明）。也就是 `server/src/services/tools/<工具>.py` 里 `@cocos_mcp_tool(description=...)` 那段文本，**这是 AI 唯一会自动读到的「说明书」**。

所以当出现「AI 不知道能看网页/游戏日志」这类问题时，正确的修法是**改对应工具的 `description`**（把能力前置、写成指令式），而不是改 README。改完后：

- 工具描述在 **Python server 启动时注册**，必须 **Stop Server → Start Server**（或重启编辑器）让 server 重新加载；
- MCP 客户端（Cursor 等）会**缓存工具列表**，需**重新连接 / 刷新工具**才能拿到新描述。

## 环境要求

- Cocos Creator 2.4.x（在 2.4.15 上验证）
- Python 3.10+

## License

MIT
