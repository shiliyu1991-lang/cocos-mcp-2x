# cocos-mcp-2x

**English** · [中文](./README.zh-CN.md)

An editor extension that connects an LLM (Claude Desktop / Cursor or any MCP client) to the
**Cocos Creator 2.4.x** editor, letting the model inspect and drive your game project: read/write
nodes, operate on assets and scenes, read the console, and execute scripts.

This is the 2.4.x port of [`cocos-mcp-3x`](https://github.com/shiliyu1991-lang/cocos-mcp-3x) (the Creator 3.8.x version): **the same
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
| `read_console` | Read / clear the log buffer (500-entry ring) — **includes both editor logs and the running game's own logs from the browser preview** |
| `execute_script` | Execute arbitrary JS in the editor main context (`Editor.*`) or scene context (`cc`) |

> **Reading logs? Always use `read_console`.** It returns both editor logs and the running game's
> browser-preview console (`cc.log` / `console.*`); pass `sources=["runtime"]` for game-only,
> `levels=["error"]` for errors. Do **not** use a generic browser-automation tool (e.g.
> claude-in-chrome) to read a Cocos game's console — it can't reach the editor's preview tab.

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
- `read_console` captures logs from the **extension main process** via the `Editor.log` family
  (best-effort); those entries are tagged `source: "editor"`.

### Browser-preview runtime logs (`source: "runtime"`)

The editor process can't see the `cc.log` / `console.*` a game emits in the **browser preview**.
After you enable "浏览器预览日志捕获 / runtime log capture" in the panel, the extension:

1. Starts a lightweight HTTP receiver in the extension process (port = bridge port + 1, default `6021`);
2. Processes the project's preview template (`<project>/preview-templates/`) and injects a reporter
   script that hooks `console.*` (web-side `cc.log` routes through `console`) and forwards each entry
   via `navigator.sendBeacon` into the same ring buffer, tagged `source: "runtime"`.

Template handling is **in-place and non-destructive**:

- If the project **already has** a preview template (`index.html` / `index.ejs` / `index.jade`, in
  that priority), the reporter block is injected — before `</body>` for HTML/EJS, or as a `script.`
  sibling under `body` for jade. The block is fenced with `COCOS-MCP-LOG-START / END` comments.
- If the project has **no** template, a complete standard 2.4 `index.html` is generated (engine
  defaults + reporter block).
- On **disable**, only the fenced block is stripped (your template is preserved byte-for-byte); a
  self-generated template is deleted.

So `read_console` returns editor + browser-runtime logs together. While play-testing use
`read_console(sources=["runtime"])` for game-only logs, and `levels=["error"]` for errors only
(`window.onerror` / `unhandledrejection` are reported too).

Common query filters (`read_console` params):

- `sources=["runtime"]` for game logs; after editing scripts/scenes use `sources=["editor"]` for compile errors.
- `levels=["warn","error"]` for warnings/errors only.
- `contains="S2C_"` (or your app's log prefix) for one protocol/module. Heartbeat noise (`KeepLive` /
  `waiting:false`) dominates — always filter with `contains` when diagnosing.
- `since=<previous nextCursor>` to pull only new entries (good for continuous watching); `count`
  defaults to 50, capped at 500.
- `action="clear"` empties the buffer.

`read_console` is a plain FastMCP tool exposed over stdio or `http://127.0.0.1:8799` with **no
client-specific gating** — Cursor or any other MCP-capable IDE/AI connected to the same server reads
the same logs.

Notes:

- **Enabling requires one editor restart** (Cocos caches the preview template); then preview as "Browser".
- This only affects **preview**, not production builds (`build-templates/`).

### Maintenance note: how an AI "knows" these logs exist

**An AI does not read this README.** Everything it knows about a tool comes from that tool's
`description` (and its params' `Annotated` text) — the string in `@cocos_mcp_tool(description=...)`
inside `server/src/services/tools/<tool>.py`. That is the **only** "manual" an AI reads automatically.

So when an AI "doesn't know it can read web/game logs", the fix is to **edit that tool's
`description`** (front-load the capability, make it imperative), not the README. After editing:

- Tool descriptions register **at Python server start** — you must **Stop Server → Start Server**
  (or restart the editor) for the server to reload them;
- MCP clients (Cursor, etc.) **cache the tool list** — reconnect / refresh tools to pick up the new description.

## Requirements

- Cocos Creator 2.4.x (verified on 2.4.15)
- Python 3.10+

## License

MIT
