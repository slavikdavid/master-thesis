import { useState, useCallback, useRef, useEffect } from "react";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { toast } from "../../lib/toast";
import axios from "axios";
import { useAuth } from "../../context/AuthContext";

import { FileTree } from "./FileTree";
import { useRepoProgress } from "../../hooks/useRepoProgress";
import RepoProgress from "./RepoProgress";

interface Props {
  repoId: string;
  onAsk: (question: string) => void;
  onAnswer: (answer: string) => void;
  onSelectFile: (filePath: string, content: string) => void;
  mode?: "full" | "composer";
  /** New: parent can signal readiness (e.g., from /status docs>0). */
  ready?: boolean;
  /** New: parent can force-disable (ChatPage was already passing this). */
  disabled?: boolean;
}

export function QueryForm({
  repoId,
  onAsk,
  onAnswer,
  onSelectFile,
  mode = "full",
  ready,
  disabled: disabledProp,
}: Props) {
  const { token } = useAuth();

  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // unified progress (upload + embedding + indexing). May be empty after F5.
  const {
    phases,
    uploadPct,
    embeddingPct,
    indexingPct,
    overallPct,
    isIndexed, // broker-derived; may be false after reload even if repo is ready
    hasError,
  } = useRepoProgress(repoId);

  // One-time toasts in full mode
  const doneRef = useRef(false);
  useEffect(() => {
    doneRef.current = false; // reset when repo changes
  }, [repoId]);

  useEffect(() => {
    if (!doneRef.current && isIndexed && mode === "full") {
      doneRef.current = true;
      toast.success("Indexing complete!");
    }
    if (hasError && mode === "full") {
      toast.error("Indexing failed. Check logs/status.");
    }
  }, [isIndexed, hasError, mode]);

  // Parent readiness takes precedence; if not provided, fall back to broker.
  // If parent passed disabled, invert it (disabled=false means ready).
  const parentReady =
    typeof disabledProp === "boolean" ? !disabledProp : !!ready;

  // Final gate: allow sending if parent OR broker says ready.
  const canAsk = parentReady || isIndexed;

  // Local input/button disabled (not the readiness gate)
  const inputDisabled = loading;
  const sendDisabled = inputDisabled || !question.trim() || !canAsk;

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q) return;

    if (!canAsk) {
      setError("Repository is not ready yet.");
      return;
    }

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
          setError("Repository is not ready yet. Please wait a moment.");
        } else {
          setError(detail || "Failed to get answer");
        }
      } else {
        setError(err?.message || "Failed to get answer");
      }
    } finally {
      setLoading(false);
    }
  }, [question, repoId, token, onAsk, onAnswer, canAsk]);

  // Keyboard UX:
  // - In composer mode: Enter = send, Shift+Enter = newline
  // - In full mode: Ctrl/Cmd+Enter = send, Enter = newline
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mode === "composer") {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!sendDisabled) void ask();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!sendDisabled) void ask();
    }
  };

  return mode === "composer" ? (
    // --- COMPOSER (bottom bar) ---
    <div className="w-full">
      <div className="rounded-xl border p-2 shadow-sm bg-white dark:bg-zinc-900">
        <Textarea
          placeholder="Ask a question about your code…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={inputDisabled}
          className="resize-none border-0 focus-visible:ring-0 focus-visible:outline-none"
          rows={3}
        />
        {error && <div className="text-red-500 text-sm mt-2">{error}</div>}
        <div className="flex items-center justify-end gap-2 mt-2">
          <div className="text-xs text-gray-500 mr-auto">
            {loading ? "Thinking…" : "Shift+Enter for newline • Enter to send"}
          </div>
          <Button onClick={ask} disabled={sendDisabled}>
            {loading ? "Thinking…" : canAsk ? "Send" : "Indexing…"}
          </Button>
        </div>
      </div>
      <div className="h-4 md:h-2" />
    </div>
  ) : (
    // --- FULL (original) ---
    <div className="space-y-4">
      <RepoProgress
        upload={{ status: phases.upload.status, pct: uploadPct }}
        embedding={{ status: phases.embedding.status, pct: embeddingPct }}
        indexing={{ status: phases.indexing.status, pct: indexingPct }}
        overallPct={overallPct}
      />

      <FileTree repoId={repoId} onSelectFile={onSelectFile} />

      <Textarea
        placeholder="Ask a question about the codebase… (Ctrl/Cmd+Enter)"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={inputDisabled}
      />

      {error && <div className="text-red-500 text-sm">{error}</div>}

      <Button onClick={ask} disabled={sendDisabled}>
        {loading ? "Thinking…" : canAsk ? "Ask" : "Indexing…"}
      </Button>
    </div>
  );
}
