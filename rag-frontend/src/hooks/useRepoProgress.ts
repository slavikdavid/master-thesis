// src/hooks/useRepoProgress.ts
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";

type PhaseStatus = "queued" | "running" | "complete" | "error";
type PhaseState = { status: PhaseStatus; pct?: number };
type Phases = {
  upload: PhaseState;
  embedding: PhaseState;
  indexing: PhaseState;
};

export function useRepoProgress(repoId?: string | null) {
  const { token } = useAuth();
  const [phases, setPhases] = useState<Phases>(initialPhases());

  // bounded reconnects
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectsRef = useRef(0);
  const doneRef = useRef(false);

  useEffect(() => {
    // reset when repo/token changes
    setPhases(initialPhases());
    doneRef.current = false;

    if (!repoId || !token) return;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const qs = new URLSearchParams({ token, repo_id: repoId }).toString();
      const url = `${proto}://${window.location.host}/api/ws/progress?${qs}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectsRef.current = 0;
      };

      ws.onmessage = (ev) => {
        let m: any;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }

        const phase = String(m.phase || "").toLowerCase();
        const event = String(m.event || "").toLowerCase();
        const progress = toNumOrUndef(m.progress);

        setPhases((prev) => {
          const next = { ...prev };

          if (phase === "upload") {
            const pct =
              typeof progress === "number"
                ? clampPct(progress)
                : pctFromCounts(m.written_bytes, m.total_bytes);
            next.upload = {
              status: m.error
                ? "error"
                : event === "complete" || pct === 100
                ? "complete"
                : "running",
              pct,
            };
          } else if (phase === "embedding") {
            const pct =
              typeof progress === "number"
                ? clampPct(progress)
                : pctFromCounts(m.processed, m.total);
            next.embedding = {
              status: m.error
                ? "error"
                : event === "complete" || pct === 100
                ? "complete"
                : "running",
              pct,
            };
          } else if (phase === "indexing") {
            const pct =
              typeof progress === "number"
                ? clampPct(progress)
                : pctFromCounts(m.processed, m.total);
            next.indexing = {
              status: m.error
                ? "error"
                : event === "complete" || pct === 100
                ? "complete"
                : "running",
              pct,
            };
          } else if (phase === "indexed") {
            // mark all phases done
            next.upload =
              next.upload.status === "complete"
                ? next.upload
                : { status: "complete", pct: 100 };
            next.embedding = { status: "complete", pct: 100 };
            next.indexing = { status: "complete", pct: 100 };
            doneRef.current = true;
          } else if (phase === "error") {
            // propagate error to any phase not already complete
            next.upload =
              next.upload.status === "complete"
                ? next.upload
                : { status: "error", pct: next.upload.pct };
            next.embedding =
              next.embedding.status === "complete"
                ? next.embedding
                : { status: "error", pct: next.embedding.pct };
            next.indexing =
              next.indexing.status === "complete"
                ? next.indexing
                : { status: "error", pct: next.indexing.pct };
            doneRef.current = true;
          }

          return next;
        });
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (doneRef.current) return;
        // bounded reconnect with backoff
        if (reconnectsRef.current < 5) {
          const backoff = Math.min(10000, 800 * 2 ** reconnectsRef.current);
          reconnectsRef.current += 1;
          setTimeout(() => {
            if (!doneRef.current) connect();
          }, backoff);
        }
      };

      ws.onerror = () => {};
    };

    connect();

    return () => {
      doneRef.current = true;
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, [repoId, token]);

  const uploadPct = phases.upload.pct;
  const embeddingPct = phases.embedding.pct;
  const indexingPct = phases.indexing.pct;

  const overallPct = useMemo(() => {
    const parts = [uploadPct, embeddingPct, indexingPct].filter(
      (p): p is number => typeof p === "number" && !Number.isNaN(p)
    );
    if (!parts.length) return undefined;
    return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  }, [uploadPct, embeddingPct, indexingPct]);

  const isIndexed =
    phases.upload.status === "complete" &&
    phases.embedding.status === "complete" &&
    phases.indexing.status === "complete";

  const hasError =
    phases.upload.status === "error" ||
    phases.embedding.status === "error" ||
    phases.indexing.status === "error";

  const isActive =
    !isIndexed &&
    !hasError &&
    (phases.upload.status === "running" ||
      phases.embedding.status === "running" ||
      phases.indexing.status === "running");

  return {
    phases,
    uploadPct,
    embeddingPct,
    indexingPct,
    overallPct,
    isIndexed,
    hasError,
    isActive,
  };
}

function initialPhases(): Phases {
  return {
    upload: { status: "queued" },
    embedding: { status: "queued" },
    indexing: { status: "queued" },
  };
}

function clampPct(n: number) {
  return Math.max(0, Math.min(100, Math.round(n)));
}
function toNumOrUndef(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}
function pctFromCounts(processed?: any, total?: any) {
  const p = Number(processed),
    t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return undefined;
  return clampPct((p / t) * 100);
}
