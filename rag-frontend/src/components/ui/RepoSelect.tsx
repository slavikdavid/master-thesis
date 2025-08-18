import React, { useEffect, useMemo, useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

type Conversation = {
  id: string;
  repo_id?: string;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
};

type RepoGroup = {
  repoId: string;
  conversations: Conversation[];
};

type Props = {
  selectedRepoId: string | null;
  onSelectRepo: (repoId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  reloadKey?: string | null;
};

export function RepoSelect({
  selectedRepoId,
  onSelectRepo,
  onSelectConversation,
  reloadKey = null,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [convos, setConvos] = useState<Conversation[]>([]);

  const fetchConversations = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations");
      if (!res.ok) {
        setError(`Failed to load (HTTP ${res.status})`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as Conversation[];
      setConvos(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConversations();
  }, [reloadKey]);

  const repos: RepoGroup[] = useMemo(() => {
    const byRepo: Record<string, Conversation[]> = {};
    for (const c of convos) {
      const rid = (c as any).repo_id ?? "";
      if (!rid) continue;
      if (!byRepo[rid]) byRepo[rid] = [];
      byRepo[rid].push(c);
    }
    return Object.entries(byRepo).map(([repoId, list]) => {
      const sorted = [...list].sort((a, b) => {
        const aa = a.updated_at || a.created_at || "";
        const bb = b.updated_at || b.created_at || "";
        return aa < bb ? 1 : aa > bb ? -1 : 0;
      });
      return { repoId, conversations: sorted };
    });
  }, [convos]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.repoId.toLowerCase().includes(q));
  }, [repos, search]);

  return (
    <div className="space-y-3 border rounded-lg p-4 bg-white dark:bg-gray-900">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search repos by ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button
          variant="secondary"
          onClick={fetchConversations}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
      )}

      <div className="max-h-72 overflow-auto space-y-3">
        {filtered.length === 0 && !loading && !error && (
          <div className="text-sm text-gray-500">No repos yet.</div>
        )}
        {filtered.map((group) => (
          <div
            key={group.repoId}
            className={`rounded border p-3 ${
              selectedRepoId === group.repoId ? "ring-2 ring-blue-500" : ""
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="font-mono text-sm">
                Repo: <span className="font-semibold">{group.repoId}</span>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  onSelectRepo(group.repoId);
                  const first = group.conversations[0];
                  if (first?.id) onSelectConversation(first.id);
                }}
              >
                Use
              </Button>
            </div>

            {group.conversations.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-gray-500 mb-1">
                  Conversations ({group.conversations.length})
                </div>
                <div className="flex flex-col gap-1">
                  {group.conversations.slice(0, 6).map((c) => (
                    <button
                      key={c.id}
                      className="text-left text-sm hover:underline truncate"
                      title={c.title || c.id}
                      onClick={() => {
                        onSelectRepo(group.repoId);
                        onSelectConversation(c.id);
                      }}
                    >
                      {c.title || c.id}{" "}
                      <span className="text-xs text-gray-400">
                        {c.updated_at?.slice(0, 19).replace("T", " ") ||
                          c.created_at?.slice(0, 19).replace("T", " ")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
