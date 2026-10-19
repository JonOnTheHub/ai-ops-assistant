import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { writeTrace } from "@/lib/tracing";
import { BroadcastRecipient } from "@/types";

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST /api/actions/[id]/retry
//
// [id] is a sendBroadcast action that was already APPROVED and ran, with some
// or all sends failing. This creates a FRESH needs-approval action for only
// the recipients whose send failed. Nothing is sent here: the new action goes
// through the same human approval gate as any other broadcast.
//
// The client sends no recipient data at all. Which sends failed comes from the
// per-recipient results the approve route recorded in trace_logs, and each
// failure is mapped back to the ORIGINAL action's recipients by email. So the
// retry list can only ever be a subset of who the person already approved.

interface RecordedResult {
    email: string;
    success: boolean;
}

function readRecordedResults(output: unknown): RecordedResult[] | null {
    if (typeof output !== "object" || output === null) return null;
    const data = (output as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) return null;
    const results = (data as { results?: unknown }).results;
    if (!Array.isArray(results)) return null;

    const out: RecordedResult[] = [];
    for (const item of results) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.email !== "string") continue;
        out.push({ email: record.email, success: record.success === true });
    }
    return out;
}

function readRecipients(value: unknown): BroadcastRecipient[] | null {
    if (!Array.isArray(value)) return null;

    const out: BroadcastRecipient[] = [];
    for (const item of value) {
        if (typeof item !== "object" || item === null) return null;
        const record = item as Record<string, unknown>;
        if (typeof record.name !== "string" || typeof record.email !== "string") return null;
        out.push(item as BroadcastRecipient);
    }
    return out;
}

export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // Only an action that was approved (so it actually ran) can be retried.
    const { data: original, error: fetchError } = await supabase
        .from("pending_actions")
        .select("*")
        .eq("id", id)
        .eq("status", "approved")
        .single();

    if (fetchError || !original) {
        return NextResponse.json(
            { error: "No approved action found to retry." },
            { status: 404 }
        );
    }

    if (original.tool_name !== "sendBroadcast") {
        return NextResponse.json(
            { error: "Only broadcast sends can be retried this way." },
            { status: 400 }
        );
    }

    const originalArgs = (original.proposed_args ?? {}) as Record<string, unknown>;
    const originalRecipients = readRecipients(originalArgs.recipients);
    const subject = originalArgs.subject;
    const body = originalArgs.body;

    if (!originalRecipients || typeof subject !== "string" || typeof body !== "string") {
        return NextResponse.json(
            { error: "The original message or recipient list couldn't be read, so I haven't set up a retry." },
            { status: 422 }
        );
    }

    // The newest tool_call row for this trace that carries per-recipient
    // results is the approve run. (An earlier row, written when the action
    // was proposed, has no output.)
    const { data: rows, error: traceError } = await supabase
        .from("trace_logs")
        .select("output")
        .eq("trace_id", original.trace_id)
        .eq("step", "tool_call")
        .eq("tool_name", "sendBroadcast")
        .order("created_at", { ascending: false });

    if (traceError) {
        return NextResponse.json(
            { error: "I couldn't read the send record, so I haven't set up a retry." },
            { status: 500 }
        );
    }

    let recorded: RecordedResult[] | null = null;
    for (const row of rows ?? []) {
        const candidate = readRecordedResults((row as { output: unknown }).output);
        if (candidate && candidate.length > 0) {
            recorded = candidate;
            break;
        }
    }

    // No per-recipient record means we can't say who was or wasn't reached.
    // Say so plainly instead of guessing, because a guess could re-send to
    // someone who already got the message.
    if (!recorded) {
        return NextResponse.json(
            { error: "I couldn't find a record of which sends failed, so I haven't set up a retry. Check your inbox before resending anything." },
            { status: 409 }
        );
    }

    const failedEmails = new Set(
        recorded.filter((entry) => !entry.success).map((entry) => entry.email.toLowerCase())
    );

    if (failedEmails.size === 0) {
        return NextResponse.json(
            { error: "Nothing failed on that send, so there is nothing to retry." },
            { status: 409 }
        );
    }

    // Subset of the ORIGINAL recipients only, matched by email, no duplicates.
    const seen = new Set<string>();
    const retryRecipients: BroadcastRecipient[] = [];
    for (const recipient of originalRecipients) {
        const key = recipient.email.toLowerCase();
        if (failedEmails.has(key) && !seen.has(key)) {
            seen.add(key);
            retryRecipients.push(recipient);
        }
    }

    if (retryRecipients.length === 0) {
        return NextResponse.json(
            { error: "The failed sends couldn't be matched to the original recipients, so I haven't set up a retry." },
            { status: 409 }
        );
    }

    const retryTraceId = crypto.randomUUID();
    const retryArgs = { recipients: retryRecipients, subject, body };

    const { data: pending, error: insertError } = await supabase
        .from("pending_actions")
        .insert({
            trace_id: retryTraceId,
            tool_name: "sendBroadcast",
            proposed_args: retryArgs,
            status: "pending",
        })
        .select()
        .single();

    if (insertError || !pending) {
        console.error("[retry] failed to create pending action:", insertError);
        return NextResponse.json(
            { error: "I couldn't create the retry approval, so nothing was set up." },
            { status: 500 }
        );
    }

    // Same two trace rows the chat loop writes for any needs-approval tool,
    // plus a pointer back to the action this retries.
    await writeTrace({
        trace_id: retryTraceId,
        step: "permission_check",
        tool_name: "sendBroadcast",
        input: { args: retryArgs, tier: "needs-approval", retryOf: id },
        status: "success",
        latency_ms: 0,
    });
    await writeTrace({
        trace_id: retryTraceId,
        step: "tool_call",
        tool_name: "sendBroadcast",
        input: retryArgs,
        status: "pending_approval",
        latency_ms: 0,
    });

    return NextResponse.json({
        success: true,
        pendingActionId: pending.id,
        toolName: "sendBroadcast",
        args: retryArgs,
        message: "This action requires your approval before it runs.",
        retryCount: retryRecipients.length,
    });
}