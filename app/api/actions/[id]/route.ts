import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/tools/sendEmail";
import { writeTrace } from "@/lib/tracing";
import { ToolName } from "@/types";

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Tool execution map for approved actions
// Only needs-approval tools live here
type ApprovalFn = (args: Record<string, unknown>) => Promise<unknown>;

const APPROVAL_EXECUTORS: Partial<Record<ToolName, ApprovalFn>> = {
  sendEmail: (args) =>
    sendEmail(args as { to: string; subject: string; body: string }),
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

        await supabase
            .from("pending_actions")
            .update({ status: "approved", resolved_at: new Date().toISOString() })
            .eq("id", id);

        await writeTrace({
            trace_id: pending.trace_id,
            step: "tool_call",
            tool_name: pending.tool_name as ToolName,
            input: pending.proposed_args,
            output: result as Record<string, unknown>,
            status: "success",
            latency_ms,
        });

        return NextResponse.json({ success: true, status: "approved", result });
    } catch (err) {
        await writeTrace({
            trace_id: pending.trace_id,
            step: "tool_call",
            tool_name: pending.tool_name as ToolName,
            input: pending.proposed_args,
            output: { error: String(err) },
            status: "error",
            latency_ms: Date.now() - start,
        });

        return NextResponse.json(
            { error: `Execution failed: ${String(err)}` },
            { status: 500 }
        );
    }
}