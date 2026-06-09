"""manage_node tool — query and mutate the active scene's node graph."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp import Context

from services.registry import cocos_mcp_tool
from services.tools._common import call_bridge


@cocos_mcp_tool(
    description=(
        "Inspect or modify nodes in the currently-open scene. Most actions "
        "operate by `uuid`.\n\n"
        "Actions:\n"
        "  tree           - return the {name, uuid, children[]} tree from `uuid` "
        "(default = scene root) down to `maxDepth` (default 6).\n"
        "  get            - return name/active/position/scale/anchor/size/components "
        "for a single node.\n"
        "  set_property   - set node.<dotted.property> to `value`. The first "
        "segment may be a component class name (e.g. cc.Sprite.spriteFrame).\n"
        "  create         - create a cc.Node under `parentUuid` (default = scene).\n"
        "  delete         - destroy a node (cannot delete the scene root).\n"
        "  add_component  - add a component by class name (e.g. cc.Sprite, cc.Label).\n"
        "  selection      - return uuids of nodes currently selected in the editor."
    ),
)
async def manage_node(
    ctx: Context,
    action: Annotated[
        Literal["tree", "get", "set_property", "create", "delete", "add_component", "selection"],
        "Which operation to perform.",
    ],
    uuid: Annotated[str | None, "Target node uuid (most actions). Defaults to scene root for `tree`."] = None,
    parent_uuid: Annotated[str | None, "Parent uuid for `create` (defaults to scene root)."] = None,
    name: Annotated[str | None, "Name for `create` (default 'NewNode')."] = None,
    position: Annotated[dict | None, "{x, y, z?} for `create`."] = None,
    property: Annotated[str | None, "Dotted path for `set_property`."] = None,
    value: Annotated[Any, "New value for `set_property` (any JSON-serializable)."] = None,
    class_name: Annotated[str | None, "Component class for `add_component` (e.g. cc.Sprite)."] = None,
    max_depth: Annotated[int, "Max recursion depth for `tree` (default 6)."] = 6,
) -> dict[str, Any]:
    params: dict[str, Any] = {"action": action}
    if uuid is not None:
        params["uuid"] = uuid
    if parent_uuid is not None:
        params["parentUuid"] = parent_uuid
    if name is not None:
        params["name"] = name
    if position is not None:
        params["position"] = position
    if property is not None:
        params["property"] = property
    if value is not None:
        params["value"] = value
    if class_name is not None:
        params["className"] = class_name
    if action == "tree":
        params["maxDepth"] = int(max_depth)
    return await call_bridge("manage_node", params)
