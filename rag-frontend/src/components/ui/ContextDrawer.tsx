import React, { useMemo, useState } from "react";
import { Button } from "../ui/button";
import { FileIcon } from "../../utils/fileIcons";
import type {
  ContextItem,
  ContextSummary,
} from "../../hooks/useConversationContext";

type Props = {
  open: boolean;
  onClose: () => void;
  summary: ContextSummary;
  messages: { id: string; role: "user" | "assistant"; content: string }[];
  onOpenFile: (filename: string) => void;
};

export default function ContextDrawer({
  open,
  onClose,
  summary,
  messages,
  onOpenFile,
}: Props) {
  const [tab, setTab] = useState<"latest" | "files" | "timeline" | "pinned">(
    "latest"
  );

  const latestAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  }, [messages]);

  if (!open) return null;

  const latestContexts = latestAssistantId
    ? summary.byMessage[latestAssistantId] || []
    : [];

  return (
    <>
      <div className="fixed inset-0 z-[90] bg-black/40" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-[min(44rem,92vw)] z-[91] bg-white dark:bg-slate-950 border-l border-gray-200 dark:border-gray-800 shadow-xl flex flex-col">
        <div className="p-3 border-b dark:border-gray-800 flex items-center justify-between">
          <div className="text-sm font-semibold">Conversation context</div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={tab === "latest" ? "default" : "outline"}
              onClick={() => setTab("latest")}
            >
              Latest
            </Button>
            <Button
              size="sm"
              variant={tab === "files" ? "default" : "outline"}
              onClick={() => setTab("files")}
            >
              Files
            </Button>
            <Button
              size="sm"
              variant={tab === "timeline" ? "default" : "outline"}
              onClick={() => setTab("timeline")}
            >
              All turns
            </Button>
            <Button
              size="sm"
              variant={tab === "pinned" ? "default" : "outline"}
              onClick={() => setTab("pinned")}
            >
              Pinned
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 text-sm">
          {tab === "latest" && (
            <div className="space-y-3">
              {!latestContexts.length && (
                <div className="text-gray-500">
                  No retrieved context for the last answer.
                </div>
              )}
              {latestContexts.map((c, i) => (
                <ContextCard key={c.id || i} item={c} onOpenFile={onOpenFile} />
              ))}
            </div>
          )}

          {tab === "files" && (
            <div className="space-y-2">
              {Object.entries(summary.byFile)
                .sort(
                  (a, b) =>
                    b[1].uses - a[1].uses ||
                    (b[1].lastUsedAt ?? 0) - (a[1].lastUsedAt ?? 0)
                )
                .map(([fname, info]) => (
                  <button
                    key={fname}
                    onClick={() => onOpenFile(fname)}
                    className="w-full text-left border rounded p-3 hover:bg-gray-50 dark:hover:bg-slate-900"
                  >
                    <div className="flex items-center gap-2">
                      <FileIcon filename={fname} />
                      <div className="font-medium truncate">{fname}</div>
                      <span className="ml-auto text-xs rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 px-2 py-0.5">
                        {info.uses} use{info.uses === 1 ? "" : "s"}
                      </span>
                    </div>
                    {info.sample && (
                      <div className="text-xs text-gray-600 dark:text-gray-400 mt-2 line-clamp-3">
                        {info.sample}
                      </div>
                    )}
                  </button>
                ))}
            </div>
          )}

          {tab === "timeline" && (
            <div className="space-y-4">
              {messages.map((m) => (
                <div key={m.id} className="border rounded p-3">
                  <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                    {m.role === "assistant" ? "Assistant" : "User"}
                  </div>
                  <div className="text-sm mb-3 whitespace-pre-wrap">
                    {m.content}
                  </div>
                  {m.role === "assistant" &&
                    (summary.byMessage[m.id]?.length ? (
                      <div className="space-y-2">
                        {summary.byMessage[m.id].map((c, i) => (
                          <ContextCard
                            key={c.id || i}
                            item={c}
                            onOpenFile={onOpenFile}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-500">
                        No contexts for this turn.
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}

          {tab === "pinned" && (
            <div className="text-gray-500">
              Add local pinning later (or wire to backend). For now pins can
              live in localStorage.
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function ContextCard({
  item,
  onOpenFile,
}: {
  item: ContextItem;
  onOpenFile: (fn: string) => void;
}) {
  const fname = item.filename || "snippet.txt";
  return (
    <div className="border rounded p-3">
      <div className="flex items-center gap-2 mb-2">
        <FileIcon filename={fname} />
        <button
          className="font-medium hover:underline truncate"
          onClick={() => onOpenFile(fname)}
        >
          {fname}
        </button>
        {typeof item.score === "number" && (
          <span className="ml-auto text-[11px] text-gray-500">
            score: {item.score.toFixed(3)}
          </span>
        )}
      </div>
      <pre className="whitespace-pre-wrap break-words text-xs max-h-44 overflow-auto">
        {item.content}
      </pre>
    </div>
  );
}
