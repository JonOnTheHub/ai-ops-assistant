import { APIConnectionError, APIConnectionTimeoutError } from "groq-sdk";
import { getToolTier } from "@/lib/tools";
import { VALIDATOR_ERROR_PREFIX } from "./validator";
import { ToolName, ToolResult } from "@/types";
import { ErrorInfo, FailedItem, SystemCause, ThrownContext } from "@/types/errors";

// Deterministic, no LLM, no I/O. Two entry points:
//   classifyToolResult — a tool RETURNED (success or failure). null = clean success.
//   classifyThrown     — something THREW (planner call, DB, stream, etc).
// Wired into lib/agent/executor.ts, app/api/chat/route.ts and
// app/api/actions/[id]/route.ts.

const TOOL_LABEL: Record<ToolName, string> = {
    searchKnowledgeBase: "the knowledge base search",
    getCustomer: "the customer lookup",
    resolveAudience: "the audience lookup",
    createTask: "creating the task",
    createLead: "creating the lead",
    sendEmail: "sending the email",
    sendBroadcast: "sending the broadcast",
};

const CAUSE_SUMMARY: Record<SystemCause, string> = {
    rate_limit: "I've hit the model's rate limit. Wait a few seconds, then try again.",
    timeout: "The model took too long to respond.",
    connection: "I couldn't reach the model service.",
    server: "The model service had a problem on its end.",
    rejected: "The model service rejected that request.",
    unknown: "Something unexpected went wrong on my side.",
};

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// A tool has side effects if it is anything other than auto-tier (read-only).
// needs-approval tools never execute inside the chat loop, but they are still
// side-effecting for the purpose of "is a retry safe".
function isSideEffectTool(toolName: ToolName): boolean {
    return getToolTier(toolName) !== "auto";
}

function shortReason(raw: string | undefined): string {
    if (!raw) return "no reason reported";
    const cleaned = raw.replace(/^Error:\s*/, "").trim();
    return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

// ── Tool results ──────────────────────────────────────────────

function classifyFailedResult(toolName: ToolName, result: ToolResult): ErrorInfo {
    if (result.error?.startsWith(VALIDATOR_ERROR_PREFIX)) {
        return {
            kind: "tool_failure",
            source: "system",
            retryable: false,
            toolName,
            summary: `${capitalize(TOOL_LABEL[toolName])} returned data in an unexpected shape, so I can't trust the result.`,
        };
    }

    const retryable = !isSideEffectTool(toolName);

    return {
        kind: "tool_failure",
        source: "tool",
        retryable,
        toolName,
        summary: retryable
            ? `${capitalize(TOOL_LABEL[toolName])} failed. Nothing was changed, so it's safe to try again.`
            : `${capitalize(TOOL_LABEL[toolName])} failed. I haven't retried it because it has side effects. Tell me if you want another attempt.`,
    };
}

interface BroadcastLine {
    name: string;
    success: boolean;
    error?: string;
}

function readBroadcastLines(value: unknown): BroadcastLine[] {
    if (!Array.isArray(value)) return [];

    const lines: BroadcastLine[] = [];
    for (const item of value) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        lines.push({
            name: typeof record.name === "string" ? record.name : "unknown recipient",
            success: record.success === true,
            error: typeof record.error === "string" ? record.error : undefined,
        });
    }
    return lines;
}

// sendBroadcast returns success:true even when some (or all) sends failed,
// because the tool itself ran. That is exactly why classification has to look
// at the per-recipient results: 0 sent is a tool failure, not a "success".
function classifyBroadcast(result: ToolResult): ErrorInfo | null {
    const lines = readBroadcastLines(result.data?.results);
    if (lines.length === 0) return null;

    const succeeded = lines.filter((line) => line.success);
    const failed = lines.filter((line) => !line.success);
    if (failed.length === 0) return null;

    if (succeeded.length === 0) {
        return {
            kind: "tool_failure",
            source: "tool",
            retryable: false,
            toolName: "sendBroadcast",
            summary: `All ${lines.length} sends reported errors, so none of the messages are confirmed delivered.`,
        };
    }

    const failedItems: FailedItem[] = failed.map((line) => ({
        name: line.name,
        reason: shortReason(line.error),
    }));

    return {
        kind: "partial_success",
        toolName: "sendBroadcast",
        succeeded: succeeded.map((line) => line.name),
        failed: failedItems,
        summary: `${succeeded.length} of ${lines.length} sent. ${failed.length} failed: ${failed.map((line) => line.name).join(", ")}.`,
    };
}

// An empty audience is not a failure — the lookup worked — but the request
// resolved to nothing usable. That is the "misunderstood" kind.
function classifyAudience(result: ToolResult): ErrorInfo | null {
    if (result.data?.count !== 0) return null;

    const message = result.data?.message;

    return {
        kind: "misunderstood",
        reason: "no_match",
        toolName: "resolveAudience",
        summary: typeof message === "string" ? message : "No recipients matched those filters.",
    };
}

export function classifyToolResult(toolName: ToolName, result: ToolResult): ErrorInfo | null {
    if (!result.success) return classifyFailedResult(toolName, result);
    if (toolName === "sendBroadcast") return classifyBroadcast(result);
    if (toolName === "resolveAudience") return classifyAudience(result);
    return null;
}

// ── Thrown errors ─────────────────────────────────────────────

function statusOf(err: unknown): number | undefined {
    if (typeof err !== "object" || err === null) return undefined;
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
}

// Deliberately does NOT treat a 400 as "the user's request was misunderstood".
// A 400 from the model provider can just as easily be our own schema being
// rejected (that already happened once with null-valued optional params),
// which is a system bug, not the user's fault. Only what the error object
// actually proves gets a specific cause; everything else stays "unknown".
function causeOf(err: unknown): SystemCause {
    if (err instanceof APIConnectionTimeoutError) return "timeout";
    if (err instanceof APIConnectionError) return "connection";

    const status = statusOf(err);
    if (status === 429) return "rate_limit";
    if (status !== undefined && status >= 500) return "server";
    if (status !== undefined && status >= 400) return "rejected";

    return "unknown";
}

export function classifyThrown(err: unknown, ctx: ThrownContext): ErrorInfo {
    const cause = causeOf(err);
    const sideEffects = ctx.completedTools.filter(isSideEffectTool);
    const retryable = sideEffects.length === 0;

    let summary = CAUSE_SUMMARY[cause];

    if (!retryable) {
        const done = sideEffects.map((name) => TOOL_LABEL[name]).join(", ");
        summary += ` Earlier in this turn, ${done} already went through, so I haven't offered a retry. It could duplicate that.`;
    }

    return {
        kind: "tool_failure",
        source: "system",
        cause,
        retryable,
        summary,
    };
}