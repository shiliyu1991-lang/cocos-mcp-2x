# cocos-mcp-2x

**中文** · [English](./README.en.md)

把 LLM（Claude Desktop / Cursor 等 MCP 客户端）接入 **Cocos Creator 2.4.x** 编辑器的插件，
让大模型能够检视并驱动你的游戏工程：读写节点、操作资源与场景、查看控制台、执行脚本。

它是 [`cocos-mcp-3x`](../cocos-mcp-3x)（Creator 3.8.x 版）的 2.4.x 移植版：**相同的 Python MCP 服务器与
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
| `read_console` | 读取 / 清空编辑器控制台（500 条环形缓冲） |
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

- **节点编辑通过 `scene.js` 直接调用 `cc` 引擎完成**，会在保存场景时持久化，但可能不进入编辑器的
  撤销（Undo）历史。复杂改动建议保存前在编辑器里核对。
- `manage_scene` 的 `open` / `save` 通过 2.x 场景模块的 IPC 消息触发（`scene:open-by-uuid` /
  `scene:save-scene`），是异步的。
- `read_console` 捕获的是**扩展主进程**经由 `Editor.log` 家族输出的日志（尽力而为）。

## 环境要求

- Cocos Creator 2.4.x（在 2.4.15 上验证）
- Python 3.10+

## License

MIT
