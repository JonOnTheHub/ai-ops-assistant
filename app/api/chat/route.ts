import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import { randomUUID } from "crypto";
import { runPlanner } from "@/lib/agent/planner";
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
            const send = (data: object) => {
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
                );
            };

            try {
                // Step 1 — manage short-term memory window
                const history = await manageShortTermMemory(
                    conversation_id,
                    conversation_history
                );

                // Step 2 — run planner
                send({ type: "status", message: "Thinking..." });

                const plan = await runPlanner(message, history, trace_id);

                // Step 3 — if planner picked a tool, execute it
                let toolContext = "";

                if (plan.type === "tool_call") {
                    send({
                        type: "status",
                        message: `Using tool: ${plan.toolName}...`,
                    });

                    const execResult = await executeTool(
                        plan.toolName,
                        plan.args,
                        trace_id
                    );

                    // needs-approval path — halt, tell user, return early
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
                        controller.close();
                        return;
                    }

                    // Build tool context to inject into final response generator
                    if (execResult.result.success) {
                        toolContext = `Tool ${plan.toolName} returned:\n${JSON.stringify(
                            execResult.result.data,
                            null,
                            2
                        )}`;
                    } else {
                        toolContext = `Tool ${plan.toolName} failed: ${execResult.result.error}`;
                    }
                } else {
                    // Direct response from planner — skip tool execution
                    toolContext = "";
                }

                // Step 4 — stream final response
                send({ type: "status", message: "Generating response..." });

                const finalStart = Date.now();

                const systemPrompt =
                    plan.type === "direct_response" && plan.content
                        ? null
                        : `You are an AI Operations Assistant. Based on the tool result below, give a clear, concise response to the user. Do not mention internal tool names or JSON in your response — speak naturally.

Format with markdown: use bullet points for distinct fields (email, phone, status), bold for labels. Keep it scannable, not a paragraph wall.

Tool result:
${toolContext}`;

                // If planner returned a direct response (no tool), stream that content
                // Otherwise stream a synthesis of the tool result
                const contentToStream =
                    plan.type === "direct_response" ? plan.content : null;

                if (contentToStream) {
                    // Stream the planner's direct response token by token
                    for (const char of contentToStream) {
                        send({ type: "token", token: char });
                        await new Promise((r) => setTimeout(r, 8));
                    }
                } else {
                    // Stream a Groq synthesis of the tool result
                    const streamResponse = await groq.chat.completions.create({
                        model: "llama-3.3-70b-versatile",
                        messages: [
                            { role: "system", content: systemPrompt! },
                            { role: "user", content: message },
                        ],
                        stream: true,
                        max_tokens: 1024,
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
                        toolUsed: plan.type === "tool_call" ? plan.toolName : null,
                    },
                    output: { streamed: true },
                    status: "success",
                    latency_ms: finalLatency,
                });

                // ← this was missing on the completion path — the actual bug
                const fullTrace = await fetchFullTrace(trace_id);
                send({ type: "trace_batch", trace_id, userMessage: message, steps: fullTrace });

                send({ type: "done", trace_id });
                controller.close();
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
                controller.close();
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