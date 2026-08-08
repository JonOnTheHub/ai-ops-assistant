"use client";

import { useState, useRef, useEffect, useCallback, type ElementType, type KeyboardEvent } from "react";
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
  Brain,
  ShieldCheck,
  Wrench,
  ChatCircleDots,
  CaretDown,
  ListMagnifyingGlass,
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
  resolution?: {
    outcome: "approved" | "rejected" | "failed";
    toolName: string;
    detail: string;
  };
}

interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  message: string;
}

interface TraceLogRow {
  id: string;
  trace_id: string;
  step: "plan" | "permission_check" | "tool_call" | "final_response";
  tool_name: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  status: "success" | "error" | "pending_approval";
  latency_ms: number;
  created_at: string;
}

interface TraceTurn {
  trace_id: string;
  userMessage: string;
  steps: TraceLogRow[];
}

interface StepConfigEntry {
  icon: ElementType;
  label: string;
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
      className="flex items-center gap-2 text-xs text-neutral-500 px-1 font-mono uppercase tracking-wider"
    >
      <motion.span
        animate={{ opacity: [1, 0.3, 1] }}
        transition={{ duration: 1.2, repeat: Infinity }}
        className="inline-block w-1.5 h-1.5 bg-yellow-400"
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
  onResolve: (id: string, outcome: "approved" | "rejected" | "failed", detail?: string) => void;
}) {
  const [status, setStatus] = useState<ApprovalStatus>("idle");
  const [pendingStatus, setPendingStatus] = useState<"approved" | "rejected" | "failed" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handle = async (decision: "approve" | "reject") => {
    setStatus(decision === "approve" ? "approving" : "rejecting");
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/actions/${action.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: decision }),
      });

      const data = await res.json();

      if (decision === "reject") {
        setPendingStatus("rejected");
        setStatus("done");
        setTimeout(() => onResolve(action.id, "rejected"), 1200);
        return;
      }


      // decision === "approve" — verify the tool actually succeeded,
      // not just that the HTTP request completed
      const toolSucceeded = res.ok && data.success && data.result?.success;

      if (toolSucceeded) {
        setPendingStatus("approved");
        setStatus("done");
        setTimeout(() => onResolve(action.id, "approved", `Sent to ${args.to ?? "recipient"}`), 2500);
      } else {
        setPendingStatus("failed");
        setErrorMessage(
          data.result?.error || data.error || "Unknown error — check the trace log."
        );
        setStatus("done");
        // no auto-dismiss on failure — the person needs to see this
      }
    } catch {
      setPendingStatus("failed");
      setErrorMessage("Network error — the action may not have been recorded.");
      setStatus("done");
    }
  };

  const args = action.args as { to?: string; subject?: string; body?: string };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className={`rounded-xl border bg-black overflow-hidden ${pendingStatus === "failed" ? "border-red-600/50" : "border-yellow-400/50"
        } ${pendingStatus === null ? "glow-yellow" : ""}`}
    >
      {/* Hazard stripe — the one place in the system where crossing the line costs something */}
      {pendingStatus !== "failed" && <div className="hazard-stripes h-2 w-full" />}
      {pendingStatus === "failed" && <div className="h-2 w-full bg-red-600" />}

      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Lightning size={14} className="text-yellow-400" weight="fill" />
          <span className="text-xs font-bold text-yellow-400 uppercase tracking-widest font-mono">
            Approval Required
          </span>
        </div>

        <div className="space-y-1.5 text-sm font-mono">
          <div className="text-neutral-400">
            <span className="text-neutral-600 uppercase text-[10px] tracking-wider">Tool </span>
            <span className="text-neutral-200">{action.toolName}</span>
          </div>
          {args.to && (
            <div className="text-neutral-400">
              <span className="text-neutral-600 uppercase text-[10px] tracking-wider">To </span>
              <span className="text-neutral-200">{args.to}</span>
            </div>
          )}
          {args.subject && (
            <div className="text-neutral-400">
              <span className="text-neutral-600 uppercase text-[10px] tracking-wider">Subject </span>
              <span className="text-neutral-200">{args.subject}</span>
            </div>
          )}
          {args.body && (
            <div className="text-neutral-400 text-xs bg-neutral-950 p-3 leading-relaxed border border-neutral-800 mt-2">
              {args.body}
            </div>
          )}
        </div>

        {status === "done" ? (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-2"
          >
            <div
              className={`flex items-center gap-2 text-xs font-mono uppercase tracking-wider ${pendingStatus === "approved"
                ? "text-yellow-400"
                : pendingStatus === "failed"
                  ? "text-red-500"
                  : "text-neutral-500"
                }`}
            >
              {pendingStatus === "failed" ? (
                <XCircle size={13} weight="fill" />
              ) : (
                <CheckCircle size={13} weight="fill" />
              )}
              {pendingStatus === "approved"
                ? "Email sent successfully."
                : pendingStatus === "failed"
                  ? "Send failed."
                  : "Action rejected."}
            </div>

            {pendingStatus === "failed" && (
              <>
                {errorMessage && (
                  <div className="text-[10px] text-red-400/80 font-mono bg-red-950/30 border border-red-900 p-2 leading-relaxed">
                    {errorMessage}
                  </div>
                )}
                <button
                  onClick={() => onResolve(action.id, "failed", errorMessage ?? "Action failed.")}
                  className="text-[10px] text-neutral-500 hover:text-neutral-300 font-mono uppercase tracking-wider underline underline-offset-2"
                >
                  Dismiss
                </button>
              </>
            )}
          </motion.div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => handle("approve")}
              disabled={status !== "idle"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-400 border border-yellow-400 text-black text-xs font-bold uppercase tracking-wider hover:bg-yellow-300 active:scale-[0.98] transition-all disabled:opacity-50 font-mono"
            >
              <CheckCircle size={13} weight="fill" />
              {status === "approving" ? "Sending..." : "Approve"}
            </button>
            <button
              onClick={() => handle("reject")}
              disabled={status !== "idle"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black border border-neutral-700/60 text-neutral-400 text-xs font-bold uppercase tracking-wider hover:border-neutral-500 hover:text-neutral-200 active:scale-[0.98] transition-all disabled:opacity-50 font-mono"
            >
              <XCircle size={13} weight="fill" />
              {status === "rejecting" ? "Rejecting..." : "Reject"}
            </button>
          </div>
        )}
      </div>
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
      className="absolute inset-0 bg-black z-10 flex flex-col min-h-0"
    >
      <div className="flex items-center justify-between p-4 border-b-2 border-neutral-800 shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen size={15} className="text-yellow-400" />
          <span className="text-sm font-bold text-neutral-200 uppercase tracking-wider font-mono">
            Upload to Knowledge Base
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-yellow-400 transition-colors font-mono uppercase tracking-wider"
        >
          Close
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs text-neutral-600 font-mono uppercase tracking-wider">Source name</label>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="e.g. pricing-policy.md"
            className="w-full rounded-lg bg-neutral-950 border border-neutral-800/60 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-700 focus:outline-none focus:border-yellow-400/60 transition-colors font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-neutral-600 font-mono uppercase tracking-wider">Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste document content here..."
            rows={10}
            className="w-full bg-neutral-950 border-2 border-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-700 focus:outline-none focus:border-yellow-400 transition-colors resize-none font-mono leading-relaxed"
          />
        </div>

        <button
          onClick={upload}
          disabled={status === "loading" || !content.trim() || !source.trim()}
          className="w-full py-2 rounded-lg bg-yellow-400 border border-yellow-400 text-black text-sm font-bold uppercase tracking-wider hover:bg-yellow-300 active:scale-[0.98] transition-all disabled:opacity-40 font-mono glow-yellow"
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

const STEP_CONFIG: Record<string, StepConfigEntry> = {
  plan: { icon: Brain, label: "Plan" },
  permission_check: { icon: ShieldCheck, label: "Permission" },
  tool_call: { icon: Wrench, label: "Tool Call" },
  final_response: { icon: ChatCircleDots, label: "Response" },
};

const STATUS_COLOR: Record<string, string> = {
  success: "text-yellow-400 border-neutral-800/60",
  error: "text-red-500 border-red-900/60",
  pending_approval: "text-yellow-400 border-yellow-400/50",
};

function StepRow({ step }: { step: TraceLogRow }) {
  const [expanded, setExpanded] = useState(false);
  const config = STEP_CONFIG[step.step] ?? { icon: Wrench, label: step.step };
  const Icon = config.icon;
  const colorClass = STATUS_COLOR[step.status] ?? STATUS_COLOR.success;
  const isPending = step.status === "pending_approval";

  return (
    <div className={`rounded-lg border ${colorClass} bg-neutral-950 overflow-hidden`}>
      {isPending && <div className="hazard-stripes h-1 w-full" />}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={13} weight="fill" />
          <span className="text-xs font-medium truncate font-mono uppercase tracking-wide">
            {config.label}
            {step.tool_name ? (
              <span className="opacity-60 normal-case ml-1">
                · {step.tool_name}
              </span>
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono opacity-60">
            {step.latency_ms}ms
          </span>
          <motion.div animate={{ rotate: expanded ? 180 : 0 }}>
            <CaretDown size={11} />
          </motion.div>
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2">
              {step.input && (
                <div>
                  <div className="text-[10px] opacity-50 mb-1 uppercase tracking-wider font-mono">Input</div>
                  <pre className="text-[10px] font-mono bg-black border border-neutral-900 p-2 overflow-x-auto max-h-32 overflow-y-auto text-neutral-400">
                    {JSON.stringify(step.input, null, 2)}
                  </pre>
                </div>
              )}
              {step.output && (
                <div>
                  <div className="text-[10px] opacity-50 mb-1 uppercase tracking-wider font-mono">Output</div>
                  <pre className="text-[10px] font-mono bg-black border border-neutral-900 p-2 overflow-x-auto max-h-32 overflow-y-auto text-neutral-400">
                    {JSON.stringify(step.output, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TracePanel({
  turns,
  onClear,
}: {
  turns: TraceTurn[];
  onClear: () => void;
}) {
  return (
    <div className="w-[380px] h-full min-h-0 flex flex-col bg-black">
      <div className="flex items-center justify-between p-4 border-b-2 border-neutral-800 shrink-0">
        <div className="flex items-center gap-2">
          <ListMagnifyingGlass size={14} className="text-yellow-400" />
          <span className="text-sm font-bold text-neutral-200 uppercase tracking-wider font-mono">
            Execution Trace
          </span>
        </div>
        {turns.length > 0 && (
          <button
            onClick={onClear}
            className="text-[10px] text-neutral-600 hover:text-yellow-400 transition-colors font-mono uppercase tracking-wider"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {turns.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-2 opacity-60">
            <ListMagnifyingGlass size={20} className="text-neutral-700" />
            <div className="text-xs text-neutral-600 max-w-[220px] leading-relaxed font-mono">
              Send a message and watch every decision the agent makes, live.
            </div>
          </div>
        ) : (
          [...turns].reverse().map((turn, i) => (
            <motion.div
              key={turn.trace_id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-2"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-neutral-300 font-medium truncate max-w-[240px] font-mono">
                  {turn.userMessage}
                </span>
                <span className="text-[9px] font-mono text-neutral-700 shrink-0 uppercase">
                  {turn.trace_id.slice(0, 6)}
                </span>
              </div>
              <div className="space-y-1.5">
                {turn.steps.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
              </div>
              {i < turns.length - 1 && (
                <div className="pt-2 border-t border-neutral-900" />
              )}
            </motion.div>
          ))
        )}
      </div>
    </div>
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
  const [showTrace, setShowTrace] = useState(false);
  const [traceTurns, setTraceTurns] = useState<TraceTurn[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<ChatMessage[]>([]);

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
            role: m.role === "system" ? "assistant" : m.role,
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
            } else if (event.type === "trace_batch") {
              setTraceTurns((prev) => [
                ...prev,
                {
                  trace_id: event.trace_id,
                  userMessage: event.userMessage,
                  steps: event.steps,
                },
              ]);
            } else if (event.type === "done") {
              setStatusText("");
            } else if (event.type === "error") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                      ...m,
                      content: event.message ?? "Something went wrong.",
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

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const resolveAction = (
    id: string,
    outcome: "approved" | "rejected" | "failed",
    detail?: string
  ) => {
    const resolved = pendingActions.find((a) => a.id === id);

    if (resolved) {
      const summaryDetail =
        detail ??
        (outcome === "approved"
          ? "Action completed."
          : outcome === "rejected"
            ? "Rejected."
            : "Action failed.");

      const args = resolved.args as { to?: string; subject?: string };

      // This becomes actual conversation history sent to the model —
      // not just UI decoration. Without this, the model has no way to
      // know what happened after an approval resolved.
      const contentSummary =
        outcome === "approved"
          ? `[System log] ${resolved.toolName} executed successfully.${args.to ? ` Recipient: ${args.to}.` : ""
          }${args.subject ? ` Subject: ${args.subject}.` : ""}`
          : outcome === "rejected"
            ? `[System log] ${resolved.toolName} was rejected by the user and did not execute.`
            : `[System log] ${resolved.toolName} failed to execute. ${summaryDetail}`;

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: contentSummary,
          resolution: {
            outcome,
            toolName: resolved.toolName,
            detail: summaryDetail,
          },
        },
      ]);
    }

    setPendingActions((prev) => prev.filter((a) => a.id !== id));
  };

  const backfillKB = async () => {
    await fetch("/api/knowledge");
  };

  return (
    <div className="h-[100dvh] bg-black text-neutral-200 flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <header className="shrink-0 border-b border-yellow-400/30 px-4 py-3 flex items-center justify-between bg-black/80 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-yellow-400 flex items-center justify-center glow-yellow">
            <Robot size={14} className="text-black" weight="fill" />
          </div>
          <div>
            <div className="text-sm font-bold text-neutral-100 tracking-tight font-mono uppercase">
              Warrant
            </div>
            <div className="text-[10px] text-neutral-600 font-mono uppercase tracking-wider">
              Every action, warranted.
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={backfillKB}
            title="Backfill KB embeddings"
            className="p-1.5 text-neutral-600 hover:text-yellow-400 hover:bg-neutral-900 transition-all active:scale-[0.97]"
          >
            <ArrowClockwise size={14} />
          </button>
          <button
            onClick={() => setShowTrace((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-all active:scale-[0.97] font-mono uppercase tracking-wider font-bold ${showTrace
              ? "bg-yellow-400 border-yellow-400/60 text-black glow-yellow"
              : "bg-black border-neutral-800/60 text-neutral-400 hover:text-yellow-400 hover:border-yellow-400/40"
              }`}
          >
            <ListMagnifyingGlass size={12} />
            Trace
          </button>
          <button
            onClick={() => setShowKB((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black border border-neutral-800/60 text-neutral-400 text-xs hover:text-yellow-400 hover:border-yellow-400/40 transition-all active:scale-[0.97] font-mono uppercase tracking-wider font-bold"
          >
            <BookOpen size={12} />
            Knowledge
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Chat panel */}
        <div className="flex-1 min-h-0 flex flex-col relative">
          <AnimatePresence>
            {showKB && <KnowledgePanel onClose={() => setShowKB(false)} />}
          </AnimatePresence>

          {/* Messages */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6 space-y-6">
            <AnimatePresence initial={false}>
              {messages.length === 0 && (
                <motion.div
                  key="empty-state"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center h-full min-h-[40vh] text-center space-y-3"
                >
                  <div className="w-12 h-12 rounded-2xl bg-yellow-400 flex items-center justify-center glow-yellow">
                    <Robot size={22} className="text-black" weight="fill" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-neutral-200 font-mono uppercase tracking-wider">
                      Ready to assist
                    </div>
                    <div className="text-xs text-neutral-600 max-w-[260px] leading-relaxed font-mono">
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
                        className="text-[11px] px-3 py-1.5 rounded-full bg-black border border-neutral-800/60 text-neutral-500 hover:text-yellow-400 hover:border-yellow-400/50 transition-all font-mono"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {messages.map((msg) =>
                msg.resolution ? (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex justify-center"
                  >
                    <div
                      className={`flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider px-3 py-1.5 border ${msg.resolution.outcome === "approved"
                        ? "border-yellow-400/40 text-yellow-400"
                        : msg.resolution.outcome === "failed"
                          ? "border-red-600/40 text-red-500"
                          : "border-neutral-800 text-neutral-500"
                        }`}
                    >
                      {msg.resolution.outcome === "failed" ? (
                        <XCircle size={12} weight="fill" />
                      ) : (
                        <CheckCircle size={12} weight="fill" />
                      )}
                      {msg.resolution.toolName}: {msg.resolution.detail}
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"
                      }`}
                  >
                    {msg.role !== "user" && (
                      <div className="w-6 h-6 rounded-lg bg-yellow-400 flex items-center justify-center shrink-0 mt-0.5">
                        <Robot size={11} className="text-black" weight="fill" />
                      </div>
                    )}

                    <div
                      className={`max-w-[78%] px-4 py-3 text-sm leading-relaxed rounded-2xl border ${msg.role === "user"
                        ? "bg-neutral-900 text-neutral-100 border-neutral-800/60 rounded-tr-sm"
                        : msg.role === "system"
                          ? "bg-red-950/30 border-red-900/50 text-red-400"
                          : "bg-black border-neutral-800/60 text-neutral-200 rounded-tl-sm"
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
                          className="inline-block w-2 h-4 bg-yellow-400"
                        />
                      ) : null}
                    </div>

                    {msg.role === "user" && (
                      <div className="w-6 h-6 rounded-lg bg-neutral-900 border border-neutral-700/60 flex items-center justify-center shrink-0 mt-0.5">
                        <User size={11} className="text-neutral-400" />
                      </div>
                    )}
                  </motion.div>
                ))}

              {pendingActions.map((action) => (
                <motion.div key={action.id} layout>
                  <ApprovalCard action={action} onResolve={resolveAction} />
                </motion.div>
              ))}

              <AnimatePresence>
                {statusText && <StatusPill text={statusText} />}
              </AnimatePresence>
            </AnimatePresence>

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t-2 border-neutral-800 p-4 shrink-0">
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
                  className="w-full rounded-xl bg-neutral-950 border border-neutral-800/60 px-4 py-3 text-sm text-neutral-200 placeholder-neutral-700 focus:outline-none focus:border-yellow-400/60 transition-colors disabled:opacity-50 leading-relaxed font-mono"
                />
              </div>
              <button
                onClick={send}
                disabled={streaming || !input.trim()}
                className="p-3 rounded-xl bg-yellow-400 border border-yellow-400 text-black hover:bg-yellow-300 active:scale-[0.97] transition-all disabled:opacity-30 disabled:bg-neutral-800 disabled:border-neutral-800 disabled:text-neutral-600 glow-yellow"
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
              <span className="text-[10px] text-neutral-700 font-mono uppercase tracking-wider">
                Enter to send · Shift+Enter for newline
              </span>
              {streaming && (
                <span className="text-[10px] text-neutral-600 font-mono uppercase">
                  case: {CONVERSATION_ID.slice(0, 8)}...
                </span>
              )}
            </div>
          </div>
        </div>

        <AnimatePresence>
          {showTrace && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 380, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 32 }}
              className="border-l-2 border-neutral-800 overflow-hidden shrink-0 min-h-0"
            >
              <TracePanel turns={traceTurns} onClear={() => setTraceTurns([])} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}