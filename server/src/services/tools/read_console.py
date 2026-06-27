"""read_console tool — pull recent Editor.log/info/warn/error entries."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp import Context

from services.registry import cocos_mcp_tool
from services.tools._common import call_bridge


@cocos_mcp_tool(
    description=(
        "READ THE COCOS GAME'S WEB/BROWSER-PREVIEW CONSOLE LOGS (网页日志/网页上"
        "的日志/游戏日志) — THIS is the correct tool for that, NOT a generic "
        "browser-automation tool. Do NOT use claude-in-chrome or any 'open a "
        "tab and read console' browser tool to read a Cocos game's logs: those "
        "can only see tabs they themselves opened and cannot reach the editor's "
        "preview tab. The Cocos extension already forwards the running game's "
        "console here, so just call this tool.\n"
        "Read (or clear) the Cocos Creator log buffer. THIS TOOL CAPTURES BOTH "
        "EDITOR LOGS AND THE RUNNING GAME'S OWN LOGS — use it whenever the user "
        "asks to see logs / console / 看日志 / 网页日志, including the game's logs "
        "printed in the browser/web preview. The 500-entry ring buffer has two sources, "
        "tagged per entry by a 'source' field:\n"
        "  - 'editor'  = Editor.log/info/warn/error from the extension process "
        "(use after editing scripts/scenes to find compile errors).\n"
        "  - 'runtime' = cc.log/console.* (and window.onerror) from the GAME "
        "running in the BROWSER preview, forwarded by an injected reporter. THIS "
        "IS THE 'web page' / in-game log the user usually means.\n"
        "By default BOTH sources are returned, so a plain call already includes "
        "game logs. To watch only the game, pass sources=['runtime']; for only "
        "errors add levels=['warn','error']; filter noise with contains=... "
        "(heartbeats like 'KeepLive' dominate); page through new entries with "
        "since=<previous nextCursor>.\n"
        "IMPORTANT: if the user wants the game's logs but you get NO 'runtime' "
        "entries, the capture is off — tell them to enable '浏览器预览日志捕获 / "
        "runtime log capture' in the Cocos MCP panel, restart the editor once, "
        "and run the preview as 'Browser' (not the in-editor Simulator)."
    ),
)
async def read_console(
    ctx: Context,
    action: Annotated[
        Literal["get", "clear"],
        "Action — 'get' returns entries, 'clear' empties the buffer.",
    ] = "get",
    levels: Annotated[
        list[Literal["log", "info", "warn", "error"]] | None,
        "Filter by log level. Defaults to all levels.",
    ] = None,
    sources: Annotated[
        list[Literal["editor", "runtime"]] | None,
        "Filter by origin — 'editor' (extension process) or 'runtime' "
        "(the GAME's own logs from the browser/web preview). Defaults to BOTH, "
        "so leave unset to include game logs; pass ['runtime'] for game-only.",
    ] = None,
    contains: Annotated[
        str | None,
        "Only return entries whose message contains this substring.",
    ] = None,
    count: Annotated[
        int,
        "Max entries returned (clamped to 500). Default 50.",
    ] = 50,
    since: Annotated[
        int | None,
        "Sequence cursor from a previous response (returns only newer entries).",
    ] = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"action": action}
    if levels is not None:
        params["levels"] = levels
    if sources is not None:
        params["sources"] = sources
    if contains is not None:
        params["contains"] = contains
    if count is not None:
        params["count"] = int(count)
    if since is not None:
        params["since"] = int(since)
    return await call_bridge("read_console", params)
