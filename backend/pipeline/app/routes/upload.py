# app/routes/upload.py

import uuid
from fastapi import APIRouter, BackgroundTasks, UploadFile, HTTPException, Form, File

from app.services.upload import handle_github_clone, handle_zip_upload

router = APIRouter(tags=["upload"])  # keep prefixing at include_router level (e.g., "/api")

@router.post("/upload", status_code=202)
async def upload_repo(
    background_tasks: BackgroundTasks,
    type: str = Form(..., description="Either 'github' or 'zip'"),
    repo_url: str | None = Form(None, description="GitHub URL, when type=github"),
    file: UploadFile | None = File(None, description="ZIP file, when type=zip"),
):
    """
    Start a repo ingest in the background:
      - type=github → clone via Git and stream progress
      - type=zip    → read uploaded .zip and stream progress

    Always returns 202 + {repoId}. Background tasks broadcast progress over WS.
    """
    kind = (type or "").strip().lower()
    if kind not in {"github", "zip"}:
        raise HTTPException(status_code=400, detail="Unknown upload type (use 'github' or 'zip').")

    repo_id = uuid.uuid4().hex

    if kind == "github":
        ru = (repo_url or "").strip()
        if not ru:
            raise HTTPException(status_code=400, detail="Missing repo_url for GitHub upload")
        # background task will broadcast progress + handle errors itself
        background_tasks.add_task(handle_github_clone, ru, repo_id)

    else:  # kind == "zip"
        if file is None:
            raise HTTPException(status_code=400, detail="Missing file for ZIP upload")
        # background task will stream the upload to disk, extract, index, and broadcast progress
        background_tasks.add_task(handle_zip_upload, file, repo_id)

    return {"repoId": repo_id}
