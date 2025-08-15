# app/routes/websocket.py

from typing import Annotated, Optional
import logging

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
from app.services.ws import tail_status, stream_progress

router = APIRouter(prefix="/ws", tags=["websocket"])
logger = logging.getLogger(__name__)


# --- auth dependency: verify ?token=... with PyJWT ---
async def get_token_payload(
    token: Annotated[str, Query(..., description="JWT token for auth")],
) -> dict:
    """
    Reads `?token=...` and verifies it with PyJWT.
    Raises WebSocketException(1008) on failure.
    """
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except PyJWTError:
        # 1008 = policy violation
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)


def _resolve_repo_id(repo_id: Optional[str], repoId: Optional[str]) -> str:
    rid = (repo_id or repoId or "").strip()
    return rid


@router.websocket("/status")
async def status_ws(
    websocket: WebSocket,
    token_payload: dict = Depends(get_token_payload),
    repo_id_q: Optional[str] = Query(None, alias="repo_id"),
    repoId_q: Optional[str] = Query(None, alias="repoId"),
):
    """
    Streams indexing status updates.
    Usage:  ws://host/ws/status?token=...&repo_id=...  (or &repoId=...)
    """
    await websocket.accept()

    repo_id = _resolve_repo_id(repo_id_q, repoId_q)
    if not repo_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        await tail_status(websocket, repo_id, interval=10.0)
    except WebSocketDisconnect:
        # normal close (tab change, refresh, etc.)
        pass
    except Exception:
        logger.exception("status_ws error")
    finally:
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
    Streams upload/indexing progress.
    Usage:  ws://host/ws/progress?token=...&repo_id=...  (or &repoId=...)
    """
    await websocket.accept()

    repo_id = _resolve_repo_id(repo_id_q, repoId_q)
    if not repo_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        await stream_progress(websocket, repo_id, interval=1.0)
    except WebSocketDisconnect:
        # normal close
        pass
    except Exception:
        logger.exception("progress_ws error")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass