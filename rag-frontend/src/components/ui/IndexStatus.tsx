import { Progress } from "../ui/progress";

type Phase = "upload" | "indexing" | "done" | "indexed" | "error" | string;

interface Props {
  phase: Phase;
  /** optional direct percent [0..100] */
  progress?: number | null;
  /** optional counters from WS: { processed, total } */
  processed?: number;
  total?: number;
  /** optional extra message from WS */
  message?: string;
}

function clampPct(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function IndexStatus({
  phase,
  progress,
  processed,
  total,
  message,
}: Props) {
  // derive percentage
  let percent: number | null = null;
  if (typeof progress === "number") {
    percent = clampPct(progress);
  } else if (
    typeof processed === "number" &&
    typeof total === "number" &&
    total > 0
  ) {
    percent = clampPct((processed / total) * 100);
  }

  let label = "Idle";
  const counts =
    typeof processed === "number" && typeof total === "number" && total > 0
      ? ` (${processed}/${total})`
      : "";

  if (phase === "upload") {
    label =
      percent != null ? `Uploading… ${percent}%` : message || "Uploading…";
  } else if (phase === "indexing") {
    if (percent === 100) {
      label = "Indexed ✓";
    } else {
      label =
        percent != null
          ? `Indexing… ${percent}%${counts}`
          : message || "Indexing…";
    }
  } else if (phase === "indexed" || phase === "done") {
    label = "Indexed ✓";
    percent = 100;
  } else if (phase === "error") {
    label = message ? `Error: ${message}` : "Error during indexing";
  }

  const showBar = phase === "upload" || phase === "indexing";

  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>

      {showBar && (
        <>
          {percent != null ? (
            <Progress value={percent} max={100} className="w-full" />
          ) : (
            // indeterminate bar when total/percent is unknown
            <div className="w-full h-2 rounded bg-muted relative overflow-hidden">
              <div className="absolute inset-y-0 left-0 w-1/3 bg-primary animate-index-indeterminate" />
            </div>
          )}
        </>
      )}

      {/* visual animation for indeterminate state */}
      <style>
        {`
        @keyframes index-indeterminate {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(50%); }
          100% { transform: translateX(120%); }
        }
        .animate-index-indeterminate {
          animation: index-indeterminate 1.2s ease-in-out infinite;
          border-radius: 9999px;
        }
      `}
      </style>
    </div>
  );
}
