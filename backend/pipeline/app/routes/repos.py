# app/routes/repos.py
import os
import json
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from fastapi.responses import FileResponse

from app.models import RepoStatus, RepoQuery
from app.services.file_utils import list_files, read_file
from app.services.pipeline import query_codebase
from app.schemas.request_models import QueryRequest

router = APIRouter(tags=["repos"], prefix="/repos")

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
DATA_DIR   = Path(os.getenv("DATA_DIR",   "data/repos"))

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


def _repo_filter(repo_id: str) -> dict:
    """
    Pgvector JSONB filter: check both snake_case and camelCase in meta.
    Generates SQL like:
      (meta->>'repo_id' = $1 OR meta->>'repoId' = $1)
    """
    return {
        "operator": "OR",
        "conditions": [
            {"field": "meta.repo_id", "operator": "==", "value": repo_id},
            {"field": "meta.repoId", "operator": "==", "value": repo_id},
        ],
    }

@router.get("/{repo_id}/status", response_model=RepoStatus)
def get_status(repo_id: str):
    status_path = DATA_DIR / repo_id / "status.json"
    if status_path.exists():
        return RepoStatus.parse_file(status_path)
    if (UPLOAD_DIR / repo_id).is_dir():
        return RepoStatus(status="indexing")
    raise HTTPException(status_code=404, detail="Repository not found")


@router.get("/{repo_id}/files", response_model=List[str])
def get_files(repo_id: str):
    repo_path = UPLOAD_DIR / repo_id
    if not repo_path.is_dir():
        raise HTTPException(status_code=404, detail="Repository not found")
    return list_files(repo_id)


@router.get("/{repo_id}/file", response_class=FileResponse, responses={404: {"description": "File not found"}})
def get_file(repo_id: str, path: str = Query(..., description="Relative path to file in the repo")):
    file_path = UPLOAD_DIR / repo_id / path
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(file_path), media_type="text/plain")


@router.get("/{repo_id}/queries", response_model=List[RepoQuery])
def get_queries(repo_id: str):
    qpath = DATA_DIR / repo_id / "queries.json"
    if not qpath.exists():
        return []
    data = json.loads(qpath.read_text(encoding="utf-8"))
    return [RepoQuery(**item) for item in data]


@router.get("/v1/statistics", response_model=StatisticsResponse)
def statistics(repoId: str = Query(..., alias="repoId", description="Repository ID")):
    status_path = DATA_DIR / repoId / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Repository not found or not indexed yet")
    status = json.loads(status_path.read_text(encoding="utf-8")).get("status", "unknown")

    from app.services.pipeline import get_document_store
    store = get_document_store()
    count = len(store.get_all_documents())

    return StatisticsResponse(index_status=status, document_count=count)


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