import os
import re
import uuid
import zipfile
import asyncio
import aiofiles
from typing import Optional

from fastapi import UploadFile, HTTPException
from git import Repo, RemoteProgress, GitCommandError

from app.services.indexing import index_repo
from app.services.ws import _broadcast

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

GITHUB_URL_RE = re.compile(
    r'^(https?://)?(www\.)?github\.com/[\w\-_]+/[\w\-_]+(\.git)?/?$',
    re.IGNORECASE,
)

# map GitPython op codes to readable strings
_OP_NAME = {
    RemoteProgress.COUNTING:    "Counting objects",
    RemoteProgress.COMPRESSING: "Compressing objects",
    RemoteProgress.RECEIVING:   "Receiving objects",
    RemoteProgress.RESOLVING:   "Resolving deltas",
    RemoteProgress.WRITING:     "Writing objects",
}

class GitCloneProgress(RemoteProgress):
    def __init__(self, repo_id: str):
        super().__init__()
        self.repo_id = repo_id
        self._last_pct = -1

    def update(self, op_code, cur_count, max_count=None, message=""):
        # determine which operation we're in
        op_key = op_code & self.OP_MASK
        op_name = _OP_NAME.get(op_key, "Cloning")

        # phase start
        if op_code & self.BEGIN:
            _broadcast(
                self.repo_id,
                {"phase": "upload", "progress": 0, "message": f"Starting {op_name}"}
            )

        # known total → compute percentage
        if max_count:
            pct = int(cur_count / max_count * 100)
            if pct != self._last_pct:
                self._last_pct = pct
                _broadcast(
                    self.repo_id,
                    {"phase": "upload", "progress": pct, "message": f"{op_name} ({pct}%)"}
                )
        else:
            # unknown total → just send raw message
            _broadcast(
                self.repo_id,
                {"phase": "upload", "progress": None, "message": message or op_name}
            )

        # phase end
        if op_code & self.END:
            _broadcast(
                self.repo_id,
                {"phase": "upload", "progress": 100, "message": f"{op_name} complete"}
            )

async def handle_github_clone(repo_url: str, repo_id: str) -> None:
    if not GITHUB_URL_RE.match(repo_url.strip()):
        raise HTTPException(
            status_code=400,
            detail="Invalid GitHub URL. Expected format https://github.com/user/repo",
        )

    dest = os.path.join(UPLOAD_DIR, repo_id)
    os.makedirs(dest, exist_ok=True)

    _broadcast(repo_id, {"phase": "upload", "progress": 0, "message": "Starting Git clone"})

    try:
        def do_clone():
            normalized = repo_url.rstrip("/")
            if not normalized.lower().endswith(".git"):
                normalized += ".git"
            Repo.clone_from(
                normalized,
                dest,
                progress=GitCloneProgress(repo_id),
            )

        await asyncio.to_thread(do_clone)

        _broadcast(
            repo_id,
            {"phase": "upload", "progress": 100, "message": "Git clone complete, starting indexing"}
        )
        index_repo(dest, repo_id)

    except GitCommandError as e:
        _broadcast(repo_id, {"phase": "upload", "error": str(e)})
        raise HTTPException(status_code=400, detail=f"Git clone failed: {e}")

    except Exception as e:
        _broadcast(repo_id, {"phase": "upload", "error": str(e)})
        raise HTTPException(status_code=500, detail=f"Git clone failed: {e}")

async def handle_zip_upload(file: UploadFile, repo_id: str) -> None:
    """
    Save an uploaded ZIP, extract it, report progress, then kick off indexing.
    """
    dest = os.path.join(UPLOAD_DIR, repo_id)
    os.makedirs(dest, exist_ok=True)
    zip_path = os.path.join(dest, file.filename or f"{repo_id}.zip")

    # start upload phase
    _broadcast(repo_id, {
        "phase": "upload",
        "progress": 0,
        "message": "Starting ZIP upload"
    })

    try:
        # write incoming file in chunks, reporting bytes written
        written = 0
        chunk_size = 1024 * 1024
        async with aiofiles.open(zip_path, "wb") as out_f:
            while chunk := await file.read(chunk_size):
                await out_f.write(chunk)
                written += len(chunk)
                _broadcast(repo_id, {
                    "phase": "upload",
                    "progress": None,
                    "written_bytes": written,
                    "message": f"Uploading ZIP ({written // 1024} KB)"
                })

        # upload complete → extraction phase
        _broadcast(repo_id, {
            "phase": "upload",
            "progress": 100,
            "message": "ZIP upload complete, extracting archive"
        })

        # extracting ZIP
        _broadcast(repo_id, {
            "phase": "upload",
            "progress": None,
            "message": "Extracting ZIP"
        })
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(dest)
        os.remove(zip_path)

        # extraction complete → indexing phase
        _broadcast(repo_id, {
            "phase": "upload",
            "progress": 100,
            "message": "Extraction complete, starting indexing"
        })

        # kick off indexing
        index_repo(dest, repo_id)

    except Exception as e:
        # any error aborts and notifies frontend
        _broadcast(repo_id, {
            "phase": "upload",
            "error": str(e)
        })
        raise HTTPException(status_code=500, detail=f"ZIP upload failed: {e}")