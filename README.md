# cocos-mcp-2x

**English** · [中文](./README.zh-CN.md)

An editor extension that connects an LLM (Claude Desktop / Cursor or any MCP client) to the
**Cocos Creator 2.4.x** editor, letting the model inspect and drive your game project: read/write
nodes, operate on assets and scenes, read the console, and execute scripts.

This is the 2.4.x port of [`cocos-mcp-3x`](../cocos-mcp-3x) (the Creator 3.8.x version): **the same
Python MCP server and WebSocket protocol**, differing only in the 2.4 editor APIs the extension side
calls. The plugin is **self-contained** — the Python MCP server is bundled at `./server` — and the
extension has **no npm dependencies and no build step**.

> Developed and verified against Cocos Creator 2.4.15; targets the whole 2.4.x line (incl. 2.4.9).

## How it works

```
MCP client (Claude / Cursor)
        │  stdio / http
        ▼
Python FastMCP server  ── server/src/main.py
        │  WebSocket bridge  127.0.0.1:6020/cocosmcp
        ▼
Cocos Creator extension ── main.js (connects in as the WS client)
        │
        ├─ Editor.assetdb / Editor.Ipc         assets, scene open/save
        └─ Editor.Scene.callSceneScript ──► scene.js (scene process, holds the cc engine runtime)
```

- The Python side is the WebSocket **server**; the Cocos extension is the **client** and dials in
  via the *Connect* button on the panel.
- Each tool call sends a JSON envelope to the extension (`main.js`), which dispatches by command
  name: asset operations use `Editor.assetdb`; node/scene-graph operations are forwarded to the
  scene script `scene.js` (which mutates the live graph through the `cc` engine in the scene
  process), then replies `{id, success, data|error}`.

### Differences from the 3.x version

| Concern | cocos-mcp-3x (3.8.x) | cocos-mcp-2x (2.4.x) |
| --- | --- | --- |
| Asset API | `Editor.Message.request('asset-db', …)` (Promise) | `Editor.assetdb.*` (callbacks) |
| Scene-graph ops | `Editor.Message.request('scene', …)` | `Editor.Scene.callSceneScript()` → `scene.js` |
| Console capture | hook `console.*` | hook the `Editor.log/warn/error` family |
| Extension entry | `exports.methods` (3.x) | `module.exports = { load, unload, messages }` (2.4) |
| Scene files | `.scene` | `.fire` |

## Tools provided

| Tool | Purpose |
| --- | --- |
| `get_project_info` | Project path, assets root, editor version, scene list, available bridge commands |
| `manage_scene` | List / open / save / current scene (Cocos 2.x `.fire`) |
| `manage_node` | Inspect or modify nodes in the current scene (mostly by `uuid`) |
| `manage_asset` | Inspect and manipulate assets under `assets/` via the asset-db |
| `read_console` | Read / clear the editor console (500-entry ring buffer) |
| `execute_script` | Execute arbitrary JS in the editor main context (`Editor.*`) or scene context (`cc`) |

> `manage_node.set_property`'s `property` may be a node-level transform (`position`, `angle`,
> `active`, `color`) or a component-qualified path (`cc.Label.string`, `cc.Sprite.enabled`). For
> asset-typed properties (e.g. spriteFrame), set them via `execute_script` in the scene context.

## Install into a project

Drop the whole `cocos-mcp-2x` folder into your Cocos project's `packages/` directory (the 2.x
extension folder is `packages`, not 3.x's `extensions`):

```
<your-project>/packages/cocos-mcp-2x/
```

> During development you can use a directory junction pointing at the plugin source:
> `mklink /J "<project>\packages\cocos-mcp-2x" "<plugin-source-path>"`

After restarting the editor (or Extension → Refresh), **Cocos MCP → Open Panel** appears in the menu.

## First run: create the Python environment

Requires **Python 3.10+**. Create a virtual environment inside the plugin's `server` directory:

```bat
cd cocos-mcp-2x\server
python -m venv .venv
.venv\Scripts\python -m pip install -e .
```

> **Behind a slow/blocked PyPI** (e.g. in mainland China), the install often times out. Add a mirror:
>
> ```bat
> .venv\Scripts\python -m pip install -e . -i https://pypi.tuna.tsinghua.edu.cn/simple
> ```

> `.venv` is **not distributed with the repo** (its `pyvenv.cfg` hardcodes the local Python path and
> it is large). Recreate it locally — the panel also surfaces this exact command when it can't find
> `python.exe`.

Dependencies: `fastmcp>=2.0.0`, `websockets>=12.0` (verified installable on Python 3.10–3.14).

## Using the panel

1. Open the panel: menu **Cocos MCP → Open Panel**.
2. **Server dir** empty = use the plugin's bundled `./server` (recommended).
3. Click **Start Server**; the hint line showing `python: found` means it's ready.
4. Click **Connect**; a green dot means the WebSocket bridge is connected.

## Configure the MCP client

The server entry point is `server/src/main.py`, supporting `stdio` (client default) and `http`:

```bash
cd cocos-mcp-2x/server/src
python -m main --transport stdio                    # Claude Desktop / Cursor
python -m main --transport http --http-port 8765    # manual testing
```

Environment variables (precedence: CLI args > env vars > defaults):

| Variable | Default |
| --- | --- |
| `COCOS_MCP_BRIDGE_HOST` | `127.0.0.1` |
| `COCOS_MCP_BRIDGE_PORT` | `6020` |
| `COCOS_MCP_BRIDGE_PATH` | `/cocosmcp` |
| `COCOS_MCP_REQUEST_TIMEOUT` | `30` (seconds) |
| `COCOS_MCP_CONNECT_TIMEOUT` | `5` (seconds) |

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Panel shows **python: NOT FOUND** | `server\.venv` isn't created yet. Run the "first run" venv steps above; the panel re-checks every 1.5s. |
| `pip install` keeps **timing out** | PyPI unreachable. Add a mirror, e.g. `-i https://pypi.tuna.tsinghua.edu.cn/simple`. |
| Start Server says **port in use / not listening** | Change **Bridge port** (default 6020) or **HTTP port** (default 8799) to a free port, then Start. Server URL follows the Bridge port automatically. |
| Confused by the two ports | **Bridge port** is the internal WebSocket channel (extension ↔ Python server); **HTTP port** is what the MCP client connects to (`http://127.0.0.1:8799/mcp/`). |
| Connect won't turn green | Make sure Start Server is running, and Connect uses the same Bridge port you started with. |
| No **Cocos MCP** menu | Ensure the plugin is under the project's `packages/` (not 3.x's `extensions/`), then Extension → Refresh or restart the editor. |

## Directory layout

```
cocos-mcp-2x/
├── main.js            Extension main process (WS client + command handlers + server lifecycle)
├── scene.js           Scene script (mutates nodes via the cc engine in the scene process)
├── panel/index.js     Panel UI (start server / connect)
├── package.json       2.4 extension manifest (main / scene-script / main-menu / panel)
├── SETUP.md           Detailed install & distribution notes
└── server/            Bundled Python MCP server (same source as the 3.x version)
    ├── src/           Entry main.py; core/transport/services/utils
    ├── pyproject.toml
    └── .venv/         Python virtual environment (generated locally, not committed)
```

## Known limitations

- **Node edits (create / delete / add_component / set_property) go through the editor-managed
  commands** `Editor.Ipc.sendToPanel('scene', 'scene:…')`, so they enter the Undo history, mark the
  scene dirty, and persist on `manage_scene save`. This **requires an open scene** (the scene panel
  must be loaded); with no scene open these actions error. `scene.js` only does read-only queries.
- `manage_asset refresh` is **fire-and-forget**: it returns `{refreshing:true}` immediately while the
  reimport/recompile runs in the background — confirm completion via `read_console` or a re-query.
- `manage_scene open` triggers `scene:open-by-uuid` and switches scene asynchronously.
- `read_console` captures logs emitted by the **extension main process** via the `Editor.log`
  family (best-effort).

## Requirements

- Cocos Creator 2.4.x (verified on 2.4.15)
- Python 3.10+

## License

MIT
