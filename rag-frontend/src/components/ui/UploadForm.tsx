import React, { useState, useCallback, useRef, useEffect } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { toast } from "../../lib/toast";
import api from "../../lib/api";
import { Github, File as FileIcon } from "lucide-react";
import { useAuth } from "../../context/AuthContext";

type Props = {
  onRepoId: (id: string) => void;
  onIndexingComplete?: (id: string) => void;
};

type ProgressMessage = {
  phase?: "upload" | "indexing" | "done" | "indexed" | "error";
  progress?: number | null;
  message?: string;
  repoId?: string;
  error?: string;
};

const MAX_WS_RECONNECTS = 5; // after this, rely on polling only
const POLL_MS = 2000; // /repos/{id}/status poll interval

export function UploadForm({ onRepoId, onIndexingComplete }: Props) {
  const { token } = useAuth();

  const [repoUrl, setRepoUrl] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);

  const [repoId, setRepoId] = useState<string | null>(null);

  const [uploadPhase, setUploadPhase] = useState<
    "idle" | "upload" | "done" | "error"
  >("idle");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadType, setUploadType] = useState<"github" | "zip" | null>(null);

  const [indexingPhase, setIndexingPhase] = useState<
    "idle" | "indexing" | "indexed" | "error"
  >("idle");
  const [indexingProgress, setIndexingProgress] = useState<number | null>(null);

  // --- refs to control one-shot behaviors
  const wsRef = useRef<WebSocket | null>(null);
  const completedRef = useRef(false);
  const reconnectRef = useRef(0);
  const unmountedRef = useRef(false);
  const pollRef = useRef<number | null>(null);

  // keep a stable reference to the completion callback
  const onCompleteRef = useRef(onIndexingComplete);
  useEffect(() => {
    onCompleteRef.current = onIndexingComplete;
  }, [onIndexingComplete]);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // close and clear the websocket safely
  const closeWS = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
  }, []);

  // mark as indexed + fire completion
  const finishOnce = useCallback(
    (rid: string) => {
      if (completedRef.current) return;
      completedRef.current = true;
      setUploadPhase("done");
      setIndexingPhase("indexed");
      setIndexingProgress(100);
      onCompleteRef.current?.(rid);
      clearPoll();
      closeWS();
    },
    [clearPoll, closeWS]
  );

  // poll /status as a safe fallback (covers “index already exists” or WS silence)
  const startPolling = useCallback(
    (rid: string) => {
      clearPoll();
      pollRef.current = window.setInterval(async () => {
        if (completedRef.current || unmountedRef.current) return;
        try {
          const res = await fetch(`/api/repos/${rid}/status`);
          if (!res.ok) return;
          const data = await res.json();
          if (data?.status === "indexed") {
            finishOnce(rid);
          } else if (data?.status === "indexing") {
            setIndexingPhase("indexing");
          }
        } catch {
          // ignore; try again next tick
        }
      }, POLL_MS);
    },
    [clearPoll, finishOnce]
  );

  // connect to WS after repoId + token is retrieved
  useEffect(() => {
    if (!repoId || !token) return;
    if (completedRef.current || unmountedRef.current) return;

    let closedByUs = false;

    const connect = () => {
      if (completedRef.current || unmountedRef.current) return;

      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({ token, repo_id: repoId });
      const wsUrl = `${scheme}://${window.location.host}/ws/progress?${params}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // reset reconnect counter
        reconnectRef.current = 0;
      };

      ws.onmessage = (evt) => {
        let msg: ProgressMessage | null = null;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }

        switch (msg?.phase) {
          case "upload": {
            setUploadPhase("upload");
            if (typeof msg.progress === "number")
              setUploadProgress(msg.progress);
            break;
          }
          case "indexing": {
            setIndexingPhase("indexing");
            if (typeof msg.progress === "number")
              setIndexingProgress(msg.progress);
            break;
          }
          case "indexed":
          case "done": {
            finishOnce(repoId);
            closedByUs = true;
            closeWS();
            break;
          }
          case "error":
          default: {
            if (!completedRef.current) {
              setUploadPhase("error");
              setIndexingPhase("error");
              toast.error("Indexing error: " + (msg?.error ?? "unknown"));
            }
            closedByUs = true;
            closeWS();
            break;
          }
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (closedByUs || completedRef.current || unmountedRef.current) return;

        // bounded reconnect; polling continues in the background
        if (reconnectRef.current < MAX_WS_RECONNECTS) {
          const backoff = Math.min(10000, 1000 * 2 ** reconnectRef.current);
          reconnectRef.current += 1;
          window.setTimeout(() => {
            if (!completedRef.current && !unmountedRef.current) connect();
          }, backoff);
        }
      };
    };

    connect();

    return () => {
      closedByUs = true;
      closeWS();
      clearPoll();
    };
  }, [repoId, token, startPolling, finishOnce, closeWS, clearPoll]);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      clearPoll();
      closeWS();
    };
  }, [clearPoll, closeWS]);

  const handleUpload = useCallback(
    async (type: "github" | "zip") => {
      if (!token) {
        toast.error("Not authenticated");
        return;
      }
      if (
        uploadType &&
        (uploadPhase === "upload" || indexingPhase === "indexing")
      ) {
        // prevent starting another upload mid-flight
        return;
      }

      // reset state for a fresh run
      completedRef.current = false;
      reconnectRef.current = 0;
      setUploadType(type);
      setUploadPhase("upload");
      setUploadProgress(type === "zip" ? 0 : null); // GitHub clone progress unknown
      setIndexingPhase("idle");
      setIndexingProgress(null);
      setRepoId(null); // clear until server returns new id
      clearPoll();
      closeWS();

      const form = new FormData();
      form.append("type", type);
      if (type === "github") {
        form.append("repo_url", repoUrl.trim());
      } else {
        if (!zipFile) {
          toast.error("Pick a ZIP file first");
          setUploadPhase("error");
          return;
        }
        form.append("file", zipFile);
      }

      try {
        const res = await api.post("/upload", form, {
          headers: { "Content-Type": "multipart/form-data" },
          onUploadProgress: (e) => {
            if (type === "zip") {
              const pct = Math.round((e.loaded * 100) / (e.total ?? e.loaded));
              setUploadProgress(pct);
            }
          },
        });

        const id = (res?.data?.repoId ?? res?.data?.repo_id) as
          | string
          | undefined;
        if (!id) {
          toast.error("Upload response missing repoId");
          setUploadPhase("error");
          return;
        }

        setRepoId(id);
        onRepoId(id);

        // UX toasts
        toast.success(type === "github" ? "Cloning started" : "Upload started");

        // WS + poll handle progress & completion
      } catch (err: any) {
        const status = err?.response?.status;
        const body = err?.response?.data;
        const detail =
          body?.detail ??
          (typeof body === "string" ? body : JSON.stringify(body ?? {}));
        toast.error(
          `Upload failed${status ? ` (${status})` : ""}${
            detail ? `: ${detail}` : ""
          }`
        );
        setUploadPhase("error");
        setIndexingPhase("error");
      }
    },
    [
      token,
      uploadType,
      uploadPhase,
      indexingPhase,
      repoUrl,
      zipFile,
      onRepoId,
      clearPoll,
      closeWS,
    ]
  );

  const isBusy = uploadPhase === "upload" || indexingPhase === "indexing";

  return (
    <div className="space-y-6 bg-slate-100 dark:bg-slate-900 p-5 rounded-lg">
      {/* GitHub URL upload */}
      <div className="flex gap-2">
        <div className="flex-1 flex items-center bg-white dark:bg-gray-800 rounded-md border overflow-hidden">
          <div className="px-2 pointer-events-none">
            <Github className="w-5 h-5 text-gray-600 dark:text-gray-300" />
          </div>
          <Input
            placeholder="GitHub repo URL"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            disabled={isBusy}
          />
        </div>
        <Button
          onClick={() => handleUpload("github")}
          disabled={isBusy || !repoUrl.trim()}
        >
          Clone Repo
        </Button>
      </div>

      <div className="text-center text-sm text-gray-500">OR</div>

      {/* ZIP file upload */}
      <div className="flex gap-2">
        <div className="flex-1 flex items-center bg-white dark:bg-gray-800 rounded-md border overflow-hidden">
          <div className="px-2 pointer-events-none">
            <FileIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
          </div>
          <input
            type="file"
            accept=".zip"
            disabled={isBusy}
            onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
            className="flex-1 outline-none py-2 px-3 bg-transparent text-sm"
          />
        </div>
        <Button
          onClick={() => handleUpload("zip")}
          disabled={isBusy || !zipFile}
        >
          Upload ZIP
        </Button>
      </div>

      {/* upload progress */}
      {uploadPhase === "upload" && (
        <div className="space-y-1">
          <div className="text-sm">
            {uploadType === "github" ? "Cloning repository…" : "Uploading…"}
          </div>
          {uploadProgress === null ? (
            <Progress className="w-full" /> // indeterminate
          ) : (
            <Progress value={uploadProgress} max={100} className="w-full" />
          )}
        </div>
      )}

      {/* indexing progress */}
      {indexingPhase !== "idle" && (
        <div className="space-y-1">
          <div className="text-sm">
            {indexingPhase === "indexing"
              ? "Indexing…"
              : indexingPhase === "indexed"
              ? "Indexed!"
              : "Indexing error"}
          </div>
          <Progress
            value={indexingPhase === "indexed" ? 100 : indexingProgress ?? 0}
            max={100}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}
