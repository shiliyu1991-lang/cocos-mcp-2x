"""execute_script tool — escape hatch that runs arbitrary JS in the editor."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp import Context

from services.registry import cocos_mcp_tool
from services.tools._common import call_bridge


@cocos_mcp_tool(
    description=(
        "EXECUTE ARBITRARY JAVASCRIPT inside the Cocos Creator editor. "
        "This is a powerful primitive — prefer the typed tools when they "
        "cover the use case, and ask the user before calling this for "
        "anything destructive.\n\n"
        "Targets:\n"
        "  main   - runs in the extension's main process. Has Editor.* APIs "
        "(Editor.Message, Editor.Project, ...) but NOT cc / live scene.\n"
        "  scene  - runs in the scene context. Has cc, director, and the active "
        "scene via `director.getScene()`. Use this to walk/edit nodes live.\n\n"
        "Snippets are wrapped as `(async () => { <code> })()`. The return "
        "value of that async IIFE is sent back as the tool's `data.value` "
        "(must be JSON-serializable; otherwise we coerce to a string)."
    ),
)
async def execute_script(
    ctx: Context,
    code: Annotated[str, "JavaScript snippet to execute."],
    target: Annotated[
        Literal["main", "scene"],
        "Where to run the snippet. Default 'main'.",
    ] = "main",
) -> dict[str, Any]:
    return await call_bridge("execute_script", {"code": code, "target": target},
                             timeout=60)
