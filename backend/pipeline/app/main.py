import os
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from app.db import connect_db, disconnect_db
from app.routes import (
    auth,
    users, roles, user_roles, teams, team_members,
    conversations, messages, documents, document_chunks,
    audit_logs, rag_queries, retrieved_chunks,
    feedback, usage_metrics, user_sessions,
    upload, repos, websocket, rag, summary
)

DOTENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
if DOTENV_PATH.exists():
    load_dotenv(DOTENV_PATH)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    try:
        yield
    finally:
        await disconnect_db()

app = FastAPI(
    title="Codebase RAG API",
    version="2.0.0",
    description="Retrieval-augmented codebase API",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in [
    auth.router,
    users.router, roles.router, user_roles.router, teams.router, team_members.router,
    conversations.router, messages.router, documents.router, document_chunks.router,
    audit_logs.router, rag_queries.router, retrieved_chunks.router,
    feedback.router, usage_metrics.router, user_sessions.router,
    upload.router, repos.router, rag.router, summary.router,
]:
    app.include_router(router, prefix="/api")

app.include_router(websocket.router)

@app.get("/api/health")
def health():
    return {"status": "ok"}