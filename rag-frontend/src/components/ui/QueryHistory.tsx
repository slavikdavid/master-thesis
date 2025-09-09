// src/components/history/QueryHistory.tsx
import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useAuth } from "../../context/AuthContext";
import { AnswerDisplay } from "../ui/AnswerDisplay";
import { toast } from "sonner";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

type ContextMeta = {
  id?: string | null;
  filename: string;
  content: string;
};

type Props = {
  conversationId: string | null;
  /** if true, newest first (default false so it matches normal chat flow) */
  newestFirst?: boolean;
  /** increment to force re-fetch (after sending a new message) */
  refreshKey?: number;
};

export function QueryHistory({
  conversationId,
  newestFirst = false,
  refreshKey = 0,
}: Props) {
  const { token } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [contexts, setContexts] = useState<ContextMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleted, setDeleted] = useState(false);

  // listen for "conversation:deleted" broadcast by Sidebar after a successful delete
  useEffect(() => {
    const onDeleted = (e: Event) => {
      const detail = (e as CustomEvent<{ repoId: string; convoId: string }>)
        .detail;
      if (detail?.convoId === conversationId) {
        setMessages([]);
        setContexts([]);
        setDeleted(true);
        toast.info("This conversation was deleted.");
      }
    };
    window.addEventListener("conversation:deleted", onDeleted as EventListener);
    return () =>
      window.removeEventListener(
        "conversation:deleted",
        onDeleted as EventListener
      );
  }, [conversationId]);

  // fetch messages
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setContexts([]);
      setDeleted(false);
      return;
    }
    if (deleted) return;

    const ctrl = new AbortController();
    setLoading(true);

    axios
      .get<Message[]>("/api/messages", {
        params: { conversation_id: conversationId },
        signal: ctrl.signal,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      })
      .then((res) => {
        const data = Array.isArray(res.data) ? res.data : [];
        setMessages(data);
      })
      .catch((err) => {
        if (axios.isCancel(err)) return;
        const status = err?.response?.status;
        if (status === 404 || status === 410) {
          setMessages([]);
          setContexts([]);
          setDeleted(true);
          toast.info("This conversation was deleted.");
        } else {
          console.error("Failed to fetch messages:", err);
          setMessages([]);
        }
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [conversationId, token, refreshKey, deleted]);

  // fetch contexts (server source of truth so they survive F5)
  useEffect(() => {
    if (!conversationId || deleted) return;

    const ctrl = new AbortController();
    axios
      .get<ContextMeta[]>(
        `/api/conversations/${encodeURIComponent(conversationId)}/contexts`,
        {
          signal: ctrl.signal,
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        }
      )
      .then((res) => {
        const data = Array.isArray(res.data) ? res.data : [];
        setContexts(data);
      })
      .catch((err) => {
        if (axios.isCancel(err)) return;
        const status = err?.response?.status;
        if (status === 404 || status === 410) {
          // if contexts endpoint says gone, clear them
          setContexts([]);
        } else {
          console.warn("Failed to fetch contexts:", err);
          setContexts([]); // be resilient
        }
      });

    return () => ctrl.abort();
  }, [conversationId, token, refreshKey, deleted]);

  const ordered = useMemo(() => {
    const sorted = [...messages].sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : 0;
      const tb = b.created_at ? Date.parse(b.created_at) : 0;
      return ta - tb;
    });
    return newestFirst ? sorted.reverse() : sorted;
  }, [messages, newestFirst]);

  // Determine which message should show the context chips.
  // Convention: show on the most recent assistant message.
  const lastAssistantId = useMemo(() => {
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].role === "assistant") return ordered[i].id;
    }
    return null;
  }, [ordered]);

  if (loading && !ordered.length) return null;
  if (!ordered.length) return null;

  return (
    <>
      {ordered.map((msg) => (
        <div
          key={msg.id}
          className={`border rounded p-4 ${
            msg.role === "user" ? "bg-gray-50 dark:bg-gray-900/40" : ""
          }`}
        >
          {msg.role === "user" ? (
            <p className="font-medium">Q: {msg.content}</p>
          ) : (
            <AnswerDisplay
              answer={msg.content}
              // only attach contexts to the latest assistant answer
              contexts={msg.id === lastAssistantId ? contexts : []}
            />
          )}
        </div>
      ))}
    </>
  );
}
