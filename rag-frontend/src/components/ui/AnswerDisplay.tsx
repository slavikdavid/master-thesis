import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, ChevronDown, ChevronUp, Check } from "lucide-react";
import { Button } from "./button";
import { FileIcon } from "@/utils/fileIcons";

/* ---------------- types ---------------- */

type ContextMeta = {
  id?: string | null;
  filename: string;
  content: string;
};

interface Props {
  answer: string;
  className?: string;
  /** streaming type-out */
  stream?: boolean;
  /** characters per second for typing effect when streaming */
  cps?: number;
  /** collapsed height in px; content expands if taller */
  collapseAtPx?: number;
  /** retrieved contexts to show as “shields” */
  contexts?: ContextMeta[];
}

/* ---------------- helpers ---------------- */

/** remove <think>…</think> blocks */
function stripThinkBlocks(md: string): string {
  if (!md) return md;
  let out = md.replace(/<think>[\s\S]*?<\/think>/gi, "");
  out = out.replace(/<\/?think>/gi, "");
  return out;
}

/** convert 1-line code blocks to inline code */
function normalizeOneLineFences(md: string): string {
  // ```lang\ncontent\n```  -> `content`
  md = md.replace(
    /```[a-z0-9_-]*\s*\n([^\n`]{1,120})\n```/gi,
    (_, s1: string) => `\`${s1.trim()}\``
  );
  // ```content``` (same line open/close) -> `content`
  md = md.replace(
    /```[a-z0-9_-]*\s*([^\n`]{1,120})\s*```/gi,
    (_, s1: string) => `\`${s1.trim()}\``
  );
  return md;
}

/** escape < and > outside code so generics render correctly. */
function escapeAnglesOutsideCode(md: string): string {
  const cleaned = stripThinkBlocks(normalizeOneLineFences(md));

  // convert <https://...> and <mailto:...> to markdown links to not escape them.
  const linkFixed = cleaned.replace(
    /<((?:https?:\/\/|mailto:)[^ >]+)>/g,
    "[$1]($1)"
  );

  // split into code and non-code segments
  const parts: string[] = [];
  const regex = /(```[\s\S]*?```|`[^`]*`)/g; // fenced or inline code
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(linkFixed))) {
    if (match.index > last) {
      const text = linkFixed.slice(last, match.index);
      parts.push(text.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
    parts.push(match[0]); // keep code segments intact
    last = match.index + match[0].length;
  }
  if (last < linkFixed.length) {
    parts.push(
      linkFixed.slice(last).replace(/</g, "&lt;").replace(/>/g, "&gt;")
    );
  }
  return parts.join("");
}

/** progressive typing effect for streaming. */
function useStreamingText(fullText: string, enabled: boolean, cps = 80) {
  const [displayed, setDisplayed] = useState("");
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(performance.now());
  const indexRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setDisplayed(fullText);
      return;
    }
    setDisplayed("");
    indexRef.current = 0;
    lastTimeRef.current = performance.now();

    const step = (time: number) => {
      const delta = time - lastTimeRef.current;
      const charsToAdd = Math.floor((delta / 1000) * cps);
      if (charsToAdd > 0) {
        indexRef.current = Math.min(
          fullText.length,
          indexRef.current + charsToAdd
        );
        setDisplayed(fullText.slice(0, indexRef.current));
        lastTimeRef.current = time;
      }
      if (indexRef.current < fullText.length) {
        rafRef.current = requestAnimationFrame(step);
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [fullText, enabled, cps]);

  return displayed;
}

/* ---------------- code block renderer ---------------- */

function looksLikeIdentifier(s: string) {
  // single line, short, and composed of common identifier/file chars
  if (!s || s.length > 120) return false;
  if (s.includes("\n") || s.includes("\r")) return false;
  // allow letters, numbers, underscore, dash, dot, slash, colon, at
  return /^[A-Za-z0-9_\-./:@]+$/.test(s.trim());
}

const CodeBlock: React.FC<{
  inline?: boolean;
  className?: string;
  children: React.ReactNode[] | React.ReactNode;
}> = ({ inline, className, children }) => {
  const code = String(
    Array.isArray(children) ? children?.[0] ?? "" : children ?? ""
  );
  const match = /language-(\S+)/.exec(className || "");
  const language = (match && match[1]) || "text";
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 900);
      },
      () => {}
    );
  }, [code]);

  // force inline for identifiers
  if (inline || looksLikeIdentifier(code)) {
    return (
      <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded font-mono text-[0.9em] align-baseline">
        {code}
      </code>
    );
  }

  return (
    <div className="relative my-4 group">
      <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleCopy}
          aria-label="Copy code"
          className="p-1 h-7"
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        showLineNumbers
        wrapLongLines
        customStyle={{
          borderRadius: 8,
          paddingTop: 32,
          margin: 0,
          fontSize: 13,
        }}
        codeTagProps={{
          style: {
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

/* ---------------- paragraph renderer that unwraps single inline-code ---------------- */

const ParagraphMaybeInline: Components["p"] = ({ node, children }) => {
  const pNode = node as any;
  const kids = (pNode?.children ?? []) as Array<any>;
  const nonSpaceKids = kids.filter(
    (k) => !(k.type === "text" && String(k.value || "").trim() === "")
  );

  if (nonSpaceKids.length === 1 && nonSpaceKids[0].type === "inlineCode") {
    const value = String(nonSpaceKids[0].value ?? "");
    return (
      <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded font-mono text-[0.9em] align-baseline">
        {value}
      </code>
    );
  }

  return <p className="whitespace-pre-wrap break-words">{children}</p>;
};

/* ---------------- context chip ---------------- */

const ContextChip: React.FC<{
  ctx: ContextMeta;
  onOpen: (ctx: ContextMeta) => void;
}> = ({ ctx, onOpen }) => {
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={() => onOpen(ctx)}
        className="inline-flex items-center gap-1 rounded-full border bg-white/70 dark:bg-slate-800/70 px-2.5 py-1 text-xs
                   hover:bg-white dark:hover:bg-slate-800 shadow-sm"
        title={ctx.filename}
      >
        <FileIcon filename={ctx.filename} />
        <span className="truncate max-w-52">{ctx.filename}</span>
      </button>

      {/* hover preview tooltip */}
      <div
        className="hidden group-hover:block absolute z-50 mt-2 w-[28rem] max-w-[80vw] rounded-md border bg-white dark:bg-slate-900 shadow-lg
                   p-3 text-xs leading-relaxed"
        style={{ left: 0 }}
      >
        <div className="font-medium mb-2 truncate flex items-center gap-2">
          <FileIcon filename={ctx.filename} />
          <span className="truncate">{ctx.filename}</span>
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
          {ctx.content}
        </pre>
      </div>
    </div>
  );
};

/* ---------------- main ---------------- */

export function AnswerDisplay({
  answer,
  className = "",
  stream = false,
  cps = 120,
  collapseAtPx = 520,
  contexts = [],
}: Props) {
  const safeAnswer = useMemo(
    () => escapeAnglesOutsideCode(answer ?? ""),
    [answer]
  );
  const streamingText = useStreamingText(safeAnswer, stream, cps);
  const isStreaming = stream && streamingText !== safeAnswer;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [fadeIn, setFadeIn] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  // side panel
  const [openCtx, setOpenCtx] = useState<ContextMeta | null>(null);

  // fade in on content change
  useEffect(() => {
    setFadeIn(false);
    const t = setTimeout(() => setFadeIn(true), 10);
    return () => clearTimeout(t);
  }, [streamingText, safeAnswer]);

  // auto-scroll while streaming
  useEffect(() => {
    if (isStreaming && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [streamingText, isStreaming]);

  // measure to decide collapse
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => setNeedsCollapse(el.scrollHeight > collapseAtPx + 40);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapseAtPx, streamingText]);

  const copyAll = useCallback(() => {
    const text = answer ?? "";
    navigator.clipboard.writeText(text).then(
      () => {
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 900);
      },
      () => {}
    );
  }, [answer]);

  return (
    <>
      {/* context chips row */}
      {contexts.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {contexts.map((c, i) => (
            <ContextChip
              key={c.id ?? `${c.filename}-${i}`}
              ctx={c}
              onOpen={setOpenCtx}
            />
          ))}
        </div>
      )}

      <div
        ref={containerRef}
        className={`prose prose-slate dark:prose-invert max-w-none break-words bg-gray-50 dark:bg-gray-900 p-4 rounded border
                    border-gray-200 dark:border-gray-800 ${className}`}
        style={{ position: "relative" }}
      >
        {/* header actions */}
        <div className="flex items-center justify-end gap-2 mb-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={copyAll}
            className="h-8 px-2"
          >
            {copiedAll ? (
              <Check className="h-4 w-4 mr-1" />
            ) : (
              <Copy className="h-4 w-4 mr-1" />
            )}
            Copy answer
          </Button>
          {needsCollapse && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCollapsed((v) => !v)}
              className="h-8 px-2"
            >
              {collapsed ? (
                <ChevronDown className="h-4 w-4 mr-1" />
              ) : (
                <ChevronUp className="h-4 w-4 mr-1" />
              )}
              {collapsed ? "Show more" : "Show less"}
            </Button>
          )}
        </div>

        <div
          ref={contentRef}
          className={`transition-opacity duration-300 ${
            fadeIn ? "opacity-100" : "opacity-0"
          }`}
          style={{
            maxHeight: needsCollapse && collapsed ? collapseAtPx : "none",
            overflow: needsCollapse && collapsed ? "hidden" : "visible",
            maskImage:
              needsCollapse && collapsed
                ? "linear-gradient(to bottom, black 80%, transparent 100%)"
                : "none",
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ({ inline, className, children }) => (
                <CodeBlock inline={inline} className={className}>
                  {children as any}
                </CodeBlock>
              ),
              a: ({ href, children, ...props }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline break-words"
                  {...props}
                >
                  {children}
                </a>
              ),
              pre: ({ children, ...props }) => (
                <div {...props} className="overflow-x-auto">
                  {children}
                </div>
              ),
              // unwrap paragraphs that contain only a single inline code token
              p: ParagraphMaybeInline,
            }}
          >
            {streamingText}
          </ReactMarkdown>

          {isStreaming && (
            <span
              aria-hidden="true"
              className="inline-block align-bottom ml-1"
              style={{
                width: 10,
                display: "inline-flex",
                animation: "blink 1s step-end infinite",
              }}
            >
              <span
                style={{
                  backgroundColor: "currentColor",
                  width: 8,
                  height: 18,
                  display: "inline-block",
                  borderRadius: 2,
                }}
              />
              <style>
                {`
                @keyframes blink {
                  0%, 50% { opacity: 1; }
                  51%, 100% { opacity: 0; }
                }
              `}
              </style>
            </span>
          )}
        </div>
      </div>

      {/* Sidebar panel with full context */}
      {openCtx && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-[90]"
            onClick={() => setOpenCtx(null)}
            aria-hidden="true"
          />
          <aside
            className="fixed right-0 top-0 bottom-0 w-[min(42rem,90vw)] z-[91] bg-white dark:bg-slate-950 border-l
                       border-gray-200 dark:border-gray-800 shadow-xl flex flex-col"
            role="dialog"
            aria-modal="true"
          >
            <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-2 truncate">
                <FileIcon filename={openCtx.filename} />
                <span className="font-medium truncate">{openCtx.filename}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(openCtx.content);
                  }}
                >
                  <Copy className="h-4 w-4 mr-1" />
                  Copy file
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpenCtx(null)}
                >
                  Close
                </Button>
              </div>
            </div>
            <div className="p-4 overflow-auto text-sm">
              <pre className="whitespace-pre-wrap break-words">
                {openCtx.content}
              </pre>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
