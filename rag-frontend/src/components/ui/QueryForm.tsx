// src/components/QueryForm.tsx

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
}

export function QueryForm({ repoId, onAsk, onAnswer, onSelectFile }: Props) {
  const { token } = useAuth();

  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // unified progress bar (upload + embedding + indexing)
  const {
    phases,
    uploadPct,
    embeddingPct,
    indexingPct,
    overallPct,
    isIndexed,
    hasError,
  } = useRepoProgress(repoId);

  // show toast on completion / error (once)
  const doneRef = useRef(false);
  useEffect(() => {
    doneRef.current = false; // reset when repo changes
  }, [repoId]);

  useEffect(() => {
    if (!doneRef.current && isIndexed) {
      doneRef.current = true;
      toast.success("Indexing complete!");
    }
    if (hasError) {
      toast.error("Indexing failed. Check logs/status.");
    }
  }, [isIndexed, hasError]);

  const disabled = loading || !question.trim();

  // ask the backend for an answer
  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q) return;

    if (!isIndexed) {
      setError("Indexing is not finished yet.");
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
  }, [question, repoId, token, onAsk, onAnswer, isIndexed]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!disabled) void ask();
    }
  };

  return (
    <div className="space-y-4">
      {/* multi-phase progress (overall + per phase) via repo progress component */}
      <RepoProgress
        upload={{ status: phases.upload.status, pct: uploadPct }}
        embedding={{ status: phases.embedding.status, pct: embeddingPct }}
        indexing={{ status: phases.indexing.status, pct: indexingPct }}
        overallPct={overallPct}
      />

      {/* live file tree */}
      <FileTree repoId={repoId} onSelectFile={onSelectFile} />

      <Textarea
        placeholder="Ask a question about your code… (Ctrl/Cmd+Enter)"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={loading}
      />

      {error && <div className="text-red-500 text-sm">{error}</div>}

      <Button onClick={ask} disabled={disabled || !isIndexed}>
        {loading ? "Thinking…" : isIndexed ? "Ask" : "Indexing…"}
      </Button>
    </div>
  );
}
