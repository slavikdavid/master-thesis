import { Progress } from "../ui/progress";

interface Props {
  phase: string;
  progress: number;
}

export function IndexStatus({ phase, progress }: Props) {
  let label: string;
  switch (phase) {
    case "upload":
      label = `Uploading… ${progress}%`;
      break;
    case "indexing":
      label = `Indexing… ${progress}%`;
      break;
    case "done":
    case "indexed":
      label = `Indexed ✓`;
      break;
    case "error":
      label = `Error during indexing`;
      break;
    default:
      label = `Idle`;
  }

  const showBar = phase === "upload" || phase === "indexing";

  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      {showBar && <Progress value={progress} max={100} className="w-full" />}
    </div>
  );
}
