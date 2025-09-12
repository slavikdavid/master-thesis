# app/services/ws.py

import os
import asyncio
from pathlib import Path
from typing import Dict, List, Optional, Union

from fastapi import WebSocket
from fastapi.websockets import WebSocketDisconnect
from websockets.exceptions import ConnectionClosedOK, ConnectionClosedError

BASE = Path(os.getenv("DATA_DIR", "data/repos"))

_watchers: Dict[str, List[WebSocket]] = {}

_server_loop: Optional[asyncio.AbstractEventLoop] = None


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Record the main server loop so background threads can schedule coroutines."""
    global _server_loop
    _server_loop = loop


def register_watcher(repo_id: str, ws: WebSocket) -> None:
    """Attach a websocket to a repo topic and capture the running loop once."""
    global _server_loop
    try:
        loop = asyncio.get_running_loop()
        if loop and loop.is_running():
            _server_loop = loop
    except RuntimeError:
        pass
    _watchers.setdefault(repo_id, []).append(ws)


def unregister_watcher(repo_id: str, ws: WebSocket) -> None:
    lst = _watchers.get(repo_id)
    if not lst:
        return
    try:
        lst.remove(ws)
    except ValueError:
        pass
    if not lst:
        _watchers.pop(repo_id, None)


async def _try_send_json(ws: WebSocket, payload: dict) -> bool:
    """Send and return False if the socket is closed/errored (so we can prune it)."""
    try:
        await ws.send_json(payload)
        return True
    except (WebSocketDisconnect, ConnectionClosedOK, ConnectionClosedError):
        return False
    except Exception:
        return False


async def _send_to_all(repo_id: str, payload: dict) -> None:
    """Coroutine: send to all watchers of repo_id and prune dead ones."""
    watchers = list(_watchers.get(repo_id, []))
    to_remove: List[WebSocket] = []
    for ws in watchers:
        ok = await _try_send_json(ws, payload)
        if not ok:
            to_remove.append(ws)
    for ws in to_remove:
        unregister_watcher(repo_id, ws)


def broadcast(repo_id: str, payload: dict) -> None:
    """
    Thread-safe broadcast of an arbitrary payload to all watchers of repo_id.
    Safe to call from worker threads.
    """
    try:
        loop = asyncio.get_running_loop()
        if loop.is_running():
            loop.create_task(_send_to_all(repo_id, payload))
            return
    except RuntimeError:
        pass

    if _server_loop and _server_loop.is_running():
        asyncio.run_coroutine_threadsafe(_send_to_all(repo_id, payload), _server_loop)
    else:
        pass


def broadcast_progress(
    repo_id: str,
    phase_or_payload: Union[str, dict],
    progress: Optional[int] = None,
    message: Optional[str] = None,
    **extra: object,
) -> None:
    """
    Convenience:
      - broadcast_progress(repo_id, {"phase":"indexing", ...})
      - broadcast_progress(repo_id, "indexing", progress=42, message="...")
    """
    if isinstance(phase_or_payload, dict):
        payload = dict(phase_or_payload)  # shallow copy
    else:
        payload = {"phase": str(phase_or_payload)}
        if progress is not None:
            payload["progress"] = max(0, min(100, int(progress)))
        if message:
            payload["message"] = message
        if extra:
            payload.update(extra)

    broadcast(repo_id, payload)


_broadcast = broadcast_progress

async def stream_repo(ws: WebSocket, repo_id: str, keepalive_secs: float = 25.0) -> None:
    """
    Register the socket as a watcher and keep the connection open.
    Actual progress events are pushed via `broadcast/_broadcast`.
    Sends a periodic keepalive to help with idle proxy timeouts.
    """
    register_watcher(repo_id, ws)

    try:
        await _try_send_json(ws, {"event": "connected", "repoId": repo_id})

        while True:
            try:
                await asyncio.sleep(keepalive_secs)
                ok = await _try_send_json(ws, {"event": "keepalive"})
                if not ok:
                    break
            except (WebSocketDisconnect, ConnectionClosedOK, ConnectionClosedError):
                break
            except Exception:
                pass
    finally:
        unregister_watcher(repo_id, ws)
        try:
            await ws.close()
        except Exception:
            pass