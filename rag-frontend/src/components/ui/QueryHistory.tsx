// src/components/history/QueryHistory.tsx
import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useAuth } from "../../context/AuthContext";
import { AnswerDisplay } from "../ui/AnswerDisplay";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string; // optional; depends on your API
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }

    const ctrl = new AbortController();
    setLoading(true);

    axios
      .get<Message[]>(`/api/messages`, {
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
        console.error("Failed to fetch messages:", err);
        setMessages([]);
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [conversationId, token, refreshKey]);

  const ordered = useMemo(() => {
    const sorted = [...messages].sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : 0;
      const tb = b.created_at ? Date.parse(b.created_at) : 0;
      return ta - tb;
    });
    return newestFirst ? sorted.reverse() : sorted;
  }, [messages, newestFirst]);

  // don’t render anything if nothing to show
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
            <AnswerDisplay answer={msg.content} />
          )}
        </div>
      ))}
    </>
  );
}
