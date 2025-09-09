import { useEffect, useRef, useState } from "react";

export type ContextItem = {
  id?: string;
  filename: string;
  content: string;
  score?: number | null;
};
export type HistoryRow = {
  message_id: string | null;
  rag_query_id: string;
  contexts: ContextItem[];
};

export type ContextSummary = {
  byMessage: Record<string, ContextItem[]>;
  byFile: Record<
    string,
    { uses: number; lastUsedAt?: number; sample?: string }
  >;
  totalChunks: number;
};

const key = (cid: string) => `ctxcache:${cid}`;

export function useConversationContext(
  conversationId: string | null,
  token?: string | null
) {
  const [summary, setSummary] = useState<ContextSummary>({
    byMessage: {},
    byFile: {},
    totalChunks: 0,
  });
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!conversationId) {
      setSummary({ byMessage: {}, byFile: {}, totalChunks: 0 });
      return;
    }
    const my = ++seq.current;
    setLoading(true);

    // 1) hydrate from local cache first for instant UI
    try {
      const raw = localStorage.getItem(key(conversationId));
      if (raw) {
        const cached: Record<string, ContextItem[]> = JSON.parse(raw);
        const agg: Record<
          string,
          { uses: number; lastUsedAt?: number; sample?: string }
        > = {};
        Object.entries(cached).forEach(([messageId, items], idx) => {
          for (const c of items || []) {
            const f = c.filename || "snippet.txt";
            const cur = agg[f] || { uses: 0 };
            cur.uses += 1;
            cur.lastUsedAt = Math.max(cur.lastUsedAt ?? 0, idx + 1);
            cur.sample ||= (c.content || "").slice(0, 240);
            agg[f] = cur;
          }
        });
        if (my === seq.current) {
          setSummary({
            byMessage: cached,
            byFile: agg,
            totalChunks: Object.values(cached).reduce(
              (a, b) => a + (b?.length || 0),
              0
            ),
          });
        }
      }
    } catch {}

    // 2) fetch authoritative history
    const ctrl = new AbortController();
    fetch(
      `/api/conversations/${encodeURIComponent(
        conversationId
      )}/contexts/history`,
      {
        signal: ctrl.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }
    )
      .then(async (r) => (r.ok ? ((await r.json()) as HistoryRow[]) : []))
      .then((rows) => {
        if (my !== seq.current) return;
        const byMessage: Record<string, ContextItem[]> = {};
        const byFile: Record<
          string,
          { uses: number; lastUsedAt?: number; sample?: string }
        > = {};
        let count = 0;

        rows.forEach((row, idx) => {
          const list = (row.contexts || []).map((c) => ({
            id: c.id,
            filename: c.filename || "snippet.txt",
            content: c.content || "",
            score: c.score ?? null,
          }));
          count += list.length;

          if (row.message_id) byMessage[row.message_id] = list;

          for (const c of list) {
            const f = c.filename;
            const cur = byFile[f] || { uses: 0 };
            cur.uses += 1;
            cur.lastUsedAt = Math.max(cur.lastUsedAt ?? 0, idx + 1);
            cur.sample ||= c.content.slice(0, 240);
            byFile[f] = cur;
          }
        });

        // persist for instant F5
        try {
          localStorage.setItem(key(conversationId), JSON.stringify(byMessage));
        } catch {}

        setSummary({ byMessage, byFile, totalChunks: count });
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [conversationId, token]);

  return { summary, loading };
}
