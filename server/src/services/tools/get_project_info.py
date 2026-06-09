"""get_project_info tool — sanity-check / project discovery."""

from __future__ import annotations

from typing import Annotated, Any

from fastmcp import Context

from services.registry import cocos_mcp_tool
from services.tools._common import call_bridge


@cocos_mcp_tool(
    description=(
        "Return basic information about the open Cocos Creator project: "
        "absolute project path, assets root, editor version, scene count, "
        "first 20 scenes, and the list of available bridge commands. "
        "Call this first to verify the bridge is reachable."
    ),
)
async def get_project_info(ctx: Context) -> dict[str, Any]:
    return await call_bridge("get_project_info", {})
