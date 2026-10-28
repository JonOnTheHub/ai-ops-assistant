import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/tools/sendEmail";
import { sendBroadcast } from "@/lib/tools/sendBroadcast";
import { writeTrace } from "@/lib/tracing";
import { classifyToolResult, classifyThrown } from "@/lib/agent/classifier";
import { validateDraftEdit } from "@/lib/agent/draftEdit";
import { ToolName, ToolResult, BroadcastRecipient } from "@/types";

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Tool execution map for approved actions
// Only needs-approval tools live here
type ApprovalFn = (args: Record<string, unknown>) => Promise<ToolResult>;

const APPROVAL_EXECUTORS: Partial<Record<ToolName, ApprovalFn>> = {
    sendEmail: (args) =>
        sendEmail(args as { to: string; subject: string; body: string }),
    sendBroadcast: (args) =>
        sendBroadcast(args as { recipients: BroadcastRecipient[]; subject: string; body: string }),
};

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const { action }: { action: "approve" | "reject" } = await req.json();

    if (!["approve", "reject"].includes(action)) {
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    // Fetch the pending action
    const { data: pending, error: fetchError } = await supabase
        .from("pending_actions")
        .select("*")
        .eq("id", id)
        .eq("status", "pending")
        .single();

    if (fetchError || !pending) {
        return NextResponse.json(
            { error: "Pending action not found or already resolved" },
            { status: 404 }
        );
    }

    if (action === "reject") {
        await supabase
            .from("pending_actions")
            .update({ status: "rejected", resolved_at: new Date().toISOString() })
            .eq("id", id);

        await writeTrace({
            trace_id: pending.trace_id,
            step: "tool_call",
            tool_name: pending.tool_name as ToolName,
            input: pending.proposed_args,
            output: { rejected: true },
            status: "error",
            latency_ms: 0,
        });

        return NextResponse.json({ success: true, status: "rejected" });
    }

    // Approve — execute the tool now
    const executor = APPROVAL_EXECUTORS[pending.tool_name as ToolName];

    if (!executor) {
        return NextResponse.json(
            { error: `No executor found for tool: ${pending.tool_name}` },
            { status: 500 }
        );
    }

    const start = Date.now();

    try {
        const result = await executor(pending.proposed_args);
        const latency_ms = Date.now() - start;

        // This is the only place sendBroadcast (and sendEmail) actually run —
        // the chat-loop executor never gets past the pending-approval branch
        // for a needs-approval tool. So this is where partial_success first
        // becomes visible: the tool really did execute, and some sends may
        // have failed. classifyToolResult reads the real per-recipient
        // results[] sendBroadcast already returns — no tool change needed.
        const errorInfo = classifyToolResult(pending.tool_name as ToolName, result);

        await supabase
            .from("pending_actions")
            .update({ status: "approved", resolved_at: new Date().toISOString() })
            .eq("id", id);

        await writeTrace({
            trace_id: pending.trace_id,
            step: "tool_call",
            tool_name: pending.tool_name as ToolName,
            input: pending.proposed_args,
            output: {
                ...(result as unknown as Record<string, unknown>),
                ...(errorInfo ? { errorInfo } : {}),
            },
            // Same rule as executor.ts: success:true with a routed error
            // attached (partial_success) is not a clean success in the trace.
            status: result.success && !errorInfo ? "success" : "error",
            latency_ms,
        });

        return NextResponse.json({ success: true, status: "approved", result, errorInfo });
    } catch (err) {
        // Both sendEmail and sendBroadcast catch their own errors and return
        // {success:false} rather than throwing — so reaching this block means
        // something outside the tool itself broke (Resend SDK throwing
        // synchronously, a genuine bug). Nothing from this tool executed
        // (the tool never got to return), so a retry is safe.
        const errorInfo = classifyThrown(err, { completedTools: [] });

        await writeTrace({
            trace_id: pending.trace_id,
            step: "tool_call",
            tool_name: pending.tool_name as ToolName,
            input: pending.proposed_args,
            output: { error: String(err), errorInfo },
            status: "error",
            latency_ms: Date.now() - start,
        });

        return NextResponse.json(
            { error: `Execution failed: ${String(err)}`, errorInfo },
            { status: 500 }
        );
    }
}

// PATCH /api/actions/[id]
//
// Edit the subject and/or body of a draft that is still waiting for approval.
// The approve route executes the STORED action, so an edit has to be saved
// here, before approval, or what the person approved wouldn't be what is sent.
// Only a pending email or broadcast can be edited, only subject and body can
// change (draftEdit.ts rejects everything else, recipients included), and every
// change is recorded in the trace with the text before and after, so what the
// model proposed versus what a person sent is always recoverable.
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    let payload: unknown;
    try {
        payload = await req.json();
    } catch {
        return NextResponse.json({ error: "The request body must be valid JSON." }, { status: 400 });
    }

    const { data: pending, error: fetchError } = await supabase
        .from("pending_actions")
        .select("*")
        .eq("id", id)
        .eq("status", "pending")
        .single();

    if (fetchError || !pending) {
        return NextResponse.json(
            { error: "Pending action not found or already resolved" },
            { status: 404 }
        );
    }

    const stored = (pending.proposed_args ?? {}) as Record<string, unknown>;
    const edit = validateDraftEdit(pending.tool_name, stored, payload);

    if (!edit.ok) {
        return NextResponse.json({ error: edit.error }, { status: 400 });
    }

    if (edit.changed.length === 0) {
        return NextResponse.json({ success: true, unchanged: true, subject: edit.subject, body: edit.body });
    }

    // Everything else in the stored action (recipients, `to`) is carried over as is.
    const nextArgs = { ...stored, subject: edit.subject, body: edit.body };

    // Guarded on status again: if the action was approved or rejected between the
    // read above and this write, nothing is saved and the person is told so.
    const { data: updated, error: updateError } = await supabase
        .from("pending_actions")
        .update({ proposed_args: nextArgs })
        .eq("id", id)
        .eq("status", "pending")
        .select("id");

    if (updateError) {
        console.error("[actions] failed to save draft edit:", updateError);
        return NextResponse.json(
            { error: "I couldn't save the edit, so the draft is unchanged." },
            { status: 500 }
        );
    }

    if (!updated || updated.length === 0) {
        return NextResponse.json(
            { error: "This action was resolved while you were editing, so the edit wasn't saved." },
            { status: 409 }
        );
    }

    await writeTrace({
        trace_id: pending.trace_id,
        step: "permission_check",
        tool_name: pending.tool_name as ToolName,
        input: { event: "human_edit", fields: edit.changed },
        output: {
            before: { subject: stored.subject, body: stored.body },
            after: { subject: edit.subject, body: edit.body },
        },
        status: "success",
        latency_ms: 0,
    });

    return NextResponse.json({
        success: true,
        unchanged: false,
        changed: edit.changed,
        subject: edit.subject,
        body: edit.body,
    });
}