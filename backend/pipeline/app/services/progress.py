# app/services/progress.py
import asyncio
import json
import os
import time
from typing import Any, AsyncIterator, Dict, Optional

class ProgressBroker:
    """Interface"""

    async def update(
        self,
        repo_id: str,
        phase: str,            # "upload" | "embedding" | "indexing"
        status: str,           # "queued" | "running" | "complete" | "error"
        processed: Optional[int] = None,
        total: Optional[int] = None,
        message: Optional[str] = None,
        error: Optional[str] = None,
    ) -> Dict[str, Any]:
        raise NotImplementedError

    async def snapshot(self, repo_id: str) -> Dict[str, Any]:
        raise NotImplementedError

    async def subscribe(self, repo_id: str) -> AsyncIterator[Dict[str, Any]]:
        raise NotImplementedError


class InMemoryProgressBroker(ProgressBroker):
    def __init__(self) -> None:
        self._snapshots: Dict[str, Dict[str, Any]] = {}
        self._subs: Dict[str, set[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()

    def _mk_base(self, repo_id: str) -> Dict[str, Any]:
        return {"repoId": repo_id, "phases": {}}

    def _overall(self, phases: Dict[str, Any]) -> Dict[str, Any]:
        def pct(p, t): return int(p * 100 / t) if (isinstance(p, int) and isinstance(t, int) and t > 0) else None
        up = phases.get("upload") or {}
        emb = phases.get("embedding") or {}
        idx = phases.get("indexing") or {}

        if (idx.get("status") == "complete"):
            return {"status": "indexed", "processed": idx.get("processed", 0), "total": idx.get("total", 0)}

        if idx.get("status") in ("running", "queued", "error"):
            st = "indexing" if idx.get("status") != "error" else "error"
            return {"status": st, "processed": idx.get("processed", 0), "total": idx.get("total", 0)}

        if emb.get("status") in ("running", "queued", "complete", "error"):
            st = "indexing" if emb.get("status") != "error" else "error"
            return {"status": st, "processed": emb.get("processed", 0), "total": emb.get("total", 0)}

        if up.get("status") in ("running", "queued"):
            return {"status": "upload", "processed": 0, "total": 0}
        if up.get("status") == "error":
            return {"status": "error", "processed": 0, "total": 0}
        return {"status": "unknown", "processed": 0, "total": 0}

    async def update(self, repo_id: str, phase: str, status: str,
                     processed: Optional[int]=None, total: Optional[int]=None,
                     message: Optional[str]=None, error: Optional[str]=None) -> Dict[str, Any]:
        async with self._lock:
            snap = self._snapshots.setdefault(repo_id, self._mk_base(repo_id))
            phases = snap.setdefault("phases", {})
            cur = phases.get(phase, {"status": "queued", "processed": 0, "total": None, "startedAt": time.time()})
            cur["status"] = status
            if processed is not None: cur["processed"] = processed
            if total is not None: cur["total"] = total
            if message is not None: cur["message"] = message
            if error is not None: cur["error"] = error
            if status in ("complete", "error"): cur["finishedAt"] = time.time()
            # compute processed %
            p = cur.get("processed"); t = cur.get("total")
            if isinstance(p, int) and isinstance(t, int) and t > 0:
                cur["progress"] = max(0, min(100, int(p * 100 / t)))
            phases[phase] = cur

            snap.update(self._overall(phases))

            # notify subs
            payload = {
                "type": "task_update",
                "repoId": repo_id,
                "phase": phase,
                "status": status,
                "processed": cur.get("processed"),
                "total": cur.get("total"),
                "progress": cur.get("progress"),
                "message": message,
                "error": error,
                "event": "progress" if status == "running" else status,
            }
            for q in self._subs.get(repo_id, set()):
                try: q.put_nowait(payload)
                except: pass
            return snap

    async def snapshot(self, repo_id: str) -> Dict[str, Any]:
        async with self._lock:
            return json.loads(json.dumps(self._snapshots.get(repo_id) or self._mk_base(repo_id)))

    async def subscribe(self, repo_id: str) -> AsyncIterator[Dict[str, Any]]:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        async with self._lock:
            self._subs.setdefault(repo_id, set()).add(q)
            # yield current snapshot
            yield await self.snapshot(repo_id)
        try:
            while True:
                yield await q.get()
        finally:
            async with self._lock:
                self._subs.get(repo_id, set()).discard(q)

# choose backend
BROKER: ProgressBroker = InMemoryProgressBroker()