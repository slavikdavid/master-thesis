// src/pages/ChatPage.tsx
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
import Sidebar, { Conversation } from "../components/ui/Sidebar";
import { QueryForm } from "../components/ui/QueryForm";
import { FileTree } from "../components/ui/FileTree";

/* ---------- types ---------- */
type ContextItem = {
  id?: string;
  filename?: string;
  content?: string;
  score?: number;
  file?: string;
  snippet?: string;
  metadata?: any;
};
interface ChatMessage {
  id: string;
  content: string;
  role: "user" | "assistant";
  created_at?: string | null;
  contexts?: ContextItem[];
}
type PhaseState = {
  status?: "queued" | "running" | "complete" | "error" | string;
  processed?: number;
  total?: number;
  message?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};
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
type HistoryRow = {
  message_id: string | null;
  rag_query_id: string;
  created_at?: string | null;
  contexts: Array<{
    id: string;
    filename: string;
    content: string;
    rank?: number | null;
    score?: number | null;
  }>;
};

const LS_REPO = "lastRepoId";
const LS_CONV = "lastConversationId";
const LS_RIGHT_OPEN = "chat:rightOpen";
const LS_RIGHT_W = "chat:rightWidth";

/* ---------- tiny context cache ---------- */
const ctxKey = (cid: string) => `ctxcache:${cid}`;
function readCtxCache(cid: string): Record<string, ContextItem[]> {
  try {
    const raw = localStorage.getItem(ctxKey(cid));
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj ? obj : {};
  } catch {
    return {};
  }
}
function writeCtxCache(cid: string, map: Record<string, ContextItem[]>) {
  try {
    localStorage.setItem(ctxKey(cid), JSON.stringify(map));
  } catch {}
}
function mergeCtxCache(
  cid: string,
  add: Record<string, ContextItem[]>
): Record<string, ContextItem[]> {
  const base = readCtxCache(cid);
  const merged = { ...base, ...add };
  writeCtxCache(cid, merged);
  return merged;
}

/* ---------- helpers ---------- */
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

/* ---------- component ---------- */
export default function ChatPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const routeConversationId = params.id || null;

  const [repoId, setRepoId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isAsking, setIsAsking] = useState(false);

  const [allConvos, setAllConvos] = useState<Conversation[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");

  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null);
  const [manuallyReady, setManuallyReady] = useState(false);

  const lastRepoRef = useRef<string | null>(null);
  const restoreDoneRef = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);

  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior });
    else if (scrollAreaRef.current) {
      const el = scrollAreaRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  /* ---------- Right pane (FileTree + Preview) ---------- */
  const [rightOpen, setRightOpen] = useState<boolean>(() => {
    const raw = localStorage.getItem(LS_RIGHT_OPEN);
    return raw ? raw === "1" : true;
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const raw = Number(localStorage.getItem(LS_RIGHT_W));
    return Number.isFinite(raw) && raw >= 280 ? raw : 380;
  });
  useEffect(() => {
    localStorage.setItem(LS_RIGHT_OPEN, rightOpen ? "1" : "0");
  }, [rightOpen]);
  useEffect(() => {
    localStorage.setItem(LS_RIGHT_W, String(rightWidth));
  }, [rightWidth]);

  // drag to resize
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: rightWidth };
    window.addEventListener("mousemove", onDragging);
    window.addEventListener("mouseup", onDragEnd);
  };
  const onDragging = (e: MouseEvent) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startX - e.clientX;
    const next = Math.min(640, Math.max(280, dragRef.current.startW + delta));
    setRightWidth(next);
  };
  const onDragEnd = () => {
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragging);
    window.removeEventListener("mouseup", onDragEnd);
  };

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");

  const handleSelectFile = useCallback((path: string, content: string) => {
    setPreviewPath(path);
    setPreviewContent(content);
  }, []);

  /* route → conversation id */
  useEffect(() => {
    setConversationId(routeConversationId);
    if (routeConversationId) setNewRepoMode(false);
  }, [routeConversationId]);
  const [newRepoMode, setNewRepoMode] = useState(false);

  /* discover repo_id for a conversation */
  useEffect(() => {
    if (!routeConversationId) return;
    (async () => {
      try {
        const res = await fetch(`/api/conversations/${routeConversationId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) return;
        const conv = normalizeConvo(await res.json());
        if (conv) {
          setRepoId(conv.repo_id);
          localStorage.setItem(LS_REPO, conv.repo_id);
          localStorage.setItem(LS_CONV, conv.id);
          setExpanded((p) => ({ ...p, [conv.repo_id]: true }));
        }
      } catch {}
    })();
  }, [routeConversationId, token]);

  /* restore last session (root only) */
  useEffect(() => {
    if (restoreDoneRef.current) return;
    restoreDoneRef.current = true;
    if (routeConversationId) return;
    const savedRepo = localStorage.getItem(LS_REPO);
    const savedConv = localStorage.getItem(LS_CONV);
    if (savedRepo) setRepoId(savedRepo);
    if (savedConv) setConversationId(savedConv);
  }, [routeConversationId]);

  useEffect(() => {
    if (repoId) localStorage.setItem(LS_REPO, repoId);
  }, [repoId]);
  useEffect(() => {
    if (conversationId) localStorage.setItem(LS_CONV, conversationId);
  }, [conversationId]);

  /* list conversations */
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

  const convosByRepo = useMemo(() => {
    const map: Record<string, Conversation[]> = {};
    for (const c of allConvos) (map[c.repo_id] = map[c.repo_id] || []).push(c);
    for (const rid of Object.keys(map)) {
      map[rid].sort((a, b) => {
        const at = Date.parse(b.updated_at || b.created_at || "") || 0;
        const bt = Date.parse(a.updated_at || a.created_at || "") || 0;
        return at - bt;
      });
    }
    return map;
  }, [allConvos]);

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

  /* -------- messages + contexts/history + cache -------- */
  const reqSeqRef = useRef(0);
  const [ctxHistory, setCtxHistory] = useState<HistoryRow[]>([]);
  const [ctxByMessage, setCtxByMessage] = useState<
    Record<string, ContextItem[]>
  >({});

  useEffect(() => {
    if (!conversationId) {
      setChatHistory([]);
      setCtxHistory([]);
      setCtxByMessage({});
      return;
    }

    const seq = ++reqSeqRef.current;
    const ctrl = new AbortController();

    (async () => {
      try {
        // 1) messages
        const msgRes = await fetch(
          `/api/messages?conversation_id=${encodeURIComponent(conversationId)}`,
          {
            signal: ctrl.signal,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          }
        );
        if (!msgRes.ok) return;
        const rawMsgs: any[] = (await msgRes.json()) || [];
        let msgs: ChatMessage[] = rawMsgs
          .map((m) => ({
            id: String(m.id),
            role: m.role,
            content: m.content,
            created_at: m.created_at ?? m.createdAt ?? null,
          }))
          .sort((a, b) => {
            const ta = a.created_at ? Date.parse(a.created_at) : 0;
            const tb = b.created_at ? Date.parse(b.created_at) : 0;
            return ta - tb;
          });

        // 2) hydrate from local cache
        const cached = readCtxCache(conversationId);
        msgs = msgs.map((m) =>
          m.role === "assistant" && cached[m.id]?.length
            ? { ...m, contexts: cached[m.id] }
            : m
        );

        if (seq === reqSeqRef.current && !ctrl.signal.aborted) {
          setChatHistory(msgs);
          requestAnimationFrame(() => scrollToBottom("auto"));
        }

        // 3) authoritative contexts/history
        let history: HistoryRow[] = [];
        try {
          const ctxRes = await fetch(
            `/api/conversations/${encodeURIComponent(
              conversationId
            )}/contexts/history`,
            {
              signal: ctrl.signal,
              headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            }
          );
          if (ctxRes.ok)
            history = ((await ctxRes.json()) || []) as HistoryRow[];
        } catch {}

        // map by message id
        const byMessage: Record<string, ContextItem[]> = {};
        const leftovers: HistoryRow[] = [];
        for (const row of history) {
          const items =
            (row?.contexts || []).map((c) => ({
              id: c.id,
              filename: c.filename,
              content: c.content,
              score: c.score ?? undefined,
            })) || [];
          if (row.message_id) byMessage[row.message_id] = items;
          else leftovers.push(row);
        }

        // merge with existing msgs
        const toPersist: Record<string, ContextItem[]> = {};
        const merged = msgs.map((m) => {
          if (m.role !== "assistant") return m;
          const server = byMessage[m.id];
          if (server?.length) {
            toPersist[m.id] = server;
            return { ...m, contexts: server };
          }
          if (m.contexts?.length) {
            toPersist[m.id] = m.contexts;
            return m;
          }
          return m;
        });

        // assign leftovers to newest answers without contexts (best-effort)
        if (leftovers.length) {
          const idxs = merged
            .map((m, i) =>
              m.role === "assistant" && !m.contexts?.length ? i : -1
            )
            .filter((i) => i >= 0);
          const assign = Math.min(idxs.length, leftovers.length);
          for (let k = 0; k < assign; k++) {
            const i = idxs[idxs.length - 1 - k];
            const row = leftovers[k];
            const items =
              (row?.contexts || []).map((c) => ({
                id: c.id,
                filename: c.filename,
                content: c.content,
                score: c.score ?? undefined,
              })) || [];
            merged[i] = { ...merged[i], contexts: items };
            toPersist[merged[i].id] = items;
          }
        }

        const persisted = mergeCtxCache(conversationId, toPersist);
        if (seq === reqSeqRef.current && !ctrl.signal.aborted) {
          setChatHistory(merged);
          setCtxHistory(history);
          setCtxByMessage(persisted);
        }
      } catch (e: any) {
        if (e?.name !== "AbortError")
          console.error("Load conversation error:", e);
      }
    })();

    return () => ctrl.abort();
  }, [conversationId, token, scrollToBottom]);

  /* -------- derive “Used in this conversation” -------- */
  const { usedCounts, usedSamples } = useMemo(() => {
    const counts: Record<string, number> = {};
    const samples: Record<string, string> = {};
    const push = (f: string | undefined, c: string | undefined) => {
      if (!f) return;
      counts[f] = (counts[f] || 0) + 1;
      if (c && !samples[f]) samples[f] = c.slice(0, 240);
    };
    // collect from per-message cache
    Object.values(ctxByMessage || {}).forEach((arr) =>
      (arr || []).forEach((x) => push(x.filename, x.content))
    );
    // also collect from history rows
    (ctxHistory || []).forEach((row) =>
      (row.contexts || []).forEach((x) => push(x.filename, x.content))
    );
    return { usedCounts: counts, usedSamples: samples };
  }, [ctxByMessage, ctxHistory, conversationId]);

  /* -------- repo status -------- */
  useEffect(() => {
    setManuallyReady(false);
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
        const label = (s?.status || "").toLowerCase();
        const docs = Number(s?.stats?.documents || 0);
        if (label === "indexed" || label === "done" || docs > 0) {
          setManuallyReady(true);
        }
      } catch {}
    })();
  }, [repoId, token]);

  /* repo selection / create convo */
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

  const hasAssistantHistory = useMemo(
    () => chatHistory.some((m) => m.role === "assistant"),
    [chatHistory]
  );

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

  /* ask */
  const handleAsk = useCallback(
    async (question: string) => {
      if (!repoId || isAsking) return;

      // minimal readiness re-check
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
        const clientQueryId =
          (window.crypto as any)?.randomUUID?.() ||
          `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const tempId = `temp-${Date.now()}`;
        const userMsg: ChatMessage = {
          id: tempId,
          role: "user",
          content: question,
          created_at: new Date().toISOString(),
        };
        setChatHistory((h) => [...h, userMsg]);
        requestAnimationFrame(() => scrollToBottom("smooth"));

        await fetch("/api/messages", {
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
            user_id: user?.id ?? null,
            client_query_id: clientQueryId,
          }),
        });

        if (!ansRes.ok) {
          const body = await ansRes.text();
          console.error("Answer failed:", ansRes.status, body);
          setChatHistory((h) => [
            ...h.filter((m) => m.id !== tempId),
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: "(no answer)",
              created_at: new Date().toISOString(),
            },
          ]);
          requestAnimationFrame(() => scrollToBottom("smooth"));
          return;
        }

        const { answer, contexts } = (await ansRes.json()) as {
          answer: string;
          contexts?: ContextItem[];
        };

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
        const savedA = aRes.ok ? await aRes.json() : null;

        const assistantMsg: ChatMessage = {
          id: savedA?.id ? String(savedA.id) : `a-${Date.now()}`,
          role: "assistant",
          content: answer,
          created_at: savedA?.created_at ?? new Date().toISOString(),
          contexts: contexts ?? [],
        };

        setChatHistory((h) => [
          ...h.filter((m) => m.id !== tempId),
          userMsg,
          assistantMsg,
        ]);
        requestAnimationFrame(() => scrollToBottom("smooth"));

        // persist contexts → right pane “used” counts/snippets update instantly
        if (assistantMsg.contexts?.length && convId) {
          const merged = mergeCtxCache(convId, {
            [assistantMsg.id]: assistantMsg.contexts,
          });
          setCtxByMessage(merged);
        }

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

        setReloadKey((k) => k + 1);
      } catch (e) {
        console.error("Ask error:", e);
      } finally {
        setIsAsking(false);
      }
    },
    [
      repoId,
      isAsking,
      isRepoReady,
      ensureConversation,
      token,
      user?.id,
      scrollToBottom,
    ]
  );

  /* UI helpers */
  const onToggleRepo = (rid: string) =>
    setExpanded((prev) => ({ ...prev, [rid]: !prev[rid] }));
  const onSelectConvo = (_rid: string, cid: string) => {
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
    setCtxHistory([]);
    setCtxByMessage({});
    setPreviewPath(null);
    setPreviewContent("");
  };

  // show/hide upload/index UI
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

  const showIndexingNotice = useMemo(() => {
    if (!repoStatus) return false;
    const label = (repoStatus.status || "").toLowerCase();
    const docs = Number(repoStatus.stats?.documents || 0);
    if (docs > 0) return false;
    return (label === "indexing" || label === "upload") && !isAsking;
  }, [repoStatus, isAsking]);

  const activeConversationId = conversationId;

  const onNewChatForRepo = useCallback(
    async (rid: string) => {
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
    },
    [token, navigate]
  );

  return (
    <>
      <Toaster position="top-right" richColors />

      {/* 4 columns: [sidebar][chat][handle][right-pane] */}
      {(() => {
        const handleWidth = rightOpen ? 6 : 0; // px
        const paneWidth = rightOpen ? rightWidth : 0; // px
        return (
          <div
            className="h-screen w-full grid"
            style={{
              gridTemplateColumns: `300px minmax(0,1fr) ${handleWidth}px ${paneWidth}px`,
            }}
          >
            {/* LEFT: conversations (col 1) */}
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

            {/* MIDDLE: chat (col 2) */}
            <main className="h-screen min-h-0 min-w-0 flex flex-col border-r border-gray-200 dark:border-gray-800">
              <div className="max-w-3xl w-full mx-auto flex-1 min-h-0 min-w-0 flex flex-col">
                {/* header / setup zone */}
                <div className="px-4 pt-4 flex items-center gap-3">
                  {showUploadForm && (
                    <UploadForm
                      onRepoId={handleRepoId}
                      onIndexingComplete={handleIndexed}
                    />
                  )}

                  {/* toggle right pane */}
                  {repoId && (
                    <button
                      className="ml-auto text-xs rounded border px-3 py-1.5 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                      onClick={() => setRightOpen((v) => !v)}
                      title={rightOpen ? "Hide files" : "Show files"}
                    >
                      {rightOpen ? "Hide files" : "Show files"}
                    </button>
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
                    </div>
                  )}
                  <div ref={bottomRef} className="h-0" />
                </div>

                {/* composer */}
                {repoId && !newRepoMode && (
                  <div className="sticky bottom-0 w-full border-t bg-white/80 dark:bg-zinc-900/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 px-4 py-3">
                    <div className="max-w-3xl mx-auto">
                      {/* @ts-ignore QueryForm may not accept disabled in its typing */}
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
                          Indexing… You can browse or upload another repo while
                          this finishes.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </main>

            {/* DRAG HANDLE (col 3) */}
            <div
              onMouseDown={onDragStart}
              className="h-screen cursor-col-resize bg-transparent hover:bg-blue-300/40"
              style={{
                display: rightOpen ? "block" : "none",
                // fills the whole column width; grid column width controls size
                width: "100%",
              }}
              // improve target size even when only 6px wide
              role="separator"
              aria-orientation="vertical"
            />

            {/* RIGHT: File tree + preview (col 4) */}
            <aside
              className={`h-screen min-h-0 min-w-0 overflow-hidden border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-900 ${
                rightOpen ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
            >
              <div className="h-full grid grid-rows-[auto_minmax(0,1fr)]">
                {/* File tree */}
                {repoId ? (
                  <div className="p-3 border-b dark:border-gray-800">
                    <FileTree
                      repoId={repoId}
                      onSelectFile={handleSelectFile}
                      usedCounts={usedCounts}
                      usedSamples={usedSamples}
                      defaultFilter="used"
                    />
                  </div>
                ) : (
                  <div className="p-3 text-sm text-gray-500">
                    No repo selected
                  </div>
                )}

                {/* Preview */}
                <div className="min-h-0 overflow-auto">
                  {previewPath ? (
                    <div className="p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-sm font-medium truncate">
                          {previewPath}
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="text-xs rounded border px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                            onClick={() => {
                              navigator.clipboard.writeText(previewContent);
                              toast.success("File copied");
                            }}
                          >
                            Copy file
                          </button>
                          <button
                            className="text-xs rounded border px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                            onClick={() => {
                              setPreviewPath(null);
                              setPreviewContent("");
                            }}
                          >
                            Close
                          </button>
                        </div>
                      </div>
                      <pre className="text-xs whitespace-pre-wrap break-words bg-gray-50 dark:bg-zinc-900 border rounded p-3 max-h-[calc(100vh-230px)] overflow-auto">
                        {previewContent}
                      </pre>
                    </div>
                  ) : (
                    <div className="h-full grid place-items-center text-xs text-gray-500">
                      Select a file to preview
                    </div>
                  )}
                </div>
              </div>
            </aside>
          </div>
        );
      })()}
    </>
  );
}
