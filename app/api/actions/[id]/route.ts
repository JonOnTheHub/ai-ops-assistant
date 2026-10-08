import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/tools/sendEmail";
import { sendBroadcast } from "@/lib/tools/sendBroadcast";
import { writeTrace } from "@/lib/tracing";
import { classifyToolResult, classifyThrown } from "@/lib/agent/classifier";
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