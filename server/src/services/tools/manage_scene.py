"""manage_scene tool — list / open / save scenes (.fire)."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp import Context

from services.registry import cocos_mcp_tool
from services.tools._common import call_bridge


@cocos_mcp_tool(
    description=(
        "Operate on scenes in the editor.\n\n"
        "Actions:\n"
        "  list      - enumerate all .fire scenes in the project.\n"
        "  current   - report the currently-open scene (uuid, name, child count).\n"
        "  open      - open a scene by `url` or `uuid`.\n"
        "  save      - save the currently-open scene.\n\n"
        "After opening a scene, manage_node operations become available."
    ),
)
async def manage_scene(
    ctx: Context,
    action: Annotated[
        Literal["list", "current", "open", "save"],
        "Which operation to perform.",
    ],
    url: Annotated[str | None, "Scene URL for `open` (db://assets/scene/foo.fire)."] = None,
    uuid: Annotated[str | None, "Scene UUID for `open` (alternative to url)."] = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"action": action}
    if url is not None:
        params["url"] = url
    if uuid is not None:
        params["uuid"] = uuid
    return await call_bridge("manage_scene", params)
