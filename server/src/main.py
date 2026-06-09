"""
cocos-mcp server entrypoint.

Boots a FastMCP server that exposes a small set of tools backed by a
WebSocket bridge. The Python side hosts the WS server; the Cocos Creator
2.4.x editor extension (`cocos-mcp-2x/` in this repo) dials in as a client.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from typing import Any

# Make `typing` names visible to runtime annotation evaluation in case the
# environment evaluates string annotations against an empty globals dict.
try:
    import builtins
    import typing as _typing

    for _name in ("Annotated", "Literal", "Any", "Optional", "Union"):
        if not hasattr(builtins, _name) and hasattr(_typing, _name):
            setattr(builtins, _name, getattr(_typing, _name))
except Exception:
    pass

# Windows: prefer SelectorEventLoop for websockets compatibility.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastmcp import FastMCP  # noqa: E402  (after sys.path/asyncio tweaks)

from core.config import config  # noqa: E402
from transport.ws_client import CocosBridge, set_global_bridge  # noqa: E402
from services.tools import register_all_tools  # noqa: E402


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("cocos-mcp")


INSTRUCTIONS = """
This server controls a Cocos Creator 2.4.x editor through a small WebSocket
bridge that runs as an editor extension. The Python side hosts a WS server;
the Cocos extension connects to it from its panel.

What you can do:
- get_project_info       — sanity-check the bridge & inspect project metadata
- read_console           — pull recent console.log/info/warn/error entries
- manage_asset           — list/info/read/create/delete/refresh assets
- manage_scene           — list/open/save/current scene (.fire)
- manage_node            — query/create/edit/delete nodes in the open scene
- execute_script         — run a JS snippet (powerful escape hatch — ASK USER)

Conventions:
- Asset urls follow Cocos's `db://assets/...` scheme. `manage_asset.read`
  is limited to small text-ish files (<1MB).
- Scene-graph mutations only work when a scene is open in the editor.
- Nodes, components and assets are addressed by `uuid`. Use manage_scene
  `current` / manage_node `tree` to discover uuids first.
- `execute_script` runs arbitrary JS; treat it as requiring explicit user
  permission. Prefer the typed tools whenever they cover the use case.

Debugging:
- If a tool returns "bridge unavailable", the Cocos extension hasn't dialed
  in to the Python bridge yet. In the editor: open the Cocos MCP panel and
  click Connect (URL defaults to ws://127.0.0.1:6020/cocosmcp).
- Use read_console after script edits to spot compile errors.
"""


def build_server() -> FastMCP:
    mcp = FastMCP(name="cocos-mcp-2x", instructions=INSTRUCTIONS)
    register_all_tools(mcp)
    return mcp


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="cocos-mcp-2x",
        description="MCP server for Cocos Creator 2.4.x",
    )
    p.add_argument("--bridge-host", default=None,
                   help="Host the Python WS bridge listens on for the Cocos "
                        "extension to dial in. Default 127.0.0.1.")
    p.add_argument("--bridge-port", type=int, default=None,
                   help="Port the Python WS bridge listens on. Default 6020.")
    p.add_argument("--transport", choices=["stdio", "http"], default="stdio",
                   help="MCP transport (default stdio for Claude Desktop / Claude Code).")
    p.add_argument("--http-host", default="127.0.0.1")
    p.add_argument("--http-port", type=int, default=8765)
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv if argv is not None else sys.argv[1:])

    if args.bridge_host:
        config.bridge_host = args.bridge_host
    if args.bridge_port:
        config.bridge_port = args.bridge_port

    logger.info("cocos-mcp v%s starting", config.version)
    logger.info("bridge will listen on ws://%s:%d%s (waiting for Cocos to dial in)",
                config.bridge_host, config.bridge_port, config.bridge_path)

    bridge = CocosBridge(host=config.bridge_host, port=config.bridge_port)
    try:
        bridge.start_in_thread()
    except Exception:
        logger.exception("failed to start cocos bridge (port already in use?)")
        raise
    set_global_bridge(bridge)

    server = build_server()

    if args.transport == "http":
        logger.info("starting MCP HTTP transport on %s:%d",
                    args.http_host, args.http_port)
        server.run(transport="http", host=args.http_host, port=args.http_port)
    else:
        logger.info("starting MCP stdio transport")
        server.run(transport="stdio")


if __name__ == "__main__":
    main()
