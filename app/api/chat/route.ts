import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import { randomUUID } from "crypto";
import { runPlanner, PlannerStep } from "@/lib/agent/planner";
import { executeTool } from "@/lib/agent/executor";
import { manageShortTermMemory } from "@/lib/agent/memory";
import { writeTrace } from "@/lib/tracing";
import { Message, AgentRequest } from "@/types";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard cap on chained tool calls within a single turn. This is what keeps
// multi-step planning "constrained deterministic agent" rather than
// "AutoGPT chaos" — a bounded, auditable sequence, never an open loop.
// Each individual call still passes through the exact same permission layer;
// this cap only limits how many auto/log-and-run steps can chain before we
// stop and say so honestly instead of looping indefinitely.
const MAX_TOOL_STEPS = 4;

async function fetchFullTrace(trace_id: string) {
    const { data } = await supabase
        .from("trace_logs")
        .select("*")
        .eq("trace_id", trace_id)
        .order("created_at", { ascending: true });

    return data ?? [];
}

export async function POST(req: NextRequest) {
    const body: AgentRequest = await req.json();
    const { message, conversation_id, conversation_history } = body;

    const trace_id = randomUUID();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            let streamClosed = false;

            const send = (data: object) => {
                if (streamClosed) return;
                try {
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
                    );
                } catch (err) {
                    // Client disconnected (page nav/reload) mid-stream — the
                    // underlying controller can close out from under us
                    // asynchronously. Not a real failure, just stop sending.
                    streamClosed = true;
                    console.warn("[chat] send skipped — controller already closed:", err);
                }
            };

            const closeStream = () => {
                if (streamClosed) return;
                streamClosed = true;
                try {
                    controller.close();
                } catch {
                    // Already closed by the client disconnecting — fine, ignore.
                }
            };

            try {
                // Step 1 — manage short-term memory window
                const history = await manageShortTermMemory(
                    conversation_id,
                    conversation_history
                );

                // Step 2 — bounded tool-call loop. Each iteration: plan, then
                // (if a tool was picked) execute it and feed the real result
                // back into the next plan call. Stops the moment the planner
                // is done (direct_response), a needs-approval tool is picked
                // (halt for human approval, unchanged from before), or the
                // step cap is hit.
                const completedSteps: PlannerStep[] = [];

                send({ type: "status", message: "Thinking..." });
                let plan = await runPlanner(message, history, trace_id, completedSteps);

                let hitStepCap = false;

                while (plan.type === "tool_call") {
                    if (completedSteps.length >= MAX_TOOL_STEPS) {
                        hitStepCap = true;
                        break;
                    }

                    send({
                        type: "status",
                        message: `Using tool: ${plan.toolName}...`,
                    });

                    const execResult = await executeTool(
                        plan.toolName,
                        plan.args,
                        trace_id
                    );

                    // needs-approval path — halt, tell user, return early.
                    // Unchanged: a needs-approval tool ALWAYS halts immediately,
                    // regardless of how many auto/log-and-run steps preceded it.
                    if (execResult.type === "pending") {
                        send({
                            type: "pending_approval",
                            pendingActionId: execResult.pendingActionId,
                            toolName: execResult.toolName,
                            args: execResult.args,
                            message: `This action requires your approval before it runs.`,
                        });

                        await writeTrace({
                            trace_id,
                            step: "final_response",
                            input: { message },
                            output: { halted: true, reason: "pending_approval" },
                            status: "pending_approval",
                            latency_ms: 0,
                        });

                        const fullTrace = await fetchFullTrace(trace_id);
                        send({ type: "trace_batch", trace_id, userMessage: message, steps: fullTrace });

                        send({ type: "done", trace_id });
                        closeStream();
                        return;
                    }

                    completedSteps.push({
                        toolName: plan.toolName,
                        args: plan.args,
                        result: execResult.result,
                    });

                    send({ type: "status", message: "Thinking..." });
                    plan = await runPlanner(message, history, trace_id, completedSteps);
                }

                // Step 3 — decide what to stream: an honest step-cap message,
                // the planner's own direct answer (no tools were ever needed
                // this turn), or a synthesis of everything the tools returned.
                let toolContext = "";
                let contentToStream: string | null = null;

                if (hitStepCap) {
                    contentToStream =
                        "I wasn't able to finish that within the number of steps I'm allowed to take automatically — could you break it into a smaller request, or try again?";

                    await writeTrace({
                        trace_id,
                        step: "plan",
                        input: { message, stepIndex: completedSteps.length },
                        output: { haltedReason: "max_steps_exceeded" },
                        status: "error",
                        latency_ms: 0,
                    });
                } else if (completedSteps.length === 0 && plan.type === "direct_response") {
                    // No tool was ever needed this turn — answer straight from
                    // conversation history, exactly like the original single-shot path.
                    contentToStream = plan.content;
                } else {
                    // One or more tools ran this turn — synthesize the final answer
                    // from EVERYTHING they returned, not just the last one, so a
                    // multi-step turn (e.g. resolveAudience → sendBroadcast) reads
                    // as one coherent answer instead of only reflecting the last step.
                    toolContext = completedSteps
                        .map((step) =>
                            step.result.success
                                ? `Tool ${step.toolName} returned:\n${JSON.stringify(step.result.data, null, 2)}`
                                : `Tool ${step.toolName} failed: ${step.result.error}`
                        )
                        .join("\n\n");
                }

                // Step 4 — stream final response
                send({ type: "status", message: "Generating response..." });

                const finalStart = Date.now();

                const systemPrompt =
                    contentToStream !== null
                        ? null
                        : `You are Warrant, the AI operations assistant for Solmara Studio. Based on the tool result(s) below, give a clear, concise response to the user.

Rules:
- Never narrate what you're about to do or did ("I'll search...", "let me check...", "I checked our records..."). Just state the answer directly, as if you already know it.
- Never mention internal tool names, JSON, or function syntax.
- State concrete facts, figures, and numbers exactly as they appear in the tool result(s) below — do not hedge, generalize, or paraphrase a specific number into a vague statement like "pricing varies." If a tool result contains a number, name, or date, use it verbatim.
- If a broadcast or email send had partial failures, state the exact counts (e.g. "9 of 12 sent, 3 failed") — never round up to "sent successfully" if any recipient failed.
- If the tool result(s) genuinely contain no relevant information, say so plainly rather than inventing a generic-sounding non-answer.
- Format with markdown: bullet points for distinct fields (email, phone, status), bold for labels. Keep it scannable, not a paragraph wall.

Tool result(s):
${toolContext}`;

                if (contentToStream) {
                    // Stream the planner's direct response token by token
                    for (const char of contentToStream) {
                        send({ type: "token", token: char });
                        await new Promise((r) => setTimeout(r, 8));
                    }
                } else {
                    // Stream a Groq synthesis of the accumulated tool result(s)
                    const streamResponse = await groq.chat.completions.create({
                        model: "openai/gpt-oss-120b",
                        messages: [
                            { role: "system", content: systemPrompt! },
                            { role: "user", content: message },
                        ],
                        stream: true,
                        max_tokens: 1024,
                        include_reasoning: false,
                    });

                    for await (const chunk of streamResponse) {
                        const token = chunk.choices[0]?.delta?.content;
                        if (token) {
                            send({ type: "token", token });
                        }
                    }
                }

                const finalLatency = Date.now() - finalStart;

                await writeTrace({
                    trace_id,
                    step: "final_response",
                    input: {
                        message,
                        toolsUsed: completedSteps.map((s) => s.toolName),
                        hitStepCap,
                    },
                    output: { streamed: true },
                    status: "success",
                    latency_ms: finalLatency,
                });

                const fullTrace = await fetchFullTrace(trace_id);
                send({ type: "trace_batch", trace_id, userMessage: message, steps: fullTrace });

                send({ type: "done", trace_id });
                closeStream();
            } catch (err) {
                console.error("[chat] stream error:", err);

                await writeTrace({
                    trace_id,
                    step: "final_response",
                    input: { message },
                    output: { error: String(err) },
                    status: "error",
                    latency_ms: 0,
                });

                send({ type: "error", message: "Something went wrong. Please try again." });
                closeStream();
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        },
    });
}