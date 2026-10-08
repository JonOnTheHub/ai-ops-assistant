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
  Info,
  Warning,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import type { ErrorInfo, ErrorKind } from "@/types/errors";

// ─── Types ────────────────────────────────────────────────────────────────────

type MessageRole = "user" | "assistant" | "system";

interface PlanStep {
  stepIndex: number;
  toolName: string;
  status: "running" | "completed" | "failed" | "pending_approval";
}

interface KbResult {
  id: string;
  content: string;
  source: string;
  similarity: number;
  confidence: "confident" | "weak";
}

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolUsed?: string;
  traceId?: string;
  planSteps?: PlanStep[];
  kbResults?: KbResult[];
  // Mid-turn routed errors (tool_error events): rendered as one-line strips
  // above the reply. The model still explains in its own words.
  notices?: ErrorInfo[];
  // Set when this message IS a routed error (final error event, or an
  // approval that partly/fully failed). `content` still holds the plain
  // summary string, because that string is also the conversation history.
  errorInfo?: ErrorInfo;
}

interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  message: string;
  planSteps?: PlanStep[];
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

type ResolveOutcome = "approved" | "rejected" | "failed" | "partial";

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

// Reactive plan preview — a step only ever appears here the moment the
// planner actually decides it, never a fabricated full sequence shown up
// front. Most turns are single-step and this barely shows itself at all,
// which is correct: it should only earn visibility on genuinely multi-step
// turns (e.g. resolveAudience -> sendBroadcast), not decorate every reply.
function PlanPreview({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 mb-2 text-xs font-mono">
      {steps.map((step) => (
        <motion.div
          key={step.stepIndex}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex items-center gap-2"
        >
          {step.status === "running" && (
            <motion.span
              animate={{ opacity: [1, 0.3] }}
              transition={{ duration: 0.8, repeat: Infinity }}
              className="w-3 h-3 rounded-full border border-yellow-400 shrink-0"
            />
          )}
          {step.status === "completed" && (
            <CheckCircle size={13} className="text-yellow-400 shrink-0" weight="fill" />
          )}
          {step.status === "failed" && (
            <XCircle size={13} className="text-red-500 shrink-0" weight="fill" />
          )}
          {step.status === "pending_approval" && (
            <Lightning size={13} className="text-yellow-400 shrink-0" weight="fill" />
          )}
          <span
            className={
              step.status === "failed"
                ? "text-red-500"
                : step.status === "pending_approval"
                  ? "text-yellow-400"
                  : "text-neutral-500"
            }
          >
            {step.toolName}
            {step.status === "pending_approval" ? " — awaiting approval" : ""}
            {step.status === "failed" ? " — failed" : ""}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Context Cards — three pieces:
//   ContextCard        existing stacked, expand-in-place card (unchanged)
//   ContextCardBox     new compact box: filename + confidence dot only
//   ContextCardModal   new from-scratch overlay showing full content
//   ContextCards       container — branches by result count:
//                        <= 2 results: stacked ContextCard list (as before)
//                        >= 3 results: horizontal scrollable strip of
//                          ContextCardBox, click opens ContextCardModal
// ─────────────────────────────────────────────────────────────────────

function ContextCard({ result }: { result: KbResult }) {
  const [expanded, setExpanded] = useState(false);
  const preview =
    result.content.length > 120
      ? result.content.slice(0, 120).trimEnd() + "…"
      : result.content;

  return (
    <div className="rounded-lg border border-neutral-800/60 bg-neutral-950 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${result.confidence === "confident"
              ? "bg-yellow-400"
              : "border border-yellow-400/50"
              }`}
            title={result.confidence === "confident" ? "Confident match" : "Weak match"}
          />
          <BookOpen size={12} className="text-neutral-500 shrink-0" />
          <span className="text-xs font-mono text-neutral-400 truncate">
            {result.source}
          </span>
        </div>
        <motion.div animate={{ rotate: expanded ? 180 : 0 }} className="shrink-0">
          <CaretDown size={11} className="text-neutral-600" />
        </motion.div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 text-xs text-neutral-400 leading-relaxed">
              {result.content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!expanded && (
        <div className="px-3 pb-2 -mt-1 text-[11px] text-neutral-600 truncate">
          {preview}
        </div>
      )}
    </div>
  );
}

// Compact box for the crowded case — filename + confidence dot only, no
// text preview. Trades the current design's glanceability for actually
// fitting several results without dominating the reply vertically; the
// full content is one click away in the modal, not gone.
function ContextCardBox({
  result,
  onOpen,
}: {
  result: KbResult;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-2 shrink-0 px-3 py-2 rounded-lg border border-neutral-800/60 bg-neutral-950 hover:border-yellow-400/40 transition-colors max-w-[160px]"
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${result.confidence === "confident"
          ? "bg-yellow-400"
          : "border border-yellow-400/50"
          }`}
        title={result.confidence === "confident" ? "Confident match" : "Weak match"}
      />
      <BookOpen size={12} className="text-neutral-500 shrink-0" />
      <span className="text-xs font-mono text-neutral-400 truncate">
        {result.source}
      </span>
    </button>
  );
}

// From-scratch overlay — no prior modal pattern existed in this codebase
// to reuse. Deliberately NOT using the hazard-stripe motif: that's
// reserved exclusively for approval/pending-approval states, and this is
// neither.
function ContextCardModal({
  result,
  onClose,
}: {
  result: KbResult;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[80vh] rounded-xl border border-neutral-800 bg-black overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-neutral-800 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${result.confidence === "confident"
                ? "bg-yellow-400"
                : "border border-yellow-400/50"
                }`}
            />
            <BookOpen size={13} className="text-neutral-500 shrink-0" />
            <span className="text-xs font-mono text-neutral-300 truncate">
              {result.source}
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-600 shrink-0">
              {result.confidence === "confident" ? "Confident" : "Weak"}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200 transition-colors shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-3 overflow-y-auto text-sm text-neutral-300 leading-relaxed">
          {result.content}
        </div>
      </motion.div>
    </motion.div>
  );
}

function ContextCards({ results }: { results: KbResult[] }) {
  const [openResult, setOpenResult] = useState<KbResult | null>(null);

  if (results.length === 0) return null;

  // Only switches to the compact box+modal treatment once there are
  // enough results to actually crowd the reply — 1-2 results read fine
  // stacked, same as before.
  if (results.length <= 2) {
    return (
      <div className="flex flex-col gap-1.5 mt-2">
        {results.map((r) => (
          <ContextCard key={r.id} result={r} />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-1.5 mt-2 overflow-x-auto pb-1">
        {results.map((r) => (
          <ContextCardBox key={r.id} result={r} onOpen={() => setOpenResult(r)} />
        ))}
      </div>

      <AnimatePresence>
        {openResult && (
          <ContextCardModal
            result={openResult}
            onClose={() => setOpenResult(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Routed errors ────────────────────────────────────────────────────────────
// Every failure the server reports arrives as one of three kinds. Tone is
// deliberately different per kind: "nothing matched" is not an alarm, a real
// failure is red, and a partial result is yellow-outlined. No hazard stripe
// here, that stays reserved for approval states.

interface ErrorTone {
  Icon: ElementType;
  text: string;
  box: string;
}

const ERROR_TONE: Record<ErrorKind, ErrorTone> = {
  misunderstood: {
    Icon: Info,
    text: "text-neutral-400",
    box: "bg-neutral-950 border-neutral-700/60",
  },
  tool_failure: {
    Icon: WarningCircle,
    text: "text-red-400",
    box: "bg-red-950/30 border-red-900/50",
  },
  partial_success: {
    Icon: Warning,
    text: "text-yellow-400",
    box: "bg-black border-yellow-400/40",
  },
};

function noticeLabel(info: ErrorInfo): string {
  if (info.kind === "misunderstood") return "Couldn't resolve that";
  if (info.kind === "partial_success") return "Partly done";
  return info.source === "system" ? "System issue" : "Tool failed";
}

// SSE and fetch payloads are untyped JSON. Check the shape before rendering
// so a malformed payload can never crash the chat.
function isErrorInfo(value: unknown): value is ErrorInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== "string") return false;
  if (v.kind === "misunderstood" || v.kind === "tool_failure") return true;
  return v.kind === "partial_success" && Array.isArray(v.succeeded) && Array.isArray(v.failed);
}

function ErrorNotice({ info, compact = false }: { info: ErrorInfo; compact?: boolean }) {
  const tone = ERROR_TONE[info.kind];
  const Icon = tone.Icon;
  const label = noticeLabel(info);

  if (compact) {
    return (
      <div className={`flex items-start gap-2 text-[11px] font-mono mb-2 ${tone.text}`}>
        <Icon size={12} weight="fill" className="mt-0.5 shrink-0" />
        <span>
          <span className="uppercase tracking-wider">{label}</span>
          <span className="text-neutral-500"> — {info.summary}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className={`flex items-center gap-2 text-xs font-mono uppercase tracking-wider ${tone.text}`}>
        <Icon size={13} weight="fill" />
        {label}
      </div>
      <div className="text-sm text-neutral-300 leading-relaxed">{info.summary}</div>
      {info.kind === "partial_success" && (
        <div className="space-y-1.5 text-xs font-mono">
          <div className="text-neutral-400">
            <span className="text-neutral-600 uppercase text-[10px] tracking-wider">
              Sent ({info.succeeded.length}){" "}
            </span>
            <span className="text-neutral-200">{info.succeeded.join(", ")}</span>
          </div>
          <div className="text-neutral-400">
            <span className="text-yellow-400/80 uppercase text-[10px] tracking-wider">
              Failed ({info.failed.length})
            </span>
            {info.failed.map((item) => (
              <div key={item.name} className="pl-3 text-neutral-300">
                {item.name}
                <span className="text-neutral-600"> — {item.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  action,
  onResolve,
}: {
  action: PendingAction;
  onResolve: (id: string, outcome: ResolveOutcome, detail?: string, errorInfo?: ErrorInfo) => void;
}) {
  const [status, setStatus] = useState<ApprovalStatus>("idle");
  const [pendingStatus, setPendingStatus] = useState<ResolveOutcome | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [failureInfo, setFailureInfo] = useState<ErrorInfo | null>(null);

  const handle = async (decision: "approve" | "reject") => {
    setStatus(decision === "approve" ? "approving" : "rejecting");
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/actions/${action.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: decision }),
      });

      const isJson = (res.headers.get("content-type") ?? "").includes("application/json");

      // A JSON 404 comes from OUR handler: the action is no longer "pending",
      // i.e. it was already resolved. Telling someone "network error, may not
      // have been recorded" there would invite a retry that isn't needed.
      if (res.status === 404 && isJson) {
        setPendingStatus("failed");
        setErrorMessage("This action was already resolved — no need to retry.");
        setStatus("done");
        return;
      }

      // A non-JSON 404 is the framework's own not-found page. The request
      // never reached our handler, so nothing ran and the action is still
      // pending. Keep the buttons live instead of declaring it resolved.
      if (res.status === 404) {
        setErrorMessage(
          "The approval endpoint wasn't found (HTTP 404), so nothing was sent and the action is still pending. Try Approve again. If it keeps happening, the server needs a restart or redeploy."
        );
        setStatus("idle");
        return;
      }

      const data = await res.json();

      if (decision === "reject") {
        if (!res.ok) {
          setPendingStatus("failed");
          setErrorMessage(data.error ?? "Couldn't record the rejection.");
          setStatus("done");
          return;
        }
        setPendingStatus("rejected");
        setStatus("done");
        setTimeout(() => onResolve(action.id, "rejected"), 1200);
        return;
      }

      // decision === "approve". The route attaches a routed errorInfo, or null
      // for a clean success. Check it instead of trusting the tool's own
      // success flag: sendBroadcast reports success:true even when some or
      // all sends failed.
      const info: ErrorInfo | null = isErrorInfo(data.errorInfo) ? data.errorInfo : null;
      const toolRan = res.ok && data.success && data.result?.success;
      const summary: string = data.result?.data?.message ?? "Action completed.";

      if (toolRan && !info) {
        setResultMessage(summary);
        setPendingStatus("approved");
        setStatus("done");
        setTimeout(() => onResolve(action.id, "approved", summary), 2500);
      } else if (toolRan && info?.kind === "partial_success") {
        // The tool really ran and some sends went through. Resolve into a chat
        // message that carries the succeeded and failed sets, instead of
        // vanishing behind a success check.
        setResultMessage(info.summary);
        setPendingStatus("partial");
        setStatus("done");
        setTimeout(() => onResolve(action.id, "partial", summary, info), 1500);
      } else {
        // A hard failure, or the tool "succeeded" while delivering nothing
        // (every send failed). Show the routed summary and keep the card up.
        setFailureInfo(info);
        setPendingStatus("failed");
        setErrorMessage(
          info?.summary ?? data.result?.error ?? data.error ?? "Unknown error — check the trace log."
        );
        setStatus("done");
        // no auto-dismiss on failure — the person needs to see this
      }
    } catch {
      // A true fetch-level failure (DNS, connection refused) or a response
      // that couldn't be parsed at all — genuinely unclear whether the
      // server ever received this, unlike the 404 case above which we
      // know for certain already resolved.
      setPendingStatus("failed");
      setErrorMessage(
        "Couldn't reach the server — the action may not have been recorded. Check your connection and try again."
      );
      setStatus("done");
    }
  };

  const args = action.args as {
    to?: string;
    subject?: string;
    body?: string;
    recipients?: { name: string; email: string }[];
  };

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
        {action.planSteps && action.planSteps.length > 0 && (
          <PlanPreview steps={action.planSteps} />
        )}

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
          {args.recipients && args.recipients.length > 0 && (
            <div className="text-neutral-400">
              <span className="text-neutral-600 uppercase text-[10px] tracking-wider">
                To ({args.recipients.length}){" "}
              </span>
              <span className="text-neutral-200">
                {args.recipients.map((r) => r.name).join(", ")}
              </span>
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

        {status !== "done" && errorMessage && (
          <div className="text-[10px] text-red-400/80 font-mono bg-red-950/30 border border-red-900 p-2 leading-relaxed">
            {errorMessage}
          </div>
        )}

        {status === "done" ? (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-2"
          >
            <div
              className={`flex items-center gap-2 text-xs font-mono uppercase tracking-wider ${pendingStatus === "approved" || pendingStatus === "partial"
                ? "text-yellow-400"
                : pendingStatus === "failed"
                  ? "text-red-500"
                  : "text-neutral-500"
                }`}
            >
              {pendingStatus === "failed" ? (
                <XCircle size={13} weight="fill" />
              ) : pendingStatus === "partial" ? (
                <Warning size={13} weight="fill" />
              ) : (
                <CheckCircle size={13} weight="fill" />
              )}
              {pendingStatus === "approved"
                ? resultMessage ?? "Action completed."
                : pendingStatus === "partial"
                  ? resultMessage ?? "Partly sent."
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
                  onClick={() => onResolve(action.id, "failed", errorMessage ?? "Action failed.", failureInfo ?? undefined)}
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
    // Defense in depth — the composer is already disabled while an action
    // is pending, but guard the function itself too in case of a race
    // (e.g. Enter fired a beat before the disabled state re-rendered).
    if (!text || streaming || pendingActions.length > 0) return;

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

    // Scoped to this single turn — updated synchronously as plan_step events
    // arrive over the stream, since we're reading it in one sequential loop.
    // Read from here (not React state) when a halt needs to carry the plan
    // preview over to the pending-approval card before the assistant
    // message placeholder gets removed.
    let currentPlanSteps: PlanStep[] = [];

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
            } else if (event.type === "plan_step") {
              const idx = currentPlanSteps.findIndex(
                (s) => s.stepIndex === event.stepIndex
              );
              const updated: PlanStep = {
                stepIndex: event.stepIndex,
                toolName: event.toolName,
                status: event.status,
              };
              currentPlanSteps =
                idx === -1
                  ? [...currentPlanSteps, updated]
                  : currentPlanSteps.map((s, i) => (i === idx ? updated : s));

              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, planSteps: currentPlanSteps } : m
                )
              );
            } else if (event.type === "kb_context") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, kbResults: event.results } : m
                )
              );
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
                  planSteps: currentPlanSteps,
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
            } else if (event.type === "tool_error") {
              // A tool step returned something the classifier flagged. Never
              // halts the turn; shown as a strip above the model's reply.
              if (isErrorInfo(event.errorInfo)) {
                const notice: ErrorInfo = event.errorInfo;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, notices: [...(m.notices ?? []), notice] }
                      : m
                  )
                );
              }
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
                      errorInfo: isErrorInfo(event.errorInfo) ? event.errorInfo : undefined,
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
    outcome: ResolveOutcome,
    detail?: string,
    errorInfo?: ErrorInfo
  ) => {
    const resolved = pendingActions.find((a) => a.id === id);

    if (resolved) {
      // `detail` is the tool's own returned summary (e.g. "Email sent to
      // x@y.com." or "9/12 sent — 3 failed.") for approved/failed outcomes.
      // This becomes both what's shown to Jon AND real conversation history
      // sent back to the model on the next turn — one string, one source of
      // truth, no separate "system log" phrasing to keep in sync.
      const content =
        outcome === "approved"
          ? `Done — ${detail ?? `${resolved.toolName} completed.`}`
          : outcome === "partial"
            ? `Partly done — ${detail ?? `${resolved.toolName} partly completed.`}`
            : outcome === "rejected"
              ? `Okay, I didn't send that — you rejected it.`
              : `That didn't go through: ${detail ?? "the action failed."}`;

      // `content` stays the plain string (display fallback AND model history).
      // errorInfo rides alongside it so the bubble can render structured recovery.
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          ...(errorInfo ? { errorInfo } : {}),
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
                    <div className="w-6 h-6 rounded-lg bg-yellow-400 flex items-center justify-center shrink-0 mt-0.5">
                      <Robot size={11} className="text-black" weight="fill" />
                    </div>
                  )}

                  <div
                    className={`max-w-[78%] px-4 py-3 text-sm leading-relaxed rounded-2xl border ${msg.role === "user"
                      ? "bg-neutral-900 text-neutral-100 border-neutral-800/60 rounded-tr-sm"
                      : msg.errorInfo
                        ? `${ERROR_TONE[msg.errorInfo.kind].box} text-neutral-200 rounded-tl-sm`
                        : msg.role === "system"
                          ? "bg-red-950/30 border-red-900/50 text-red-400"
                          : "bg-black border-neutral-800/60 text-neutral-200 rounded-tl-sm"
                      }`}
                  >
                    {msg.role !== "user" && msg.planSteps && msg.planSteps.length > 0 && (
                      <PlanPreview steps={msg.planSteps} />
                    )}
                    {msg.role !== "user" &&
                      msg.notices &&
                      msg.notices.map((notice, i) => (
                        <ErrorNotice key={i} info={notice} compact />
                      ))}
                    {msg.errorInfo ? (
                      <ErrorNotice info={msg.errorInfo} />
                    ) : msg.content ? (
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
                    {msg.role !== "user" && msg.kbResults && msg.kbResults.length > 0 && (
                      <ContextCards results={msg.kbResults} />
                    )}
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
            {pendingActions.length > 0 && (
              <div className="flex items-center gap-2 mb-2 text-[11px] font-mono uppercase tracking-wider text-yellow-400">
                <Lightning size={12} weight="fill" />
                Resolve the pending action above before continuing
              </div>
            )}
            <div className="flex gap-3 items-end">
              <div className="flex-1 relative">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    pendingActions.length > 0
                      ? "Approve or reject the pending action first..."
                      : "Ask anything..."
                  }
                  rows={1}
                  disabled={streaming || pendingActions.length > 0}
                  style={{ resize: "none" }}
                  className="w-full rounded-xl bg-neutral-950 border border-neutral-800/60 px-4 py-3 text-sm text-neutral-200 placeholder-neutral-700 focus:outline-none focus:border-yellow-400/60 transition-colors disabled:opacity-50 leading-relaxed font-mono"
                />
              </div>
              <button
                onClick={send}
                disabled={streaming || !input.trim() || pendingActions.length > 0}
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