# app/routes/websocket.py

from typing import Optional, Annotated
import logging
import asyncio

from fastapi import (
    APIRouter,
    WebSocket,
    WebSocketException,
    WebSocketDisconnect,
    Depends,
    Query,
    status,
)
import jwt
from jwt import PyJWTError

from app.config import JWT_SECRET, JWT_ALGORITHM
from app.services.ws import stream_repo, set_main_loop

router = APIRouter(prefix="/ws", tags=["websocket"])
logger = logging.getLogger(__name__)


# --- auth dependency: verify ?token=... with PyJWT ---
async def get_token_payload(
    token: Annotated[str, Query(..., description="JWT token for auth")],
) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except PyJWTError:
        # 1008 = policy violation
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)


def _resolve_repo_id(repo_id: Optional[str], repoId: Optional[str]) -> str:
    return (repo_id or repoId or "").strip()


@router.websocket("/status")
async def status_ws(
    websocket: WebSocket,
    token_payload: dict = Depends(get_token_payload),
    repo_id_q: Optional[str] = Query(None, alias="repo_id"),
    repoId_q: Optional[str] = Query(None, alias="repoId"),
):
    """
    Streams a snapshot/keepalive + live progress updates for a repo.
    """
    await websocket.accept()
    try:
        set_main_loop(asyncio.get_running_loop())
    except Exception:
        pass

    repo_id = _resolve_repo_id(repo_id_q, repoId_q)
    if not repo_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        await stream_repo(websocket, repo_id)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("status_ws error")
        try:
            await websocket.close()
        except Exception:
            pass


@router.websocket("/progress")
async def progress_ws(
    websocket: WebSocket,
    token_payload: dict = Depends(get_token_payload),
    repo_id_q: Optional[str] = Query(None, alias="repo_id"),
    repoId_q: Optional[str] = Query(None, alias="repoId"),
):
    """
    Back-compat alias of /ws/status.
    """
    await websocket.accept()
    try:
        set_main_loop(asyncio.get_running_loop())
    except Exception:
        pass

    repo_id = _resolve_repo_id(repo_id_q, repoId_q)
    if not repo_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        await stream_repo(websocket, repo_id)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("progress_ws error")
        try:
            await websocket.close()
        except Exception:
            pass
