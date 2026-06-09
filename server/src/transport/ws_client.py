"""WebSocket transport between the MCP server and the Cocos extension.

The direction is now reversed compared to v0.1:

    v0.1: Cocos extension was the WS *server*; Python dialed in as a client.
    v0.2: Python is the WS *server*; the Cocos extension dials in from its
          panel "Connect" button.

This makes the editor side a one-file/one-button setup — no listening port
to free up, no auto-start dance. Trade-off: the Python MCP server has to
host its WS server on a fixed port (default 6020) which is the URL the user
types into the Cocos panel.

Implementation note
-------------------
FastMCP owns the main asyncio loop (it runs `mcp.run(transport='stdio')`).
We don't want to fight it for control, so we run the websockets server on
a daemon thread with its own loop. `bridge.call()` (invoked from FastMCP's
loop) forwards onto that loop via `asyncio.run_coroutine_threadsafe`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from typing import Any, Optional

import websockets

from core.config import config

logger = logging.getLogger("cocos-mcp.bridge")


class BridgeError(Exception):
    """The extension responded with a structured error."""


class BridgeUnavailable(Exception):
    """No extension is connected, or the socket dropped mid-call."""


class CocosBridge:
    """WS server that waits for the Cocos extension to dial in.

    Only one extension client is supported at a time; a new connection
    replaces the old one. The protocol is the same JSON envelope used in
    v0.1 — only the connection direction changed.
    """

    def __init__(self, host: str, port: int, path: Optional[str] = None) -> None:
        self._host = host
        self._port = port
        self._path = path or config.bridge_path
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._loop_ready = threading.Event()
        self._loop_error: Optional[BaseException] = None
        self._server: Optional[websockets.Server] = None
        self._client = None  # the connected websocket (lives on self._loop)
        self._pending: dict[str, asyncio.Future] = {}

    # ------------------------------------------------------------------ #
    # Lifecycle (called from FastMCP's main thread)
    # ------------------------------------------------------------------ #

    @property
    def url(self) -> str:
        return f"ws://{self._host}:{self._port}{self._path}"

    def start_in_thread(self, ready_timeout: float = 5.0) -> None:
        """Spawn the daemon thread that hosts the WS server. Blocks briefly
        until the server is listening (or the start attempt failed)."""
        t = threading.Thread(
            target=self._thread_main,
            name="cocos-bridge",
            daemon=True,
        )
        t.start()
        if not self._loop_ready.wait(timeout=ready_timeout):
            raise RuntimeError(
                f"cocos bridge thread did not become ready within {ready_timeout}s"
            )
        if self._loop_error is not None:
            raise self._loop_error

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            self._server = loop.run_until_complete(self._serve())
            logger.info("cocos bridge listening on %s", self.url)
        except Exception as exc:  # pragma: no cover - reported via _loop_error
            self._loop_error = exc
            logger.exception("failed to start cocos bridge")
            self._loop_ready.set()
            return
        self._loop_ready.set()
        try:
            loop.run_forever()
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                pass
            loop.close()

    async def _serve(self):
        # websockets>=13 changed the handler signature; both shapes pass `ws`
        # as the first positional, so this works on both.
        return await websockets.serve(
            self._on_connection,
            self._host,
            self._port,
            max_size=16 * 1024 * 1024,
            process_request=self._process_request,
        )

    async def _process_request(self, *args, **kwargs):
        # Across websockets versions the signature for process_request differs.
        # We just want to reject paths other than our configured one.
        path = None
        if args:
            # websockets <13: (path, headers); >=13: (connection,) where
            # connection.request.path is the URL path.
            first = args[0]
            if isinstance(first, str):
                path = first
            else:
                req = getattr(first, "request", None)
                if req is not None:
                    path = getattr(req, "path", None)
        if path is not None and path != self._path:
            # Return a 404. Format also varies; the tuple form is widely accepted.
            try:
                from http import HTTPStatus
                return (HTTPStatus.NOT_FOUND, [], b"not found\n")
            except Exception:
                return None
        return None

    # ------------------------------------------------------------------ #
    # Connection handling (runs on self._loop)
    # ------------------------------------------------------------------ #

    async def _on_connection(self, ws, *_unused):
        old = self._client
        if old is not None:
            try:
                await old.close(code=1001, reason="superseded")
            except Exception:
                pass
        self._client = ws
        logger.info("cocos extension connected")
        try:
            await ws.send(json.dumps({
                "type": "hello",
                "server": "cocos-mcp-py",
                "version": 2,
            }))
        except Exception:
            pass
        try:
            async for raw in ws:
                try:
                    frame = json.loads(raw)
                except Exception:
                    logger.debug("non-JSON frame from extension: %r", raw[:200])
                    continue
                if not isinstance(frame, dict):
                    continue
                if frame.get("type") == "hello":
                    continue
                rid = frame.get("id")
                if not rid:
                    continue
                fut = self._pending.pop(rid, None)
                if fut and not fut.done():
                    fut.set_result(frame)
        except websockets.ConnectionClosed:
            pass
        except Exception:
            logger.exception("cocos bridge reader crashed")
        finally:
            logger.info("cocos extension disconnected")
            if self._client is ws:
                self._client = None
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(BridgeUnavailable("bridge connection lost"))
            self._pending.clear()

    # ------------------------------------------------------------------ #
    # Public API (invoked from FastMCP's loop, NOT self._loop)
    # ------------------------------------------------------------------ #

    async def call(self, command: str, params: Optional[dict] = None,
                   timeout: Optional[float] = None) -> Any:
        if self._loop is None:
            raise BridgeUnavailable("cocos bridge thread not started")
        coro = self._call_impl(command, params, timeout)
        cf = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return await asyncio.wrap_future(cf)

    async def _call_impl(self, command: str, params: Optional[dict],
                         timeout: Optional[float]) -> Any:
        ws = self._client
        if ws is None:
            raise BridgeUnavailable(
                f"Cocos extension is not connected. Open the Cocos MCP panel "
                f"in Cocos Creator and click Connect (URL: {self.url})."
            )
        rid = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._pending[rid] = fut
        frame = {"id": rid, "command": command, "params": params or {}}
        try:
            await ws.send(json.dumps(frame))
        except websockets.ConnectionClosed as exc:
            self._pending.pop(rid, None)
            raise BridgeUnavailable(f"send failed: {exc}") from exc
        try:
            reply = await asyncio.wait_for(fut, timeout=timeout or config.request_timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(rid, None)
            raise BridgeUnavailable(
                f"timeout waiting for reply to '{command}' after "
                f"{timeout or config.request_timeout}s"
            ) from exc
        if not isinstance(reply, dict):
            raise BridgeError(f"non-object reply from extension: {reply!r}")
        if reply.get("success"):
            return reply.get("data")
        message = reply.get("error") or "unknown error"
        raise BridgeError(f"{command}: {message}")

    async def close(self) -> None:
        # Shut down the WS server on the bridge thread.
        loop = self._loop
        if loop is None:
            return

        async def _shutdown():
            if self._client is not None:
                try:
                    await self._client.close()
                except Exception:
                    pass
                self._client = None
            if self._server is not None:
                self._server.close()
                try:
                    await self._server.wait_closed()
                except Exception:
                    pass
                self._server = None
            loop.stop()

        try:
            cf = asyncio.run_coroutine_threadsafe(_shutdown(), loop)
            cf.result(timeout=5)
        except Exception:
            pass


_global_bridge: Optional[CocosBridge] = None


def set_global_bridge(b: CocosBridge) -> None:
    global _global_bridge
    _global_bridge = b


def get_bridge() -> CocosBridge:
    if _global_bridge is None:
        raise BridgeUnavailable(
            "cocos bridge has not been initialized — main.py forgot to "
            "call set_global_bridge()."
        )
    return _global_bridge
