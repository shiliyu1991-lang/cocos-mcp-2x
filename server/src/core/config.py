"""Centralised, mutable runtime config.

CLI args overwrite env vars overwrite defaults.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        return default


@dataclass
class Config:
    version: str = "0.3.0"
    bridge_host: str = field(default_factory=lambda: os.environ.get("COCOS_MCP_BRIDGE_HOST", "127.0.0.1"))
    bridge_port: int = field(default_factory=lambda: _env_int("COCOS_MCP_BRIDGE_PORT", 6020))
    bridge_path: str = field(default_factory=lambda: os.environ.get("COCOS_MCP_BRIDGE_PATH", "/cocosmcp"))
    request_timeout: float = field(default_factory=lambda: float(os.environ.get("COCOS_MCP_REQUEST_TIMEOUT", "30")))
    connect_timeout: float = field(default_factory=lambda: float(os.environ.get("COCOS_MCP_CONNECT_TIMEOUT", "5")))
    reconnect_backoff: float = field(default_factory=lambda: float(os.environ.get("COCOS_MCP_RECONNECT_BACKOFF", "1")))


config = Config()
