# app/routes/repos.py
import os
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.models import RepoQuery
from app.services.file_utils import list_files, read_file
from app.services.pipeline import query_codebase, get_document_store
from app.schemas.request_models import QueryRequest
from app.services.progress import BROKER  # in-memory progress broker

router = APIRouter(tags=["repos"], prefix="/repos")

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
DATA_DIR = Path(os.getenv("DATA_DIR", "data/repos"))


# ---------- response models ----------

class StatisticsResponse(BaseModel):
    index_status: str
    document_count: int


class DocumentItem(BaseModel):
    id: str
    content: str
    meta: dict


class ListDocumentsResponse(BaseModel):
    documents: List[DocumentItem]


class ContextDoc(BaseModel):
    filename: str
    content: str
    id: Optional[str] = None


class AnswerRequest(BaseModel):
    repo_id: Optional[str] = None
    repoId: Optional[str] = None
    query: Optional[str] = None
    question: Optional[str] = None
    conversation_id: Optional[str] = None
    conversationId: Optional[str] = None
    user_id: Optional[str] = None
    userId: Optional[str] = None


class AnswerResponse(BaseModel):
    answer: str
    contexts: List[ContextDoc] = []


class FileContentResponse(BaseModel):
    content: str


# phases status (upload / embedding / indexing)
class PhaseState(BaseModel):
    status: Optional[str] = None          # "queued" | "running" | "complete" | "error" | None
    processed: Optional[int] = None
    total: Optional[int] = None
    message: Optional[str] = None
    error: Optional[str] = None
    startedAt: Optional[float] = None
    finishedAt: Optional[float] = None

    class Config:
        extra = "ignore"


class RepoStatusResponse(BaseModel):
    repoId: str
    status: str                           # "new" | "upload" | "indexing" | "indexed" | "error" | "missing"
    phases: Dict[str, PhaseState]         # broker overlay (can be {})
    stats: Dict[str, Any]                 # e.g., { "documents": 42 }


# ---------- helpers ----------

def _repo_filter(repo_id: str) -> dict:
    return {
        "operator": "OR",
        "conditions": [
            {"field": "meta.repo_id", "operator": "==", "value": repo_id},
            {"field": "meta.repoId", "operator": "==", "value": repo_id},
        ],
    }


def _map_broker_to_status(phases: Dict[str, Any]) -> Optional[str]:
    """
    Map broker phases snapshot to a coarse status. Return None if inconclusive.
    """
    if not phases:
        return None

    # Lower-case normalize
    def st(name: str) -> str:
        s = phases.get(name) or {}
        return (s.get("status") or "").lower()

    # If any phase reports error -> error
    for p in phases.values():
        if isinstance(p, dict) and (p.get("status") or "").lower() == "error":
            return "error"

    # Active work?
    running_like = {"queued", "running"}
    if st("upload") in running_like or st("cloning") in running_like:
        return "upload"
    if st("indexing") in running_like or st("embedding") in running_like or st("chunking") in running_like:
        return "indexing"

    # Completed pipeline but maybe no documents? Fallthrough to durable check decides.
    return None


def _count_documents(repo_id: str) -> int:
    """
    Count documents for a repo using your Haystack store.
    """
    store = get_document_store()
    # store.filter_documents returns a list-like in Haystack integrations
    docs = store.filter_documents(filters=_repo_filter(repo_id))
    try:
        return len(docs)
    except Exception:
        # Some stores return generators; consume safely
        return sum(1 for _ in docs)


def _repo_dir_exists(repo_id: str) -> bool:
    return (UPLOAD_DIR / repo_id).exists()


async def _snap_broker(repo_id: str) -> Dict[str, Any]:
    """
    Safe wrapper around BROKER.snapshot (which is async).
    """
    try:
        if BROKER:
            return await BROKER.snapshot(repo_id)  # valid inside async def
    except Exception:
        pass
    return {}


async def _compute_status(repo_id: str) -> Tuple[str, Dict[str, PhaseState], Dict[str, Any]]:
    """
    Compute authoritative status:
    1) If repo folder is missing -> "missing"
    2) If documents > 0 -> "indexed"
    3) Else if broker suggests upload/indexing/error -> that
    4) Else -> "new"
    Returns: (status, typed_phases, stats)
    """
    if not _repo_dir_exists(repo_id):
        return "missing", {}, {"documents": 0}

    snap: Dict[str, Any] = await _snap_broker(repo_id)
    raw_phases = (snap.get("phases") or {}) if isinstance(snap, dict) else {}
    typed_phases: Dict[str, PhaseState] = {
        k: PhaseState(**v) for k, v in raw_phases.items() if isinstance(v, dict)
    }

    # Durable evidence first
    doc_count = _count_documents(repo_id)
    if doc_count > 0:
        return "indexed", typed_phases, {"documents": doc_count}

    # Otherwise consider broker overlay
    broker_status = _map_broker_to_status(raw_phases)
    if broker_status:
        return broker_status, typed_phases, {"documents": doc_count}

    # Nothing known
    return "new", typed_phases, {"documents": doc_count}


# ---------- routes ----------

@router.get("/{repo_id}/status", response_model=RepoStatusResponse)
async def get_status(repo_id: str):
    """
    Returns an authoritative status with broker overlay.

    - 404 if the repo directory is missing (kept for compatibility), but still
      compute status to inform clients that want to avoid 404s.
    - status:
        "indexed"  -> there are durable documents for this repo
        "indexing" -> broker says indexing/embedding/chunking is running
        "upload"   -> broker says upload/cloning is running
        "error"    -> any broker phase reports error
        "new"      -> no durable docs and no broker activity
        "missing"  -> repo directory not found
    """
    if not _repo_dir_exists(repo_id):
        raise HTTPException(status_code=404, detail="Repository not found")

    status, typed, stats = await _compute_status(repo_id)
    return RepoStatusResponse(repoId=repo_id, status=status, phases=typed, stats=stats)


@router.get("/{repo_id}/files", response_model=List[str])
def get_files(repo_id: str):
    repo_path = UPLOAD_DIR / repo_id
    if not repo_path.is_dir():
        raise HTTPException(status_code=404, detail="Repository not found")
    return list_files(repo_id)


@router.get(
    "/{repo_id}/file",
    response_model=FileContentResponse,
    responses={404: {"description": "File not found"}},
)
def get_file(repo_id: str, path: str = Query(..., description="Relative path to file in the repo")):
    """
    Returns JSON { content } instead of a raw file.
    """
    file_path = (UPLOAD_DIR / repo_id / path).resolve()
    repo_dir = (UPLOAD_DIR / repo_id).resolve()
    if not str(file_path).startswith(str(repo_dir)) or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    try:
        content = read_file(repo_id, path)
    except Exception:
        try:
            content = file_path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            raise HTTPException(status_code=404, detail="File not found")
    return FileContentResponse(content=content)


@router.get("/{repo_id}/queries", response_model=List[RepoQuery])
def get_queries(repo_id: str):
    qpath = DATA_DIR / repo_id / "queries.json"
    if not qpath.exists():
        return []
    import json
    data = json.loads(qpath.read_text(encoding="utf-8"))
    return [RepoQuery(**item) for item in data]


@router.get("/v1/statistics", response_model=StatisticsResponse)
async def statistics(repoId: str = Query(..., alias="repoId", description="Repository ID")):
    """
    Report index status + document count.
    Uses the same authoritative logic as /status (no more "stuck indexing").
    """
    if not _repo_dir_exists(repoId):
        # original behavior was to error in /status; for statistics we can still report zeros
        return StatisticsResponse(index_status="missing", document_count=0)

    status, _typed, stats = await _compute_status(repoId)
    # Map to the original shape
    return StatisticsResponse(
        index_status=status,
        document_count=int(stats.get("documents", 0)),
    )


@router.get("/v2/list_documents", response_model=ListDocumentsResponse)
def list_documents(repoId: str = Query(..., alias="repoId", description="Repository ID")):
    store = get_document_store()
    docs = store.filter_documents(filters=_repo_filter(repoId))
    items = [DocumentItem(id=d.id, content=d.content, meta=d.meta or {}) for d in docs]
    return ListDocumentsResponse(documents=items)


@router.post("/v2/answer", response_model=AnswerResponse, status_code=200)
async def answer(req: AnswerRequest):
    repo_id = (req.repo_id or req.repoId or "").strip()
    question = (req.query or req.question or "").strip()
    conv_id = (req.conversation_id or req.conversationId or "") or None
    user_id = (req.user_id or req.userId or "") or None
    if not repo_id or not question:
        raise HTTPException(status_code=422, detail="Both repo_id (or repoId) and query (or question) are required.")

    qr = QueryRequest(
        repoId=repo_id,
        question=question,
        conversationId=conv_id,
        userId=user_id,
    )
    answer_text, contexts = await query_codebase(qr, filters=_repo_filter(repo_id))

    return AnswerResponse(
        answer=answer_text,
        contexts=[ContextDoc(filename=c["filename"], content=c["content"], id=c.get("id")) for c in contexts],
    )