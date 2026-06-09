# Cocos MCP (2.4.x) — 安装与分发说明

把 LLM（Claude Desktop / Cursor 等 MCP 客户端）接入 Cocos Creator 2.4.x 编辑器的插件。
插件**自包含**：Python MCP 服务器就在插件目录内的 `./server`。

这是 `cocos-mcp-3x`（3.8.x 版）的 2.4.x 移植版，Python 服务器与 WebSocket 协议完全相同，
差异只在编辑器侧的 2.4 扩展 API（详见 README）。

## 目录结构

```
cocos-mcp-2x/
├── main.js            扩展主进程（WebSocket 客户端 + 命令处理）
├── scene.js           场景脚本（场景进程，用 cc 引擎操作节点）
├── panel/index.js     面板 UI（启动服务器 / 连接）
├── package.json
└── server/            内置的 Python MCP 服务器
    ├── src/           入口 main.py、tools 等
    ├── pyproject.toml
    └── .venv/         Python 虚拟环境（本机生成，见下方说明）
```

## 安装到项目

把整个 `cocos-mcp-2x` 文件夹放到 Cocos 2.x 项目的 `packages/` 目录下（注意：2.x 是 `packages`，
3.x 才是 `extensions`）：

```
<你的项目>/packages/cocos-mcp-2x/
```

> 开发时也可以用目录链接（junction）指向插件源码，改动即时生效：
> `mklink /J "<项目>\packages\cocos-mcp-2x" "<插件源码路径>"`

重启编辑器（或「扩展 → 刷新」）后，菜单里会出现 **Cocos MCP → Open Panel**。

## 首次使用：创建 Python 环境

需要本机安装 **Python 3.10+**。在插件的 `server` 目录里创建虚拟环境并安装依赖：

```bat
cd <插件>\server
python -m venv .venv
.venv\Scripts\python -m pip install -e .
```

> **国内网络**：直连 pypi.org 装依赖经常超时，请加镜像：
> `.venv\Scripts\python -m pip install -e . -i https://pypi.tuna.tsinghua.edu.cn/simple`

> 面板在检测不到 `python.exe` 时，会在提示行直接给出上面这条命令（venv 那条，镜像需自行追加）。

## 在面板里使用

1. 打开面板：菜单 **Cocos MCP → Open Panel**。
2. **Server dir** 留空 = 使用插件自带的 `./server`（推荐）。
   只有当服务器在别处时，才在这里填绝对路径覆盖；该值会全局持久化（`Editor.Profile`），清空即恢复默认。
3. 点 **Start Server**，提示行显示 `python: found` 即就绪。
4. 点 **Connect**。绿点亮起表示 WebSocket 桥已连通。

服务器在 `127.0.0.1:6020/cocosmcp` 开 WebSocket 桥，编辑器扩展作为客户端连入。

## 分发给别人

把整个 `cocos-mcp-2x` 拷给对方即可，但**不要包含 `server/.venv`**：

- `.venv` 里的 `pyvenv.cfg` 写死了**你这台机器**的 Python 路径，换机无法运行；
- 体积大。

`.gitignore` 已排除 `server/.venv` 与 `__pycache__`。对方拿到后，按上面「首次使用」一步创建自己的
`.venv` 即可，需本机有 Python 3.10+。
