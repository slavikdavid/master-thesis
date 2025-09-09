// src/components/ui/FileTree.tsx
import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import axios from "axios";
import Tree, { DataNode, EventDataNode } from "rc-tree";
import "rc-tree/assets/index.css";
import { useAuth } from "../../context/AuthContext";
import { buildTree } from "../../utils/buildTree";
import { getFileIconForFilename } from "../../utils/fileIcons";
import {
  Folder,
  FolderOpen,
  Search,
  ShieldCheck,
  ShieldAlert,
  Filter,
} from "lucide-react";

type Props = {
  repoId: string;
  onSelectFile: (path: string, content: string) => void;

  /** filename -> retrieval count for THIS conversation (optional) */
  usedCounts?: Record<string, number>;
  /** filename -> short sample snippet (optional) */
  usedSamples?: Record<string, string>;
  /** default view filter */
  defaultFilter?: "all" | "used";
};

function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const acc: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    acc.push(parts.slice(0, i + 1).join("/"));
  }
  return acc;
}

export function FileTree({
  repoId,
  onSelectFile,
  usedCounts = {},
  usedSamples = {},
  defaultFilter = "all",
}: Props) {
  const { token } = useAuth();

  const [allPaths, setAllPaths] = useState<string[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "used">(defaultFilter);

  // brief highlight for newly indexed files
  const [newPaths, setNewPaths] = useState<Set<string>>(new Set());
  const newPathsRef = useRef(new Set<string>());
  const addNewPath = (p: string) => {
    newPathsRef.current.add(p);
    setNewPaths(new Set(newPathsRef.current));
    setTimeout(() => {
      newPathsRef.current.delete(p);
      setNewPaths(new Set(newPathsRef.current));
    }, 3000);
  };

  // persist expansion per repo
  useEffect(() => {
    try {
      const k = `ft_expanded:${repoId}`;
      const raw = localStorage.getItem(k);
      if (raw) setExpandedKeys(JSON.parse(raw));
    } catch {}
  }, [repoId]);

  useEffect(() => {
    try {
      const k = `ft_expanded:${repoId}`;
      localStorage.setItem(k, JSON.stringify(expandedKeys));
    } catch {}
  }, [expandedKeys, repoId]);

  // initial fetch (authoritative list)
  useEffect(() => {
    let cancelled = false;
    if (!repoId || !token) {
      setAllPaths([]);
      return;
    }
    axios
      .get<string[]>(`/api/repos/${repoId}/files`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => {
        if (!cancelled) setAllPaths((res.data ?? []).sort());
      })
      .catch((err) => {
        console.error("Failed to fetch files:", err);
        if (!cancelled) setAllPaths([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, token]);

  // live WS updates
  useEffect(() => {
    if (!repoId || !token) return;

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${proto}://${window.location.host}` +
      `/api/ws/progress?token=${encodeURIComponent(
        token
      )}&repo_id=${encodeURIComponent(repoId)}`;

    let closed = false;
    const ws = new WebSocket(url);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.event === "file_indexed" && typeof msg.path === "string") {
          setAllPaths((prev) => {
            if (prev.includes(msg.path)) return prev;
            const ancestors = ancestorsOf(msg.path);
            setExpandedKeys((keys) =>
              Array.from(new Set([...keys, ...ancestors]))
            );
            addNewPath(msg.path);
            return [...prev, msg.path].sort();
          });
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onclose = () => {
      closed = true;
    };
    return () => {
      if (!closed) {
        try {
          ws.close();
        } catch {}
      }
    };
  }, [repoId, token]);

  // filter + build tree
  const treeData: DataNode[] = useMemo(() => {
    const q = query.trim().toLowerCase();

    // filter by view
    const usedSet: Set<string> | null =
      view === "used" ? new Set(Object.keys(usedCounts || {})) : null;

    let paths = allPaths;
    if (usedSet) {
      paths = paths.filter((p) => usedSet.has(p));
    }

    const filtered = q
      ? paths.filter((p) => p.toLowerCase().includes(q))
      : paths;

    return buildTree(filtered);
  }, [allPaths, query, view, usedCounts]);

  const fileCount = allPaths.length;
  const usedCount = Object.keys(usedCounts).length;

  const onSelect = useCallback(
    (selectedKeys: React.Key[], info: { node: EventDataNode }) => {
      const node = info.node as EventDataNode & {
        isLeaf: boolean;
        path: string;
        title?: string;
      };
      if (!node.isLeaf) return;

      axios
        .get<{ content: string }>(
          `/api/repos/${repoId}/file?path=${encodeURIComponent(node.path)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : undefined }
        )
        .then((res) => onSelectFile(node.path, res.data.content))
        .catch(() => alert("Failed to load file"));
    },
    [repoId, token, onSelectFile]
  );

  const onExpand = useCallback(
    (keys: React.Key[]) => setExpandedKeys(keys),
    []
  );

  return (
    <div className="rounded border bg-white dark:bg-slate-900">
      {/* header with search + count + view filter */}
      <div className="flex items-center justify-between gap-3 p-3 border-b dark:border-slate-800">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>Indexed files</span>
          <span className="text-xs text-muted-foreground">({fileCount})</span>

          <span
            className="ml-2 inline-flex items-center rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 px-1.5 py-0.5 text-[11px]"
            title="Live updates"
          >
            live
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center text-xs">
            <Filter className="h-4 w-4 mr-1 text-muted-foreground" />
            <button
              className={`rounded px-2 py-1 border ${
                view === "all" ? "bg-gray-100 dark:bg-slate-800" : ""
              }`}
              onClick={() => setView("all")}
            >
              All
            </button>
            <button
              className={`ml-1 rounded px-2 py-1 border ${
                view === "used" ? "bg-gray-100 dark:bg-slate-800" : ""
              }`}
              onClick={() => setView("used")}
              title="Files retrieved in this conversation"
            >
              Used{usedCount ? ` (${usedCount})` : ""}
            </button>
          </div>

          <div className="relative w-64 max-w-[60%]">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-8 pr-2 py-1.5 rounded border bg-background text-sm"
              placeholder="Filter by name…"
            />
          </div>
        </div>
      </div>

      {/* tree */}
      <div style={{ maxHeight: 320, overflow: "auto" }} className="p-2">
        <Tree
          treeData={treeData}
          selectable
          showIcon
          expandedKeys={expandedKeys}
          onExpand={onExpand}
          defaultExpandAll={false}
          onSelect={onSelect}
          titleRender={(node: any) => {
            const label =
              typeof node.title === "string"
                ? node.title
                : String(node.key ?? "");
            const path = node.path || label;
            const isLeaf = !!node.isLeaf;
            const isNew = newPaths.has(path) && isLeaf;
            const count = usedCounts[path] || 0;
            const sample = usedSamples[path];

            return (
              <span
                className={`inline-flex items-center gap-1 ${
                  isNew
                    ? "bg-amber-100 dark:bg-amber-900/30 rounded px-1 animate-pulse"
                    : ""
                }`}
                title={
                  sample
                    ? `${path}\n\nTop snippet:\n${sample.slice(0, 400)}`
                    : path
                }
              >
                {/* left icon(s) */}
                {count > 0 && isLeaf && (
                  <span className="inline-flex items-center text-[10px] rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 px-1.5 py-[1px] mr-1">
                    {count}
                  </span>
                )}

                {/* “seen live” adornment (optional) */}
                {isNew ? (
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
                ) : (
                  <ShieldAlert className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600" />
                )}

                {/* label */}
                <span className="truncate max-w-[22rem]">{label}</span>
              </span>
            );
          }}
          icon={(nodeProps) => {
            const n = nodeProps as any;
            if (!n.isLeaf) {
              return (
                <span className="mr-1 inline-flex items-center">
                  <Folder className="h-4 w-4 rc-tree-switcher_close:inline-block rc-tree-switcher_open:hidden" />
                  <FolderOpen className="h-4 w-4 hidden rc-tree-switcher_open:inline-block" />
                </span>
              );
            }
            const label =
              typeof n.title === "string" ? n.title : String(n.key ?? "");
            return (
              <span className="mr-1 inline-flex items-center">
                {getFileIconForFilename(label, { className: "h-4 w-4" })}
              </span>
            );
          }}
        />
      </div>
    </div>
  );
}

export default FileTree;
