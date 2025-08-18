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
} from "lucide-react";

type Props = {
  repoId: string;
  onSelectFile: (path: string, content: string) => void;
};

export function FileTree({ repoId, onSelectFile }: Props) {
  const { token } = useAuth();
  const [allPaths, setAllPaths] = useState<string[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [query, setQuery] = useState("");

  // highlight freshly added files briefly
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

  // initial fetch
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
        if (!cancelled) setAllPaths(res.data ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch files:", err);
        if (!cancelled) setAllPaths([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, token]);

  // live ws
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

    ws.onopen = () => {};

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);

        // add files as they’re indexed
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

    ws.onerror = () => {};
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
    const filtered = q
      ? allPaths.filter((p) => p.toLowerCase().includes(q))
      : allPaths;
    return buildTree(filtered);
  }, [allPaths, query]);

  const fileCount = allPaths.length;

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
          { headers: { Authorization: `Bearer ${token}` } }
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
      {/* header with search + count */}
      <div className="flex items-center justify-between gap-3 p-3 border-b dark:border-slate-800">
        <div className="text-sm font-medium">
          Indexed files{" "}
          <span className="text-xs text-muted-foreground">({fileCount})</span>
          <span className="ml-2 inline-flex items-center rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 px-1.5 py-0.5 text-[11px]">
            live
          </span>
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
            const isNew = newPaths.has(path) && node.isLeaf;
            return (
              <span
                className={`inline-flex items-center gap-1 ${
                  isNew
                    ? "bg-amber-100 dark:bg-amber-900/30 rounded px-1 animate-pulse"
                    : ""
                }`}
              >
                {/* small “state” shield – green when seen live in this session */}
                {isNew ? (
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
                ) : (
                  <ShieldAlert className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600" />
                )}
                {label}
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

function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const acc: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    acc.push(parts.slice(0, i + 1).join("/"));
  }
  return acc;
}
