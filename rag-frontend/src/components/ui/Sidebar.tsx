// src/components/Sidebar.tsx
import React from "react";
import {
  Plus,
  Search,
  ChevronRight,
  ChevronDown,
  MessageSquare,
} from "lucide-react";

export type Conversation = {
  id: string;
  title?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  repo_id: string;
  latest_question?: string | null;
};

type SidebarProps = {
  convosByRepo: Record<string, Conversation[]>;
  expanded: Record<string, boolean>;
  search: string;

  activeConversationId?: string | null;

  onSearchChange: (v: string) => void;
  onToggleRepo: (repoId: string) => void;
  onSelectConvo: (repoId: string, convoId: string) => void;
  onNewChat: (repoId: string) => void;
  onNewRepo: () => void;
  onSelectRepo?: (repoId: string) => void;
};

export default function Sidebar({
  convosByRepo,
  expanded,
  search,
  activeConversationId,
  onSearchChange,
  onToggleRepo,
  onSelectConvo,
  onNewChat,
  onNewRepo,
  onSelectRepo,
}: SidebarProps) {
  const repoIds = Object.keys(convosByRepo);

  const convoLabel = (c: Conversation) =>
    c.title || c.latest_question || `Conversation ${c.id.slice(0, 8)}`;

  return (
    <aside className="border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-[rgb(10,10,12)] flex flex-col min-h-0">
      <div className="p-3 border-b border-gray-200 dark:border-gray-800 space-y-3">
        <button
          className="w-full inline-flex items-center gap-2 rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
          onClick={onNewRepo}
        >
          <Plus className="h-4 w-4" />
          New repo
        </button>

        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
          <input
            className="w-full pl-8 pr-2 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
            placeholder="Search chats"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2 space-y-1">
        {repoIds.length === 0 && (
          <div className="text-xs text-gray-500 p-2">
            No conversations yet. Click “New repo” to upload a codebase or
            create a chat under already uploaded repo.
          </div>
        )}

        {repoIds.map((rid) => {
          const isOpen = !!expanded[rid];
          const convos = convosByRepo[rid] ?? [];
          const repoLabel = rid;

          return (
            <div key={rid} className="rounded-md">
              <div className="px-2 py-2 grid grid-cols-[1fr_auto_auto] items-center gap-1">
                <button
                  className="min-w-0 text-left text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-2 py-1 truncate"
                  onClick={() => {
                    onToggleRepo(rid);
                    onSelectRepo?.(rid);
                  }}
                  title={repoLabel}
                >
                  <span className="truncate">{repoLabel}</span>
                </button>

                <button
                  className="shrink-0 ml-1 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewChat(rid);
                  }}
                  title="New chat in this repo"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">New chat</span>
                </button>

                <button
                  className="shrink-0 ml-1 rounded p-1 hover:bg-gray-50 dark:hover:bg-gray-800"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleRepo(rid);
                  }}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                  title={isOpen ? "Collapse" : "Expand"}
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
              </div>

              {isOpen && (
                <div className="pl-2 pb-2 space-y-1">
                  {convos.length === 0 && (
                    <div className="text-xs text-gray-500 pl-2">
                      No conversations.
                    </div>
                  )}
                  {convos.map((c) => {
                    const active = c.id === activeConversationId;
                    return (
                      <button
                        key={c.id}
                        className={`w-full text-left flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-gray-50 dark:hover:bg-gray-800 ${
                          active ? "bg-gray-100 dark:bg-gray-800" : ""
                        }`}
                        onClick={() => onSelectConvo(rid, c.id)}
                        title={convoLabel(c) || undefined}
                      >
                        <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{convoLabel(c)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
