import { useEffect, useState } from "react";
import axios from "axios";
import { useAuth } from "../context/AuthContext";

type RepoStatus =
  | "unknown"
  | "upload"
  | "indexing"
  | "indexed"
  | "done"
  | "error";

export function useRepoStatus(repoId?: string | null) {
  const { token } = useAuth();
  const [status, setStatus] = useState<RepoStatus>("unknown");
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!repoId || !token) {
      setStatus("unknown");
      setProcessed(0);
      setTotal(0);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const { data } = await axios.get(`/api/repos/${repoId}/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        const s = String(data?.status ?? "unknown").toLowerCase() as RepoStatus;
        setStatus(s);
        setProcessed(Number(data?.processed ?? 0));
        setTotal(Number(data?.total ?? 0));
      } catch {
        if (!cancelled) setStatus("unknown");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repoId, token]);

  const isIndexed = status === "indexed" || status === "done";

  return { status, processed, total, isIndexed };
}
