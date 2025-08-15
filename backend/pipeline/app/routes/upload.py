# app/routes/upload.py

import uuid
from fastapi import APIRouter, BackgroundTasks, UploadFile, HTTPException, Form, File
from app.services.upload import handle_github_clone, handle_zip_upload

router = APIRouter()

@router.post("/upload", status_code=202)
async def upload_repo(
    background_tasks: BackgroundTasks,
    type: str = Form(..., description="Either 'github' or 'zip'"),
    repo_url: str | None = Form(None, description="GitHub URL, when type=github"),
    file: UploadFile | None = File(None, description="ZIP file, when type=zip"),
):
    """
    Start a repo upload (GitHub clone or ZIP extract) in the background,
    returning a repoId with HTTP 202 on success.
    """
    repo_id = uuid.uuid4().hex

    if type == "github":
        if not repo_url:
            raise HTTPException(status_code=400, detail="Missing repo_url for GitHub upload")
        background_tasks.add_task(handle_github_clone, repo_url, repo_id)

    elif type == "zip":
        if not file:
            raise HTTPException(status_code=400, detail="Missing file for ZIP upload")
        background_tasks.add_task(handle_zip_upload, file, repo_id)

    else:
        raise HTTPException(status_code=400, detail="Unknown upload type")

    return {"repoId": repo_id}