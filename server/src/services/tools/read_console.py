"""read_console tool — pull recent Editor.log/info/warn/error entries."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp import Context

from services.registry import cocos_mcp_tool
from services.tools._common import call_bridge


@cocos_mcp_tool(
    description=(
        "Read or clear the captured Cocos Creator editor console. The "
        "extension keeps a 500-entry ring buffer of Editor.log/info/warn/"
        "error lines from the extension process. After modifying scripts/"
        "scenes, call this to look for compile errors or runtime warnings."
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
    if contains is not None:
        params["contains"] = contains
    if count is not None:
        params["count"] = int(count)
    if since is not None:
        params["since"] = int(since)
    return await call_bridge("read_console", params)
