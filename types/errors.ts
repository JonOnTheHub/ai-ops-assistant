import { ToolName } from "@/types";

// Routed errors: every failure Warrant reports gets exactly one of these
// three kinds, computed server-side. The frontend never sees a raw error
// blob, only a kind + a plain-language summary + the recovery data that
// kind needs (same principle as confidence: server decides, UI renders).

export type ErrorKind = "misunderstood" | "tool_failure" | "partial_success";

// "tool" = a tool ran and reported failure. "system" = the machinery around
// the tools failed (planner/LLM call, database, stream, unexpected shape).
export type ErrorSource = "tool" | "system";

export type MisunderstoodReason = "no_match" | "invalid_input";

// Only set for system failures we can actually distinguish from the error
// object itself. "unknown" is an honest answer, not a fallback to hide behind.
export type SystemCause = "rate_limit" | "timeout" | "connection" | "server" | "rejected" | "unknown";

export interface FailedItem {
    name: string;
    reason: string;
}

// Nothing broke. The request resolved to nothing usable (no match, bad input).
// Recovery = text only: say what was understood and what can be done instead.
export interface MisunderstoodInfo {
    kind: "misunderstood";
    summary: string;
    reason: MisunderstoodReason;
    toolName?: ToolName;
}

// Something ran and failed, or the machinery around it did.
// `retryable` is true ONLY when re-running cannot duplicate a side effect:
// the tool is auto-tier (read-only), and for system failures, no
// log-and-run tool already executed earlier in the same turn.
export interface ToolFailureInfo {
    kind: "tool_failure";
    summary: string;
    source: ErrorSource;
    cause?: SystemCause;
    retryable: boolean;
    toolName?: ToolName;
}

// Some of it worked. Carries the real succeeded / failed sets so the UI can
// show both and offer to act on the failed subset only (via a fresh approval).
export interface PartialSuccessInfo {
    kind: "partial_success";
    summary: string;
    toolName: ToolName;
    succeeded: string[];
    failed: FailedItem[];
}

export type ErrorInfo = MisunderstoodInfo | ToolFailureInfo | PartialSuccessInfo;

// What the caller knows about the turn when something THROWS (as opposed to
// a tool returning a failed ToolResult). completedTools = tools that already
// finished earlier in this turn, so we never offer a retry that could
// duplicate a side effect.
export interface ThrownContext {
    completedTools: ToolName[];
}