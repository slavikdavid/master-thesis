# app/services/ws.py

import os
import json
import asyncio
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import WebSocket
from fastapi.websockets import WebSocketDisconnect
from websockets.exceptions import ConnectionClosedOK, ConnectionClosedError

# this module provides ONLY websocket utility functions.
# websocket routes are defined in app/routes/websocket.py.

# base folder where each repo keeps its status.json
BASE = Path(os.getenv("DATA_DIR", "data/repos"))

# in-memory watchers: repo_id -> list[WebSocket]
_watchers: Dict[str, List[WebSocket]] = {}


# ---------------------------
# watcher management
# ---------------------------
def register_watcher(repo_id: str, ws: WebSocket) -> None:
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
    try:
        await ws.send_json(payload)
        return True
    except (WebSocketDisconnect, ConnectionClosedOK, ConnectionClosedError):
        return False
    except Exception:
        # any other error: treat as closed to avoid loops
        return False


def _coalesce_and_clip_progress(status_dict: dict) -> dict:
    """
    Translate a status.json dict into a compact progress payload:
      {"phase": "...", "progress": <0-100 optional>, "message": optional}
    Recognized phases: upload/clone -> "upload", "indexing", "indexed", "error"
    """
    phase_raw = (status_dict.get("status") or "").lower()

    # map a few common writers -> normalized phases
    if phase_raw in {"upload", "uploading", "clone", "cloning"}:
        phase = "upload"
    elif phase_raw in {"index", "indexing"}:
        phase = "indexing"
    elif phase_raw in {"done", "indexed", "complete", "completed"}:
        phase = "indexed"
    elif phase_raw in {"error", "failed", "fail"}:
        phase = "error"
    else:
        # unknown -> just pass through
        phase = phase_raw or "unknown"

    msg = status_dict.get("message")

    progress: Optional[int] = None
    if phase == "indexing":
        processed = int(status_dict.get("processed", 0) or 0)
        total = int(status_dict.get("total", 0) or 0)
        if total > 0:
            progress = max(0, min(100, round((processed / total) * 100)))

    payload = {"phase": phase}
    if progress is not None:
        payload["progress"] = progress
    if msg:
        payload["message"] = msg
    return payload


# ---------------------------
# File-tail based streams
# ---------------------------
async def tail_status(ws: WebSocket, repo_id: str, interval: float = 10.0) -> None:
    """
    Polls <BASE>/<repo_id>/status.json periodically and streams the whole dict.
    Stops on "indexed" or "error" (or client disconnect).
    """
    register_watcher(repo_id, ws)
    status_path = BASE / repo_id / "status.json"
    last_sent: Optional[str] = None  # cache of last json text

    try:
        while True:
            await asyncio.sleep(interval)

            if not status_path.exists():
                # if the file isn't there yet, just keep waiting.
                continue

            try:
                raw = status_path.read_text(encoding="utf-8")
            except Exception:
                # transient read error (being written), skip this tick
                continue

            if raw == last_sent:
                # no change since last tick
                continue

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            # try to send; drop on failure
            if not await _try_send_json(ws, data):
                break

            last_sent = raw

            status = (data.get("status") or "").lower()
            if status in {"indexed", "done", "error", "failed"}:
                break
    finally:
        unregister_watcher(repo_id, ws)
        try:
            await ws.close()
        except Exception:
            pass


async def stream_progress(ws: WebSocket, repo_id: str, interval: float = 1.0) -> None:
    """
    Polls <BASE>/<repo_id>/status.json and emits compact progress messages
    like {"phase": "indexing", "progress": 42}.
    Stops on "indexed" or "error" (or client disconnect).
    """
    register_watcher(repo_id, ws)
    status_path = BASE / repo_id / "status.json"

    # for coalescing
    last_phase: Optional[str] = None
    last_progress: Optional[int] = None
    last_message: Optional[str] = None

    try:
        while True:
            await asyncio.sleep(interval)

            if not status_path.exists():
                continue

            try:
                status_dict = json.loads(status_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue

            payload = _coalesce_and_clip_progress(status_dict)
            phase = payload.get("phase")
            progress = payload.get("progress")
            message = payload.get("message")

            # only send when something changed
            if (phase, progress, message) != (last_phase, last_progress, last_message):
                if not await _try_send_json(ws, payload):
                    break
                last_phase, last_progress, last_message = phase, progress, message

            if phase in {"indexed", "done", "error"}:
                break
    finally:
        unregister_watcher(repo_id, ws)
        try:
            await ws.close()
        except Exception:
            pass

def broadcast_progress(
    repo_id: str,
    phase: str,
    progress: Optional[int] = None,
    message: Optional[str] = None,
) -> None:
    """
    Fire-and-forget broadcast to all watchers of a repo.
    Safe to call from async code (same loop) or other threads.
    """
    payload: dict = {"phase": phase}
    if progress is not None:
        payload["progress"] = max(0, min(100, int(progress)))
    if message:
        payload["message"] = message

    # schedule sends for all watchers; remove closed sockets
    watchers = list(_watchers.get(repo_id, []))

    async def _send_all() -> None:
        to_remove: List[WebSocket] = []
        for ws in watchers:
            ok = await _try_send_json(ws, payload)
            if not ok:
                to_remove.append(ws)
        for ws in to_remove:
            unregister_watcher(repo_id, ws)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_send_all())
    except RuntimeError:
        # not in an event loop (e.g., called from a worker thread)
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_send_all())
        finally:
            loop.close()


_broadcast = broadcast_progress
