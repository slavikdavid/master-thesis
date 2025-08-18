import React, { useMemo } from "react";
import { Progress } from "../ui/progress";

type PhaseStatus = "queued" | "running" | "complete" | "error";
type PhaseState = { status?: PhaseStatus; pct?: number };

type Props = {
  upload?: PhaseState;
  embedding?: PhaseState;
  indexing?: PhaseState;
  overallPct?: number;
  className?: string;
};

function clampPct(n?: number) {
  if (typeof n !== "number" || Number.isNaN(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function Row({ label, state }: { label: string; state?: PhaseState }) {
  const status = (state?.status ?? "queued").toLowerCase() as PhaseStatus;
  const pct = clampPct(state?.pct);
  const value = typeof pct === "number" ? pct : status === "complete" ? 100 : 0;

  // show a bar if percentage is received, or it’s actively running / queued / complete
  const showBar =
    typeof pct === "number" ||
    status === "running" ||
    status === "queued" ||
    status === "complete";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span
          className={
            "text-muted-foreground " +
            (status === "error" ? "text-red-600 dark:text-red-400" : "")
          }
        >
          {typeof pct === "number" ? `${value}%` : status}
        </span>
      </div>
      {showBar && <Progress value={value} max={100} className="w-full" />}
    </div>
  );
}

export default function RepoProgress({
  upload,
  embedding,
  indexing,
  overallPct,
  className,
}: Props) {
  const anyActive = useMemo(() => {
    const s = [upload?.status, embedding?.status, indexing?.status];
    const p = [upload?.pct, embedding?.pct, indexing?.pct];
    const anyPct = p.some((n) => typeof n === "number");
    const anyRunning = s.some((x) => x === "running");
    const anyComplete = s.some((x) => x === "complete");
    const anyError = s.some((x) => x === "error");
    return anyPct || anyRunning || anyComplete || anyError;
  }, [upload, embedding, indexing]);

  if (!anyActive && typeof overallPct !== "number") return null;

  const overall = clampPct(overallPct);

  return (
    <div
      className={
        "rounded border bg-white dark:bg-slate-900 p-3 space-y-3 " +
        (className ?? "")
      }
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Overall</span>
          <span className="text-muted-foreground">
            {typeof overall === "number" ? `${overall}%` : "—"}
          </span>
        </div>
        <Progress value={overall ?? 0} max={100} className="w-full" />
      </div>

      <Row label="Upload" state={upload} />
      <Row label="Embedding" state={embedding} />
      <Row label="Indexing" state={indexing} />
    </div>
  );
}
