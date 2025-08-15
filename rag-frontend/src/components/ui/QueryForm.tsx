// src/components/QueryForm.tsx
import { useState, useEffect, useRef, useCallback } from "react";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { toast } from "../../lib/toast";
import axios from "axios";
import { useAuth } from "../../context/AuthContext";

import { IndexStatus } from "./IndexStatus";
import { FileTree } from "./FileTree";

interface Props {
  repoId: string;
  onAsk: (question: string) => void;
  onAnswer: (answer: string) => void;
  onSelectFile: (filePath: string) => void;
}

type StatusMsg = {
  status?: "upload" | "indexing" | "indexed" | "done" | "error" | string;
  message?: string;
  processed?: number;
  total?: number;
};

type ProgressMsg = {
  phase?: "upload" | "indexing" | "indexed" | "done" | "error" | string;
  progress?: number | null;
  message?: string;
};

export function QueryForm({ repoId, onAsk, onAnswer, onSelectFile }: Props) {
  const { token } = useAuth();

  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // live status UI
  const [phase, setPhase] = useState<string>("idle");
  const [progress, setProgress] = useState<number>(0);

  const statusWs = useRef<WebSocket | null>(null);
  const progWs = useRef<WebSocket | null>(null);

  const disabled = loading || !question.trim();

  const buildWsUrl = useCallback(
    (path: "/api/ws/status" | "/api/ws/progress") => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const qs = new URLSearchParams({
        token: token ?? "",
        repo_id: repoId,
      }).toString();
      return `${scheme}://${window.location.host}${path}?${qs}`;
    },
    [repoId, token]
  );

  // ask the backend for an answer
  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q) return;

    onAsk(q);
    setLoading(true);
    setError(null);

    try {
      const { data } = await axios.post(
        "/api/repos/v2/answer",
        { repo_id: repoId, query: q },
        token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
      );
      onAnswer(data.answer);
      setQuestion(""); // clear only after success
    } catch (err: any) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const detail =
          (err.response?.data as any)?.detail ??
          (typeof err.response?.data === "string"
            ? err.response?.data
            : err.message);
        if (status === 409) {
          setError("Indexing not complete yet. Please wait a moment.");
        } else {
          setError(detail || "Failed to get answer");
        }
      } else {
        setError(err?.message || "Failed to get answer");
      }
    } finally {
      setLoading(false);
    }
  }, [question, repoId, token, onAsk, onAnswer]);

  // STATUS WS (streams whole status objects)
  useEffect(() => {
    if (!repoId || !token) return;

    let shouldReconnect = true;
    let attempt = 0;
    let closedByUs = false;

    const connect = () => {
      const url = buildWsUrl("/api/ws/status");
      const ws = new WebSocket(url);
      statusWs.current = ws;

      ws.onopen = () => {
        attempt = 0;
      };

      ws.onmessage = (evt) => {
        let msg: StatusMsg | null = null;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        const s = (msg?.status || "").toLowerCase();
        if (s) setPhase(s);

        if (
          s === "indexing" &&
          typeof msg?.processed === "number" &&
          typeof msg?.total === "number" &&
          (msg?.total ?? 0) > 0
        ) {
          setProgress(
            Math.max(
              0,
              Math.min(100, Math.round((msg.processed! / msg.total!) * 100))
            )
          );
        }

        if (s === "indexed" || s === "done") {
          setProgress(100);
          toast.success("Indexing complete!");
          shouldReconnect = false;
          closedByUs = true;
          try {
            ws.close(1000, "indexed");
          } catch {}
        } else if (s === "error") {
          toast.error(msg?.message || "Indexing failed");
          shouldReconnect = false;
          closedByUs = true;
          try {
            ws.close(1011, "error");
          } catch {}
        }
      };

      ws.onclose = () => {
        statusWs.current = null;
        if (closedByUs || !shouldReconnect) return;
        const delay = Math.min(10000, 500 * 2 ** attempt);
        attempt += 1;
        setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      shouldReconnect = false;
      try {
        statusWs.current?.close(1000, "unmount");
      } catch {}
      statusWs.current = null;
    };
  }, [repoId, token, buildWsUrl]);

  // PROGRESS WS (compact {"phase","progress"})
  useEffect(() => {
    if (!repoId || !token) return;

    let shouldReconnect = true;
    let attempt = 0;
    let closedByUs = false;

    const connect = () => {
      const url = buildWsUrl("/api/ws/progress");
      const ws = new WebSocket(url);
      progWs.current = ws;

      ws.onopen = () => {
        attempt = 0;
      };

      ws.onmessage = (evt) => {
        let msg: ProgressMsg | null = null;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }

        if (msg?.phase) setPhase(String(msg.phase).toLowerCase());
        if (typeof msg?.progress === "number") setProgress(msg.progress);

        if (msg?.phase === "indexed" || msg?.phase === "done") {
          setProgress(100);
          shouldReconnect = false;
          closedByUs = true;
          try {
            ws.close(1000, "done");
          } catch {}
        } else if (msg?.phase === "error") {
          shouldReconnect = false;
          closedByUs = true;
          try {
            ws.close(1011, "error");
          } catch {}
        }
      };

      ws.onclose = () => {
        progWs.current = null;
        if (closedByUs || !shouldReconnect) return;
        const delay = Math.min(10000, 500 * 2 ** attempt);
        attempt += 1;
        setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      shouldReconnect = false;
      try {
        progWs.current?.close(1000, "unmount");
      } catch {}
      progWs.current = null;
    };
  }, [repoId, token, buildWsUrl]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!disabled) void ask();
    }
  };

  return (
    <div className="space-y-4">
      <IndexStatus phase={phase} progress={progress} />
      <FileTree repoId={repoId} onSelectFile={onSelectFile} />

      <Textarea
        placeholder="Ask a question about your code… (Ctrl/Cmd+Enter)"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={loading}
      />

      {error && <div className="text-red-500 text-sm">{error}</div>}

      <Button onClick={ask} disabled={disabled}>
        {loading ? "Thinking…" : "Ask"}
      </Button>
    </div>
  );
}
