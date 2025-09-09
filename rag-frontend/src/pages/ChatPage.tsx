import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Toaster, toast } from "sonner";
import { UploadForm } from "../components/ui/UploadForm";
import { AnswerDisplay } from "../components/ui/AnswerDisplay";
import { useAuth } from "../context/AuthContext";
import { useNavigate, useParams } from "react-router-dom";
import { QueryHistory } from "../components/ui/QueryHistory";
import Sidebar, { Conversation } from "../components/ui/Sidebar";
import { QueryForm } from "../components/ui/QueryForm";

type ContextItem = {
  id?: string;
  file?: string;
  snippet?: string;
  content?: string;
  metadata?: any;
  score?: number;
};

interface ChatMessage {
  id: string;
  content: string;
  role: "user" | "assistant";
  contexts?: ContextItem[];
}

/** Backend PhaseState (mirror of FastAPI model) */
type PhaseState = {
  status?: "queued" | "running" | "complete" | "error" | string;
  processed?: number;
  total?: number;
  message?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

/** Backend /repos/:id/status response */
type RepoStatus = {
  repoId: string;
  status:
    | "new"
    | "upload"
    | "indexing"
    | "indexed"
    | "done"
    | "error"
    | "missing"
    | string;
  phases: Record<string, PhaseState>;
  stats?: { documents?: number; [k: string]: any };
};

const LS_REPO = "lastRepoId";
const LS_CONV = "lastConversationId";

/** normalize API conversation */
function normalizeConvo(raw: any): Conversation | null {
  const id =
    raw?.id ?? raw?.conversation_id ?? raw?.conversationId ?? raw?.pk ?? null;
  const repo_id = raw?.repo_id ?? raw?.repoId ?? raw?.repository_id ?? null;
  if (!id || !repo_id) return null;

  return {
    id: String(id),
    repo_id: String(repo_id),
    title:
      raw?.title ??
      raw?.name ??
      raw?.latest_question ??
      raw?.first_message?.content ??
      null,
    created_at: raw?.created_at ?? raw?.createdAt ?? null,
    updated_at: raw?.updated_at ?? raw?.updatedAt ?? null,
    latest_question: raw?.latest_question ?? null,
  };
}

export default function ChatPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const routeConversationId = params.id || null;

  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isAsking, setIsAsking] = useState(false);

  const [newRepoMode, setNewRepoMode] = useState(false);

  // sidebar state
  const [allConvos, setAllConvos] = useState<Conversation[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");

  // repo status (authoritative, from backend)
  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null);
  // fallback "ready" if we’ve already successfully answered at least once
  const [manuallyReady, setManuallyReady] = useState(false);

  const lastRepoRef = useRef<string | null>(null);
  const restoreDoneRef = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);

  // --- AUTOSCROLL SENTINEL ---
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior, block: "end" });
    } else if (scrollAreaRef.current) {
      const el = scrollAreaRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // keep conversationId in sync with route
  useEffect(() => {
    setConversationId(routeConversationId);
    if (routeConversationId) setNewRepoMode(false);
  }, [routeConversationId]);

  // when landing on /conversation/:id, fetch it to learn repo_id
  useEffect(() => {
    if (!routeConversationId) return;
    (async () => {
      try {
        const res = await fetch(`/api/conversations/${routeConversationId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) return;
        const raw = await res.json();
        const conv = normalizeConvo(raw);
        if (conv) {
          setRepoId(conv.repo_id);
          localStorage.setItem(LS_REPO, conv.repo_id);
          localStorage.setItem(LS_CONV, conv.id);
          setExpanded((p) => ({ ...p, [conv.repo_id]: true }));
        }
      } catch {}
    })();
  }, [routeConversationId, token]);

  // restore last session only on root route
  useEffect(() => {
    if (restoreDoneRef.current) return;
    restoreDoneRef.current = true;
    if (routeConversationId) return;

    const savedRepo = localStorage.getItem(LS_REPO);
    const savedConv = localStorage.getItem(LS_CONV);
    if (savedRepo) setRepoId(savedRepo);
    if (savedConv) setConversationId(savedConv);
  }, [routeConversationId]);

  // persist selections
  useEffect(() => {
    if (repoId) localStorage.setItem(LS_REPO, repoId);
  }, [repoId]);
  useEffect(() => {
    if (conversationId) localStorage.setItem(LS_CONV, conversationId);
  }, [conversationId]);

  // -------- fetch ALL conversations; group by repo_id --------
  const fetchAllConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const ok = res.ok
        ? res
        : await fetch("/api/conversations/", {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
      if (!ok.ok) {
        setAllConvos([]);
        return;
      }
      const items = await ok.json().catch(() => []);
      const list = (Array.isArray(items) ? items : [])
        .map(normalizeConvo)
        .filter(Boolean) as Conversation[];
      setAllConvos(list);

      if (!routeConversationId && !conversationId && list[0]) {
        setRepoId(list[0].repo_id);
        setConversationId(list[0].id);
      }
    } catch {
      setAllConvos([]);
    }
  }, [conversationId, routeConversationId, token]);

  useEffect(() => {
    void fetchAllConversations();
  }, [fetchAllConversations, reloadKey]);

  // build repo → conversations map
  const convosByRepo = useMemo(() => {
    const map: Record<string, Conversation[]> = {};
    for (const c of allConvos) {
      (map[c.repo_id] = map[c.repo_id] || []).push(c);
    }
    for (const rid of Object.keys(map)) {
      map[rid].sort((a, b) => {
        const at = Date.parse(b.updated_at || b.created_at || "") || 0;
        const bt = Date.parse(a.updated_at || a.created_at || "") || 0;
        return at - bt;
      });
    }
    return map;
  }, [allConvos]);

  // filter conversations by search term
  const filteredConvosByRepo = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return convosByRepo;
    const out: Record<string, Conversation[]> = {};
    for (const [rid, list] of Object.entries(convosByRepo)) {
      const repoLabel = rid;
      const convs = list.filter((c) => {
        const t =
          c.title || c.latest_question || `Conversation ${c.id.slice(0, 8)}`;
        return (
          repoLabel.toLowerCase().includes(term) ||
          t.toLowerCase().includes(term)
        );
      });
      if (convs.length) out[rid] = convs;
    }
    return out;
  }, [search, convosByRepo]);

  // -------- load messages when conversation changes --------
  useEffect(() => {
    if (!conversationId) {
      setChatHistory([]);
      return;
    }
    const ctrl = new AbortController();
    (async () => {
      try {
        const url = `/api/messages?conversation_id=${encodeURIComponent(
          conversationId
        )}`;
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) {
          console.error("Load messages failed:", res.status, await res.text());
          return;
        }
        const msgs: ChatMessage[] = await res.json();
        setChatHistory(Array.isArray(msgs) ? msgs : []);
        requestAnimationFrame(() => scrollToBottom("auto"));
      } catch (e: any) {
        if (e.name !== "AbortError") console.error("Load messages error:", e);
      }
    })();
    return () => ctrl.abort();
  }, [conversationId, token, scrollToBottom]);

  // -------- SINGLE CHECK: fetch repo status whenever repoId changes ----
  useEffect(() => {
    setManuallyReady(false); // reset fallback when switching repos
    setRepoStatus(null);
    if (!repoId) return;

    (async () => {
      try {
        const res = await fetch(`/api/repos/${repoId}/status`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) return;
        const s = (await res.json().catch(() => null)) as RepoStatus | null;
        setRepoStatus(s || null);

        // If backend already proves readiness, latch it to avoid UI flip-flop
        const label = (s?.status || "").toLowerCase();
        const docs = Number(s?.stats?.documents || 0);
        if (label === "indexed" || label === "done" || docs > 0) {
          setManuallyReady(true);
        }
      } catch {
        // keep as null; UI will still allow asking once we get an answer (fallback toggles ready)
      }
    })();
  }, [repoId, token]);

  // set repo & create a new conversation
  const handleRepoId = useCallback(
    async (newRepoId: string) => {
      if (lastRepoRef.current !== newRepoId) {
        setChatHistory([]);
        lastRepoRef.current = newRepoId;
      }
      setRepoId(newRepoId);

      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ repo_id: newRepoId }),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({} as any));
          const id =
            data?.id ?? data?.conversation_id ?? data?.conversation?.id ?? null;
          if (id) {
            setNewRepoMode(false);
            navigate(`/conversation/${id}`, { replace: false });
          }
        }
        setReloadKey((k) => k + 1);
        setExpanded((prev) => ({ ...prev, [newRepoId]: true }));
      } catch (e) {
        console.warn("Create conversation error:", e);
      }
    },
    [token, navigate]
  );

  const handleIndexed = useCallback(
    (id: string) => {
      toast.success("Repository ready");
      if (!repoId) setRepoId(id);
      // mark ready immediately (terminal); also set a nonzero documents count
      setRepoStatus({
        repoId: id,
        status: "indexed",
        phases: {},
        stats: { documents: 1 },
      });
      setManuallyReady(true);
      setReloadKey((k) => k + 1);
    },
    [repoId]
  );

  // ensure a conversation exists
  const ensureConversation = useCallback(
    async (rid: string) => {
      if (conversationId) return conversationId;
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ repo_id: rid }),
      });
      if (!res.ok)
        throw new Error(`create conversation failed (${res.status})`);
      const data = await res.json().catch(() => ({} as any));
      const id = data?.id ?? data?.conversation_id ?? data?.conversation?.id;
      setNewRepoMode(false);
      navigate(`/conversation/${id}`, { replace: false });
      setReloadKey((k) => k + 1);
      return id;
    },
    [conversationId, token, navigate]
  );

  /** Local signal that we already have valid assistant output (helps on F5). */
  const hasAssistantHistory = useMemo(
    () => chatHistory.some((m) => m.role === "assistant"),
    [chatHistory]
  );

  // compute readiness: backend says indexed/done OR we already answered OR we have docs
  const isRepoReady = useMemo(() => {
    const label = (repoStatus?.status || "").toLowerCase();
    const docs = Number(repoStatus?.stats?.documents || 0);
    return (
      manuallyReady ||
      hasAssistantHistory ||
      label === "indexed" ||
      label === "done" ||
      docs > 0
    );
  }, [repoStatus, manuallyReady, hasAssistantHistory]);

  // ask flow
  const handleAsk = useCallback(
    async (question: string) => {
      if (!repoId || isAsking) return;

      // Single backend check if not ready: try once more to confirm
      if (!isRepoReady) {
        try {
          const res = await fetch(`/api/repos/${repoId}/status`, {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
          if (res.ok) {
            const s = (await res.json().catch(() => null)) as RepoStatus | null;
            setRepoStatus(s || null);
            const label = (s?.status || "").toLowerCase();
            const docs = Number(s?.stats?.documents || 0);
            if (!(label === "indexed" || label === "done" || docs > 0)) {
              toast.error("Repository is not indexed yet.");
              return;
            }
          } else {
            toast.error("Repository is not ready yet.");
            return;
          }
        } catch {
          toast.error("Repository is not ready yet.");
          return;
        }
      }

      setIsAsking(true);

      try {
        const convId = await ensureConversation(repoId);

        const tempId = `temp-${Date.now()}`;
        const userMsg: ChatMessage = {
          id: tempId,
          role: "user",
          content: question,
        };
        setChatHistory((h) => [...h, userMsg]);
        requestAnimationFrame(() => scrollToBottom("smooth"));

        // save question
        const qRes = await fetch("/api/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            conversation_id: convId,
            role: "user",
            content: question,
          }),
        });
        const savedQ: ChatMessage = qRes.ok ? await qRes.json() : userMsg;

        // get answer
        const ansRes = await fetch("/api/repos/v2/answer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            repo_id: repoId,
            query: question,
            conversation_id: convId,
          }),
        });
        if (!ansRes.ok) {
          const body = await ansRes.text();
          console.error("Answer failed:", ansRes.status, body);
          setChatHistory((h) => [
            ...h.filter((m) => m.id !== tempId),
            savedQ,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: "(no answer)",
            },
          ]);
          requestAnimationFrame(() => scrollToBottom("smooth"));
          return;
        }
        const { answer, contexts } = (await ansRes.json()) as {
          answer: string;
          contexts?: ContextItem[];
        };

        // save answer
        const aRes = await fetch("/api/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            conversation_id: convId,
            role: "assistant",
            content: answer,
          }),
        });
        const savedAFromServer: ChatMessage = aRes.ok
          ? await aRes.json()
          : { id: `a-${Date.now()}`, role: "assistant", content: answer };

        const finalAssistant: ChatMessage = {
          ...savedAFromServer,
          role: "assistant",
          content: answer,
          contexts: contexts ?? [],
        };

        // mark ready after first successful end-to-end answer
        setManuallyReady(true);
        setRepoStatus(
          (prev) =>
            prev ?? {
              repoId: repoId,
              status: "indexed",
              phases: {},
              stats: { documents: 1 },
            }
        );

        setChatHistory((h) => [
          ...h.filter((m) => m.id !== tempId),
          savedQ,
          finalAssistant,
        ]);
        requestAnimationFrame(() => scrollToBottom("smooth"));
        setReloadKey((k) => k + 1);
      } catch (e) {
        console.error("Ask error:", e);
      } finally {
        setIsAsking(false);
        setHistoryRefreshKey((k) => k + 1);
      }
    },
    [repoId, ensureConversation, isAsking, token, scrollToBottom, isRepoReady]
  );

  // sidebar helpers
  const onToggleRepo = (rid: string) =>
    setExpanded((prev) => ({ ...prev, [rid]: !prev[rid] }));

  const onSelectConvo = (rid: string, cid: string) => {
    setNewRepoMode(false);
    navigate(`/conversation/${cid}`);
  };

  const onSelectRepo = (rid: string) => {
    setNewRepoMode(false);
    setRepoId(rid);
  };

  const onNewRepo = () => {
    setNewRepoMode(true);
    setRepoId(null);
    setConversationId(null);
    setChatHistory([]);
    setRepoStatus(null);
    setManuallyReady(false);
  };

  const onNewChatForRepo = async (rid: string) => {
    setNewRepoMode(false);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ repo_id: rid }),
      });
      if (!res.ok) {
        toast.error("Failed to create conversation");
        return;
      }
      const data = await res.json().catch(() => ({} as any));
      const id = data?.id ?? data?.conversation_id ?? data?.conversation?.id;
      if (id) {
        setExpanded((p) => ({ ...p, [rid]: true }));
        setReloadKey((k) => k + 1);
        navigate(`/conversation/${id}`, { replace: false });
      }
    } catch {
      toast.error("Failed to create conversation");
    }
  };

  // Visibility of the UploadForm: show only when we truly need to upload/index.
  const showUploadForm = useMemo(() => {
    if (newRepoMode) return true;
    if (!repoId) return true;
    if (conversationId || (chatHistory && chatHistory.length > 0)) return false;
    const label = (repoStatus?.status || "").toLowerCase();
    const docs = Number(repoStatus?.stats?.documents || 0);
    const terminal =
      label === "indexed" || label === "done" || label === "error" || docs > 0;
    return !terminal;
  }, [newRepoMode, repoId, conversationId, chatHistory, repoStatus]);

  // Only show the "Indexing…" notice when the backend **explicitly** says so.
  const showIndexingNotice = useMemo(() => {
    if (!repoStatus) return false; // unknown → don't scare the user
    const label = (repoStatus.status || "").toLowerCase();
    const docs = Number(repoStatus.stats?.documents || 0);
    if (docs > 0) return false;
    return (label === "indexing" || label === "upload") && !isRepoReady;
  }, [repoStatus, isRepoReady]);

  const activeConversationId = conversationId;

  return (
    <>
      <Toaster position="top-right" richColors />

      <div className="h-screen w-full grid grid-cols-[300px_1fr]">
        {/* sidebar */}
        <Sidebar
          convosByRepo={filteredConvosByRepo}
          expanded={expanded}
          search={search}
          activeConversationId={activeConversationId}
          onSearchChange={setSearch}
          onToggleRepo={onToggleRepo}
          onSelectConvo={onSelectConvo}
          onNewChat={onNewChatForRepo}
          onNewRepo={onNewRepo}
          onSelectRepo={onSelectRepo}
        />

        {/* main panel */}
        <main className="h-screen min-h-0 flex flex-col">
          <div className="max-w-3xl w-full mx-auto flex-1 min-h-0 flex flex-col">
            {/* header / setup zone */}
            <div className="px-4 pt-4">
              {showUploadForm && (
                <UploadForm
                  onRepoId={handleRepoId}
                  onIndexingComplete={handleIndexed}
                />
              )}
            </div>

            {/* messages scroll area */}
            <div
              ref={scrollAreaRef}
              className="flex-1 min-h-0 overflow-y-auto px-4 pb-24 mt-4"
            >
              {repoId && !newRepoMode && (
                <div className="space-y-3">
                  {chatHistory.map((msg) => (
                    <div
                      key={msg.id}
                      className={`border rounded p-4 ${
                        msg.role === "user"
                          ? "bg-gray-50 dark:bg-gray-900/40"
                          : ""
                      }`}
                    >
                      {msg.role === "user" ? (
                        <p className="font-medium whitespace-pre-wrap">
                          {msg.content}
                        </p>
                      ) : (
                        <AnswerDisplay
                          answer={msg.content}
                          contexts={msg.contexts}
                        />
                      )}
                    </div>
                  ))}

                  {/* Optional: server-backed history */}
                  {conversationId && (
                    <div className="hidden">
                      <QueryHistory
                        key={`${conversationId}-${historyRefreshKey}`}
                        conversationId={conversationId}
                        newestFirst={false}
                        refreshKey={historyRefreshKey}
                      />
                    </div>
                  )}
                </div>
              )}

              <div ref={bottomRef} className="h-0" />
            </div>

            {repoId && !newRepoMode && (
              <div className="sticky bottom-0 w-full border-t bg-white/80 dark:bg-zinc-900/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 px-4 py-3">
                <div className="max-w-3xl mx-auto">
                  <QueryForm
                    key={conversationId || repoId}
                    repoId={repoId}
                    onAsk={async (q) => await handleAsk(q)}
                    onAnswer={() => {}}
                    onSelectFile={() => {}}
                    mode="composer"
                    disabled={!isRepoReady}
                  />
                  {showIndexingNotice && (
                    <p className="text-xs text-gray-500 mt-1">
                      Indexing… You can browse or upload another repo while this
                      finishes.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}
