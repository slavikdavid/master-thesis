// src/components/ui/FileTree.tsx
import { useEffect, useMemo, useState, useCallback } from "react";
import axios from "axios";
import Tree, { DataNode, EventDataNode } from "rc-tree";
import "rc-tree/assets/index.css";
import { useAuth } from "../../context/AuthContext";
import { buildTree } from "../../utils/buildTree";
import { getFileIconForFilename } from "../../utils/fileIcons";
import { Folder, FolderOpen, Search } from "lucide-react";

type Props = {
  repoId: string;
  onSelectFile: (path: string, content: string) => void;
};

export function FileTree({ repoId, onSelectFile }: Props) {
  const { token } = useAuth();
  const [allPaths, setAllPaths] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  // fetch file list
  useEffect(() => {
    if (!repoId || !token) {
      setAllPaths([]);
      return;
    }

    axios
      .get<string[]>(`/api/repos/${repoId}/files`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => setAllPaths(res.data ?? []))
      .catch((err) => {
        console.error("Failed to fetch files:", err);
        setAllPaths([]);
      });
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

  return (
    <div className="rounded border bg-white dark:bg-slate-900">
      {/* header with search + count */}
      <div className="flex items-center justify-between gap-3 p-3 border-b dark:border-slate-800">
        <div className="text-sm font-medium">
          Indexed files{" "}
          <span className="text-xs text-muted-foreground">({fileCount})</span>
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
          defaultExpandAll={false}
          onSelect={onSelect}
          icon={(nodeProps) => {
            const n = nodeProps as any;
            if (!n.isLeaf) {
              // folder icon
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
