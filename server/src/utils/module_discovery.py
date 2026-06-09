"""Walk a directory and import every .py module so registry decorators fire."""

from __future__ import annotations

import importlib
import logging
from pathlib import Path
from typing import Iterator

logger = logging.getLogger("cocos-mcp.discovery")


def discover_modules(directory: Path, package: str) -> Iterator[str]:
    """Import every non-private .py file under `directory` as `<package>.<name>`."""
    for path in sorted(directory.iterdir()):
        if not path.is_file() or path.suffix != ".py":
            continue
        name = path.stem
        if name.startswith("_") or name == "__init__":
            continue
        full = f"{package}.{name}"
        try:
            importlib.import_module(full)
            yield full
        except Exception:
            logger.exception("failed to import %s", full)
