"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PaperPlaneTilt,
  Robot,
  User,
  CheckCircle,
  XCircle,
  Lightning,
  BookOpen,
  ClockCounterClockwise,
  ArrowClockwise,
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";

// ─── Types ────────────────────────────────────────────────────────────────────

type MessageRole = "user" | "assistant" | "system";

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolUsed?: string;
  traceId?: string;
}

interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  message: string;
}

type ApprovalStatus = "idle" | "approving" | "rejecting" | "done";

// ─── Constants ────────────────────────────────────────────────────────────────

const CONVERSATION_ID =
  typeof crypto !== "undefined"
    ? crypto.randomUUID()
    : Math.random().toString(36);

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusPill({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className="flex items-center gap-2 text-xs text-zinc-500 px-1"
    >
      <motion.span
        animate={{ opacity: [1, 0.3, 1] }}
        transition={{ duration: 1.2, repeat: Infinity }}
        className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"
      />
      {text}
    </motion.div>
  );
}

function ApprovalCard({
  action,
  onResolve,
}: {
  action: PendingAction;
  onResolve: (id: string, decision: "approve" | "reject") => void;
}) {
  const [status, setStatus] = useState<ApprovalStatus>("idle");
  const [pendingStatus, setPendingStatus] = useState<"approved" | "rejected" | null>(null);

  const handle = async (decision: "approve" | "reject") => {
    setStatus(decision === "approve" ? "approving" : "rejecting");

    const res = await fetch(`/api/actions/${action.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: decision }),
    });

    const data = await res.json();

    setPendingStatus(decision === "approve" ? "approved" : "rejected");
    setStatus("done");

    if (decision === "approve" && data.result?.data?.email_id) {
      setTimeout(() => onResolve(action.id, decision), 2500);
    } else if (decision === "reject") {
      setTimeout(() => onResolve(action.id, decision), 1000);
    } else {
      setTimeout(() => onResolve(action.id, decision), 1500);
    }
  };

  const args = action.args as { to?: string; subject?: string; body?: string };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="border border-amber-500/30 bg-amber-500/5 rounded-xl p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        <Lightning size={14} className="text-amber-400" weight="fill" />
        <span className="text-xs font-medium text-amber-400 uppercase tracking-wider">
          Approval Required
        </span>
      </div>

      <div className="space-y-1 text-sm">
        <div className="text-zinc-400">
          <span className="text-zinc-500">Tool: </span>
          <span className="font-mono text-zinc-300">{action.toolName}</span>
        </div>
        {args.to && (
          <div className="text-zinc-400">
            <span className="text-zinc-500">To: </span>
            <span className="text-zinc-300">{args.to}</span>
          </div>
        )}
        {args.subject && (
          <div className="text-zinc-400">
            <span className="text-zinc-500">Subject: </span>
            <span className="text-zinc-300">{args.subject}</span>
          </div>
        )}
        {args.body && (
          <div className="text-zinc-500 text-xs font-mono bg-zinc-900 rounded-lg p-3 leading-relaxed border border-zinc-800">
            {args.body}
          </div>
        )}
      </div>

      {status === "done" ? (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className={`flex items-center gap-2 text-xs ${pendingStatus === "approved" ? "text-emerald-400" : "text-zinc-500"
            }`}
        >
          <CheckCircle size={13} weight="fill" />
          {pendingStatus === "approved"
            ? "Email sent successfully."
            : "Action rejected."}
        </motion.div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => handle("approve")}
            disabled={status !== "idle"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            <CheckCircle size={13} weight="fill" />
            {status === "approving" ? "Sending..." : "Approve"}
          </button>
          <button
            onClick={() => handle("reject")}
            disabled={status !== "idle"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 text-xs font-medium hover:bg-zinc-700 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            <XCircle size={13} weight="fill" />
            {status === "rejecting" ? "Rejecting..." : "Reject"}
          </button>
        </div>
      )}
    </motion.div>
  );
}

function KnowledgePanel({ onClose }: { onClose: () => void }) {
  const [content, setContent] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );

  const upload = async () => {
    if (!content.trim() || !source.trim()) return;
    setStatus("loading");

    const res = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, source }),
    });

    setStatus(res.ok ? "done" : "error");
    if (res.ok) {
      setContent("");
      setSource("");
      setTimeout(() => setStatus("idle"), 2000);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="absolute inset-0 bg-zinc-950 z-10 flex flex-col"
    >
      <div className="flex items-center justify-between p-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <BookOpen size={15} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">
            Upload to Knowledge Base
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Close
        </button>
      </div>

      <div className="flex-1 p-4 space-y-3 overflow-y-auto">
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-500">Source name</label>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="e.g. pricing-policy.md"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-zinc-500">Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste document content here..."
            rows={10}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors resize-none font-mono leading-relaxed"
          />
        </div>

        <button
          onClick={upload}
          disabled={status === "loading" || !content.trim() || !source.trim()}
          className="w-full py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm font-medium hover:bg-emerald-500/20 active:scale-[0.98] transition-all disabled:opacity-40"
        >
          {status === "loading"
            ? "Uploading..."
            : status === "done"
              ? "Uploaded"
              : status === "error"
                ? "Failed — try again"
                : "Upload"}
        </button>
      </div>
    </motion.div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [showKB, setShowKB] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<ChatMessage[]>([]);

  // Keep history ref in sync for sending to API
  useEffect(() => {
    historyRef.current = messages;
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingActions, statusText]);

  const appendToken = useCallback((id: string, token: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, content: m.content + token } : m
      )
    );
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setStreaming(true);
    setStatusText("");

    // Create placeholder assistant message for streaming into
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
    };

    setMessages((prev) => [...prev, assistantMsg]);
    setStreamingId(assistantId);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversation_id: CONVERSATION_ID,
          conversation_history: historyRef.current.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === "status") {
              setStatusText(event.message);
            } else if (event.type === "token") {
              appendToken(assistantId, event.token);
              setStatusText("");
            } else if (event.type === "pending_approval") {
              // Remove placeholder, show approval card instead
              setMessages((prev) =>
                prev.filter((m) => m.id !== assistantId)
              );
              setPendingActions((prev) => [
                ...prev,
                {
                  id: event.pendingActionId,
                  toolName: event.toolName,
                  args: event.args,
                  message: event.message,
                },
              ]);
              setStatusText("");
            } else if (event.type === "done") {
              setStatusText("");
            } else if (event.type === "error") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                      ...m,
                      content:
                        event.message ?? "Something went wrong.",
                      role: "system",
                    }
                    : m
                )
              );
            }
          } catch {
            // malformed SSE line — skip
          }
        }
      }
    } catch (err) {
      console.error("[chat] fetch error:", err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "Connection error. Please try again.", role: "system" }
            : m
        )
      );
    } finally {
      setStreaming(false);
      setStreamingId(null);
      setStatusText("");
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const resolveAction = (id: string) => {
    setPendingActions((prev) => prev.filter((a) => a.id !== id));
  };

  const backfillKB = async () => {
    await fetch("/api/knowledge");
  };

  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-zinc-200 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-zinc-800/40 px-4 py-3 flex items-center justify-between backdrop-blur-md bg-zinc-950/70 shadow-[0_1px_0_rgba(255,255,255,0.04),inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <Robot size={14} className="text-emerald-400" weight="fill" />
          </div>
          <div>
            <div className="text-sm font-medium text-zinc-100 tracking-tight">
              Warrant
            </div>
            <div className="text-[10px] text-zinc-600 font-mono">
              Every action, warranted.
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={backfillKB}
            title="Backfill KB embeddings"
            className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-all active:scale-[0.97]"
          >
            <ArrowClockwise size={14} />
          </button>
          <button
            onClick={() => setShowKB((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700/60 text-zinc-400 text-xs hover:text-zinc-200 hover:border-zinc-600 transition-all active:scale-[0.97]"
          >
            <BookOpen size={12} />
            Knowledge
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat panel */}
        <div className="flex-1 flex flex-col relative">
          <AnimatePresence>
            {showKB && <KnowledgePanel onClose={() => setShowKB(false)} />}
          </AnimatePresence>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
            <AnimatePresence initial={false}>
              {messages.length === 0 && (
                <motion.div
                  key="empty-state"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center h-full min-h-[40vh] text-center space-y-3"
                >
                  <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <Robot
                      size={22}
                      className="text-emerald-400"
                      weight="fill"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-zinc-300">
                      Ready to assist
                    </div>
                    <div className="text-xs text-zinc-600 max-w-[260px] leading-relaxed">
                      Ask about policies, look up customers, create tasks, or
                      draft emails.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 justify-center pt-2">
                    {[
                      "What's our retainer pricing?",
                      "Look up Amaka Osei",
                      "Create a task to follow up with Zara Events",
                      "Draft an email to tunde@constructgroup.com",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => {
                          setInput(suggestion);
                          inputRef.current?.focus();
                        }}
                        className="text-[11px] px-3 py-1.5 rounded-full bg-zinc-800/80 border border-zinc-700/60 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-all"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"
                    }`}
                >
                  {msg.role !== "user" && (
                    <div className="w-6 h-6 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5">
                      <Robot size={11} className="text-emerald-400" weight="fill" />
                    </div>
                  )}

                  <div
                    className={`max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === "user"
                      ? "bg-zinc-800 text-zinc-100 rounded-tr-sm"
                      : msg.role === "system"
                        ? "bg-red-500/10 border border-red-500/20 text-red-400"
                        : "bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-tl-sm"
                      }`}
                  >
                    {msg.content ? (
                      msg.role === "user" ? (
                        msg.content
                      ) : (
                        <div className="prose-chat">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      )
                    ) : streamingId === msg.id ? (
                      <motion.span
                        animate={{ opacity: [1, 0] }}
                        transition={{ duration: 0.6, repeat: Infinity }}
                        className="inline-block w-2 h-4 bg-emerald-400 rounded-sm"
                      />
                    ) : null}
                  </div>

                  {msg.role === "user" && (
                    <div className="w-6 h-6 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0 mt-0.5">
                      <User size={11} className="text-zinc-400" />
                    </div>
                  )}
                </motion.div>
              ))}

              {/* Approval cards */}
              {pendingActions.map((action) => (
                <motion.div key={action.id} layout>
                  <ApprovalCard action={action} onResolve={resolveAction} />
                </motion.div>
              ))}

              {/* Status pill */}
              <AnimatePresence>
                {statusText && <StatusPill text={statusText} />}
              </AnimatePresence>
            </AnimatePresence>

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-zinc-800/60 p-4">
            <div className="flex gap-3 items-end">
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything..."
                  rows={1}
                  disabled={streaming}
                  style={{ resize: "none" }}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 transition-colors disabled:opacity-50 leading-relaxed"
                />
              </div>
              <button
                onClick={send}
                disabled={streaming || !input.trim()}
                className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 active:scale-[0.97] transition-all disabled:opacity-30"
              >
                {streaming ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  >
                    <ClockCounterClockwise size={16} />
                  </motion.div>
                ) : (
                  <PaperPlaneTilt size={16} weight="fill" />
                )}
              </button>
            </div>
            <div className="flex items-center justify-between mt-2 px-1">
              <span className="text-[10px] text-zinc-700">
                Enter to send · Shift+Enter for newline
              </span>
              {streaming && (
                <span className="text-[10px] text-zinc-600 font-mono">
                  case:{" "}
                  {CONVERSATION_ID.slice(0, 8)}...
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}