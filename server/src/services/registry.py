"""Decorator-based tool registry.

Mirrors the pattern from MCP for Unity (`@mcp_for_unity_tool`) but kept much
simpler — there's no group/visibility logic for the MVP. Add it later if
you want a `manage_tools` meta-tool.
"""

from __future__ import annotations

from typing import Any, Callable

_registry: list[dict[str, Any]] = []


def cocos_mcp_tool(*, name: str | None = None, description: str | None = None,
                   **mcp_kwargs: Any) -> Callable:
    """Register a coroutine as an MCP tool.

    Usage:
        @cocos_mcp_tool(description="...")
        async def manage_node(...): ...
    """
    def decorator(fn: Callable) -> Callable:
        _registry.append({
            "fn": fn,
            "name": name or fn.__name__,
            "description": description or (fn.__doc__ or "").strip().split("\n")[0],
            "mcp_kwargs": mcp_kwargs,
        })
        return fn
    return decorator


def get_registered_tools() -> list[dict[str, Any]]:
    return list(_registry)


def clear_registry() -> None:  # pragma: no cover (test helper)
    _registry.clear()
