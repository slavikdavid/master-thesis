# app/routes/repos.py
import os
from pathlib import Path
from typing import List, Optional, Dict

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.models import RepoQuery
from app.services.file_utils import list_files, read_file
from app.services.pipeline import query_codebase
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


class AnswerResponse(BaseModel):
    answer: str
    contexts: List[ContextDoc] = []


class FileContentResponse(BaseModel):
    content: str


# phases status (upload / embedding / indexing)
class PhaseState(BaseModel):
    status: Optional[str] = "queued"          # "queued" | "running" | "complete" | "error"
    processed: Optional[int] = None
    total: Optional[int] = None
    message: Optional[str] = None
    error: Optional[str] = None
    startedAt: Optional[float] = None
    finishedAt: Optional[float] = None

    class Config:
        extra = "ignore"


class RepoPhasesResponse(BaseModel):
    repoId: str
    phases: Dict[str, PhaseState]


# ---------- helpers ----------

def _repo_filter(repo_id: str) -> dict:
    return {
        "operator": "OR",
        "conditions": [
            {"field": "meta.repo_id", "operator": "==", "value": repo_id},
            {"field": "meta.repoId", "operator": "==", "value": repo_id},
        ],
    }


def _ensure_three_phases(phases: Dict[str, dict]) -> Dict[str, dict]:
    for k in ("upload", "embedding", "indexing"):
        phases.setdefault(k, {"status": "queued"})
    return phases


# ---------- routes ----------

@router.get("/{repo_id}/status", response_model=RepoPhasesResponse)
async def get_status(repo_id: str):
    """
    Unified task status for Upload / Embedding / Indexing from the in-memory broker.
    """
    # ask broker for current snapshot
    snap = await BROKER.snapshot(repo_id)
    phases = (snap.get("phases") or {}).copy()

    # if nothing yet but upload dir exists, set defaults (running, queued...)
    if not phases and (UPLOAD_DIR / repo_id).exists():
        phases = {
            "upload": {"status": "running"},
            "embedding": {"status": "queued"},
            "indexing": {"status": "queued"},
        }

    if not phases and not (UPLOAD_DIR / repo_id).exists():
        raise HTTPException(status_code=404, detail="Repository not found")

    phases = _ensure_three_phases(phases)
    typed: Dict[str, PhaseState] = {k: PhaseState(**v) for k, v in phases.items()}
    return RepoPhasesResponse(repoId=repo_id, phases=typed)


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
    Use broker state to infer index status, then count docs from the store.
    """
    snap = await BROKER.snapshot(repoId)
    phases = snap.get("phases") or {}
    indexing = phases.get("indexing") or {}
    status = (indexing.get("status") or "unknown").lower()

    index_status = "indexed" if status == "complete" else status or "unknown"

    from app.services.pipeline import get_document_store
    store = get_document_store()
    count = len(store.get_all_documents())

    return StatisticsResponse(index_status=index_status, document_count=count)


@router.get("/v2/list_documents", response_model=ListDocumentsResponse)
def list_documents(repoId: str = Query(..., alias="repoId", description="Repository ID")):
    from app.services.pipeline import get_document_store
    store = get_document_store()

    filters = {
        "operator": "OR",
        "conditions": [
            {"field": "meta.repo_id", "operator": "==", "value": repoId},
            {"field": "meta.repoId", "operator": "==", "value": repoId},
        ],
    }

    docs = store.filter_documents(filters=filters)
    items = [DocumentItem(id=d.id, content=d.content, meta=d.meta or {}) for d in docs]
    return ListDocumentsResponse(documents=items)


@router.post("/v2/answer", response_model=AnswerResponse, status_code=200)
async def answer(req: AnswerRequest):
    repo_id = (req.repo_id or req.repoId or "").strip()
    question = (req.query or req.question or "").strip()
    if not repo_id or not question:
        raise HTTPException(status_code=422, detail="Both repo_id (or repoId) and query (or question) are required.")

    qr = QueryRequest(repoId=repo_id, question=question)
    answer_text, contexts = await query_codebase(qr, filters=_repo_filter(repo_id))

    return AnswerResponse(
        answer=answer_text,
        contexts=[ContextDoc(filename=c["filename"], content=c["content"], id=c.get("id")) for c in contexts],
    )