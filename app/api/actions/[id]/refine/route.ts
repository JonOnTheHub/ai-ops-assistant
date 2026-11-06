import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { classifyThrown } from "@/lib/agent/classifier";
import { isEditableTool } from "@/lib/agent/draftEdit";
import { RefineError, refineSelection, validateRefineRequest } from "@/lib/agent/refine";

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST /api/actions/[id]/refine
//
// Suggests a rewrite of a highlighted passage of a pending email or broadcast
// draft. It changes NOTHING: no database write, nothing applied to the draft. The
// person sees the suggestion beside the original and chooses Replace or
// Dismiss, and anything they keep still has to be Saved through PATCH.
//
// It only works for a real draft that is still waiting for approval, so it
// can't be used as a general-purpose model endpoint.
export async function POST(
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
        .select("id, tool_name")
        .eq("id", id)
        .eq("status", "pending")
        .single();

    if (fetchError || !pending) {
        return NextResponse.json(
            { error: "Pending action not found or already resolved" },
            { status: 404 }
        );
    }

    if (!isEditableTool(pending.tool_name)) {
        return NextResponse.json({ error: "Only email and broadcast drafts can be rewritten." }, { status: 400 });
    }

    const request = validateRefineRequest(payload);
    if (!request.ok) {
        return NextResponse.json({ error: request.error }, { status: 400 });
    }

    try {
        const { suggestion, facts } = await refineSelection(request);
        return NextResponse.json({
            success: true,
            action: request.action,
            original: request.selection,
            suggestion,
            facts,
        });
    } catch (err) {
        if (err instanceof RefineError) {
            return NextResponse.json({ error: err.message, retryable: true }, { status: 502 });
        }

        console.error("[refine] model call failed:", err);

        // Same classification as every other failure in the app, so a rate limit
        // reads as a rate limit and the card can offer the right next step.
        const errorInfo = classifyThrown(err, { completedTools: [] });
        const status = errorInfo.kind === "tool_failure" && errorInfo.cause === "rate_limit" ? 429 : 502;
        return NextResponse.json({ error: errorInfo.summary, errorInfo, retryable: true }, { status });
    }
}