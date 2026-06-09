"""manage_asset tool — query / read / create / delete / refresh assets."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp import Context

from services.registry import cocos_mcp_tool
from services.tools._common import call_bridge


@cocos_mcp_tool(
    description=(
        "Inspect and manipulate assets under the project's assets/ folder via "
        "the editor asset-db.\n\n"
        "Actions:\n"
        "  list     - search assets matching `pattern` and optional `type` "
        "(e.g. 'scene', 'prefab', 'javascript', 'texture').\n"
        "  info     - look up an asset by `url` or `uuid`.\n"
        "  read     - read text contents (small files <1MB only).\n"
        "  create   - create an asset at `url` with optional `content`.\n"
        "  delete   - move an asset to trash (requires user permission!).\n"
        "  refresh  - reimport assets at `url` (defaults to db://assets).\n\n"
        "URLs use the db:// scheme: db://assets/path/to/file.ext"
    ),
)
async def manage_asset(
    ctx: Context,
    action: Annotated[
        Literal["list", "info", "read", "create", "delete", "refresh"],
        "Which operation to perform.",
    ],
    url: Annotated[str | None, "Asset URL (db://assets/...). Used by info/read/create/delete/refresh."] = None,
    uuid: Annotated[str | None, "Asset UUID. Alternative to url for info/read."] = None,
    pattern: Annotated[str | None, "Glob for `list` (default db://assets/**/*)."] = None,
    type: Annotated[str | None, "Asset type filter for `list` (e.g. scene, prefab, javascript)."] = None,
    limit: Annotated[int, "Max items returned by `list` (capped at 1000)."] = 200,
    content: Annotated[str | None, "Body for `create` (utf-8 text)."] = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"action": action}
    if url is not None:
        params["url"] = url
    if uuid is not None:
        params["uuid"] = uuid
    if pattern is not None:
        params["pattern"] = pattern
    if type is not None:
        params["type"] = type
    if limit is not None:
        params["limit"] = int(limit)
    if content is not None:
        params["content"] = content
    return await call_bridge("manage_asset", params)
