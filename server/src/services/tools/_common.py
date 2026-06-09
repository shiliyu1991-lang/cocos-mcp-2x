"""Shared helpers for tool modules."""

from __future__ import annotations

from typing import Any

from transport.ws_client import BridgeError, BridgeUnavailable, get_bridge


async def call_bridge(command: str, params: dict[str, Any] | None = None,
                      timeout: float | None = None) -> dict[str, Any]:
    """Forward a command to the Cocos extension and shape the result.

    Returns the same envelope every tool uses:
        {"success": True, "data": <whatever the bridge returned>}
    or  {"success": False, "error": <human message>, "errorType": "..."}.
    Tools should pass this dict straight through to the LLM — keeping the
    shape uniform makes responses easier to consume.
    """
    try:
        data = await get_bridge().call(command, params, timeout=timeout)
        return {"success": True, "data": data}
    except BridgeUnavailable as exc:
        return {
            "success": False,
            "errorType": "bridge_unavailable",
            "error": str(exc),
        }
    except BridgeError as exc:
        return {
            "success": False,
            "errorType": "bridge_error",
            "error": str(exc),
        }
    except Exception as exc:  # pragma: no cover  (defensive)
        return {
            "success": False,
            "errorType": "unexpected",
            "error": f"{type(exc).__name__}: {exc}",
        }
