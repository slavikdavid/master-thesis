import os
from pathlib import Path
import json

DATA_DIR = Path("data/repos")
UPLOAD_DIR = Path("uploads")
DATA_DIR.mkdir(parents=True, exist_ok=True)

def list_files(repo_id: str):
    files = []
    repo = UPLOAD_DIR / repo_id
    for root, _, filenames in os.walk(repo):
        for fn in filenames:
            rel = os.path.relpath(os.path.join(root, fn), repo)
            files.append(rel)
    return files

def read_file(repo_id: str, rel_path: str) -> str:
    full = UPLOAD_DIR / repo_id / rel_path
    if not full.exists():
        raise FileNotFoundError
    return full.read_text(encoding="utf-8")
