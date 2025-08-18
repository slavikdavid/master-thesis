// src/components/forms/UploadForm.tsx
import React, { useState, useCallback } from "react";
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

export function UploadForm({ onRepoId }: Props) {
  const { token } = useAuth();

  const [repoUrl, setRepoUrl] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadType, setUploadType] = useState<"github" | "zip" | null>(null);

  const handleUpload = useCallback(
    async (type: "github" | "zip") => {
      if (!token) {
        toast.error("Not authenticated");
        return;
      }
      if (isSubmitting) return;

      setIsSubmitting(true);
      setUploadType(type);
      setUploadPct(type === "zip" ? 0 : null);

      const form = new FormData();
      form.append("type", type);

      if (type === "github") {
        const url = repoUrl.trim();
        if (!url) {
          toast.error("Enter a GitHub URL");
          setIsSubmitting(false);
          return;
        }
        form.append("repo_url", url);
      } else {
        if (!zipFile) {
          toast.error("Pick a ZIP file first");
          setIsSubmitting(false);
          return;
        }
        form.append("file", zipFile);
      }

      try {
        const res = await api.post("/upload", form, {
          headers: {
            "Content-Type": "multipart/form-data",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          onUploadProgress: (e) => {
            // zip uploads progress calculated on client-side,
            // (in contrast, github clone progress is calculated on server-side)
            if (type === "zip") {
              const pct = Math.round((e.loaded * 100) / (e.total ?? e.loaded));
              setUploadPct(pct);
            }
          },
        });

        const id = (res?.data?.repoId ?? res?.data?.repo_id) as
          | string
          | undefined;
        if (!id) {
          toast.error("Upload response missing repoId");
          return;
        }

        onRepoId(id);
        toast.success(type === "github" ? "Cloning started" : "Upload started");

        setRepoUrl("");
        setZipFile(null);
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
      } finally {
        setIsSubmitting(false);
      }
    },
    [token, isSubmitting, repoUrl, zipFile, onRepoId]
  );

  const busy = isSubmitting;

  return (
    <div className="space-y-6 bg-slate-100 dark:bg-slate-900 p-5 rounded-lg">
      {/* github URL upload */}
      <div className="flex gap-2">
        <div className="flex-1 flex items-center bg-white dark:bg-gray-800 rounded-md border overflow-hidden">
          <div className="px-2 pointer-events-none">
            <Github className="w-5 h-5 text-gray-600 dark:text-gray-300" />
          </div>
          <Input
            placeholder="GitHub repo URL"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            disabled={busy}
          />
        </div>
        <Button
          onClick={() => handleUpload("github")}
          disabled={busy || !repoUrl.trim()}
        >
          Clone Repo
        </Button>
      </div>

      <div className="text-center text-sm text-gray-500">OR</div>

      {/* zip file upload */}
      <div className="flex gap-2">
        <div className="flex-1 flex items-center bg-white dark:bg-gray-800 rounded-md border overflow-hidden">
          <div className="px-2 pointer-events-none">
            <FileIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
          </div>
          <input
            type="file"
            accept=".zip"
            disabled={busy}
            onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
            className="flex-1 outline-none py-2 px-3 bg-transparent text-sm"
          />
        </div>
        <Button onClick={() => handleUpload("zip")} disabled={busy || !zipFile}>
          Upload ZIP
        </Button>
      </div>

      {/* local client-side upload progress (zip files only) */}
      {uploadType === "zip" && typeof uploadPct === "number" && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Uploading ZIP</span>
            <span className="text-muted-foreground">{uploadPct}%</span>
          </div>
          <Progress value={uploadPct} max={100} className="w-full" />
        </div>
      )}
    </div>
  );
}
