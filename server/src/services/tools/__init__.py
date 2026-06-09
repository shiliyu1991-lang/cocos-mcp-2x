"""Tool package for cocos-mcp.

Each .py file declares one MCP tool decorated with @cocos_mcp_tool. They're
auto-imported on startup so decorators fire and the FastMCP instance gets
populated by register_all_tools().
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastmcp import FastMCP

from services.registry import cocos_mcp_tool, get_registered_tools  # noqa: F401
from utils.module_discovery import discover_modules

logger = logging.getLogger("cocos-mcp.tools")

__all__ = ["register_all_tools", "cocos_mcp_tool"]


def register_all_tools(mcp: FastMCP) -> None:
    """Auto-discover every tool module and register it with FastMCP."""
    here = Path(__file__).parent
    list(discover_modules(here, __package__))

    tools = get_registered_tools()
    if not tools:
        logger.warning("no cocos-mcp tools registered")
        return

    for entry in tools:
        fn = entry["fn"]
        name = entry["name"]
        description = entry["description"]
        kwargs = entry["mcp_kwargs"]
        mcp.tool(name=name, description=description, **kwargs)(fn)
        logger.debug("registered tool %s", name)

    logger.info("registered %d tool(s): %s", len(tools), ", ".join(t["name"] for t in tools))
