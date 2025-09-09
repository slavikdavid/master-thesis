import { useState, useCallback, useRef, useEffect } from "react";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { toast } from "../../lib/toast";
import { useRepoProgress } from "../../hooks/useRepoProgress";
import RepoProgress from "./RepoProgress";

interface Props {
  repoId: string;
  onAsk: (question: string) => void;
  onAnswer: (answer: string) => void; // kept for API compatibility; unused here
  onSelectFile: (filePath: string, content: string) => void;
  mode?: "full" | "composer";
  /** optional readiness override from parent (preferred) */
  ready?: boolean;
  /** optional disabled from parent */
  disabled?: boolean;
}

export function QueryForm({
  repoId,
  onAsk,
  onAnswer, // unused in this variant
  onSelectFile,
  mode = "full",
  ready,
  disabled: disabledProp,
}: Props) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    phases,
    uploadPct,
    embeddingPct,
    indexingPct,
    overallPct,
    isIndexed,
    hasError,
  } = useRepoProgress(repoId);

  const doneRef = useRef(false);
  useEffect(() => {
    doneRef.current = false;
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

  // parent readiness wins; else fall back to broker
  const parentReady =
    typeof disabledProp === "boolean" ? !disabledProp : !!ready;
  const canAsk = parentReady || isIndexed;

  const sendDisabled = loading || !question.trim() || !canAsk;

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q) return;
    if (!canAsk) {
      setError("Repository is not ready yet.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Delegate networking to parent
      onAsk(q);
      setQuestion("");
    } finally {
      setLoading(false);
    }
  }, [question, canAsk, onAsk]);

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
    <div className="w-full">
      <div className="rounded-xl border p-2 shadow-sm bg-white dark:bg-zinc-900">
        <Textarea
          placeholder="Ask a question about your code…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={loading}
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
    <div className="space-y-4">
      <RepoProgress
        upload={{ status: phases.upload.status, pct: uploadPct }}
        embedding={{ status: phases.embedding.status, pct: embeddingPct }}
        indexing={{ status: phases.indexing.status, pct: indexingPct }}
        overallPct={overallPct}
      />
      {/* Optional file tree */}
      {/* <FileTree repoId={repoId} onSelectFile={onSelectFile} /> */}
      <Textarea
        placeholder="Ask a question about the codebase… (Ctrl/Cmd+Enter)"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={loading}
      />
      {error && <div className="text-red-500 text-sm">{error}</div>}
      <Button onClick={ask} disabled={sendDisabled}>
        {loading ? "Thinking…" : canAsk ? "Ask" : "Indexing…"}
      </Button>
    </div>
  );
}
