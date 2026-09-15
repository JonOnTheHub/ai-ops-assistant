import Groq from "groq-sdk";
import { writeTrace } from "@/lib/tracing";
import { getGroqTools } from "@/lib/tools";
import { recallLongTermMemory } from "./memory";
import { Message, ToolName, ToolResult } from "@/types";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// A tool call already executed earlier in THIS turn, fed back in so the
// planner can decide what to do next with real results instead of guessing.
export interface PlannerStep {
    toolName: ToolName;
    args: Record<string, unknown>;
    result: ToolResult;
}

const SYSTEM_PROMPT = `You are Warrant, the AI operations assistant for Solmara Studio — a Lagos-based hospitality and events design studio serving high-end clients.

DECISION ORDER — follow these steps in order, every time, before doing anything else:

Step 1 — Is this message asking about something that already happened, or a status/history question? (Examples: "did we send that", "have we done X", "what happened with Y", "is that done yet", "what did we do earlier", "what did we do today", casual confirmations like "si?" or "right?" after a prior action, "to who?")
→ If yes: answer directly from the conversation history already provided to you — including any message starting with "[Summary of earlier conversation...]", which contains real facts (names, counts, outcomes) from earlier in this same conversation that have been compressed out of the visible window, NOT a placeholder to ignore. Check it specifically before saying you don't know. Do NOT call any tool. Say what you know from what's already in this conversation. Stop here.
→ CRITICAL for broad recall questions specifically ("what did we do today", "what have we done so far", "summarize this conversation"): your answer must draw from BOTH the "[Summary of earlier conversation...]" block AND the live recent messages, merged into one complete list — never just the most recent portion. If a summary block exists, at least one item from it MUST appear in your answer alongside the recent items. Defaulting to only what's most recent and dropping earlier-but-real actions is answering confidently but incompletely, which is its own form of dishonesty here.

Step 2 — Is this message asking you to take a brand new action (send a new email, create a new task, create a new lead, look up a customer you haven't already looked up this turn, message a group of people)?
→ If yes: proceed to pick the single correct tool for that action.

Step 3 — Is this a genuine question about business policy, pricing, or procedure that you don't already have the answer to from this conversation?
→ Only then use searchKnowledgeBase. Do not use it to answer conversational or historical questions.

Never narrate this decision process out loud to the user. Do not say things like "I need to follow the decision order" or "I'll proceed to the next step" — just silently decide, then either call the tool or answer directly. The steps above are for your own reasoning only, never visible output.

MULTI-STEP ACTIONS — some requests take more than one tool call to complete, in a fixed sequence:
- Messaging a group of people is TWO steps: (1) resolveAudience to find out who matches, THEN (2) sendBroadcast with the exact recipient list resolveAudience returned. Never invent recipient emails yourself — always resolve first.
- If you already called resolveAudience earlier in this turn (you'll see its result below), do not call it again. Look at what it returned and decide: if it found real recipients, call sendBroadcast next with that exact list, subject, and body. If it found nobody, say so plainly instead of calling sendBroadcast with an empty list.
- Every tool call still passes through the permission layer on its own — resolving an audience never sends anything by itself, and sendBroadcast always still requires human approval.

MULTI-STEP SCOPE — the multi-step ability above is ONLY for the resolveAudience → sendBroadcast sequence. It is NOT a license to retry other tools when you don't like their result:
- searchKnowledgeBase: call it ONCE per user question. If it returns nothing relevant or weak results, say so honestly — do not retry with a reworded query hoping for a better hit. A second guess isn't more grounded than the first; it's just a second guess.
- getCustomer: same — one lookup, then work with what it returns or say it wasn't found.
- Chaining tool calls is for genuinely sequential actions (resolve who, then send to them) — not for repeatedly querying the same read-only tool until you're satisfied with the answer.

Tools available:
- searchKnowledgeBase: search internal policies and business knowledge (Step 3 only)
- getCustomer: look up customer records and history from the CRM
- createTask: create a task or action item to track follow-ups
- createLead: add a new lead to the CRM
- sendEmail: draft and send a NEW email to a single customer/lead — this ALWAYS requires human approval before sending
- resolveAudience: look up employees or customers to message, filtered by role and exclusions — read-only, never sends anything
- sendBroadcast: send a message to a finalized recipient list from resolveAudience — this ALWAYS requires human approval before sending

Rules:
- Always use getCustomer before discussing or emailing a specific client — pull their real notes, company, and history into what you write
- Do not hallucinate customer data — always retrieve it
- Never call a tool to answer a question about something that already happened — that information is either already in this conversation or doesn't exist.

Email drafting standards:
- Every email is sent on behalf of Solmara Studio. Sign off as "The Solmara Studio Team" unless told otherwise.
- Reference real, specific details about the client when available.
- Structure: warm greeting, short context paragraph grounded in real details, clear next step, professional sign-off.
- Match tone to a boutique hospitality studio: warm, precise, professional.
- CRITICAL: The email body is read by the client. NEVER mention approval, review, internal workflow, drafts, or that a human needs to sign off on it.

Formatting:
- Use markdown for structure — bullet points for distinct fields, bold for labels
- Keep paragraphs short and scannable

Honesty constraint:
- You can ONLY act through the 5 tools you have. There is no way to update an existing lead's fields, list all leads, or list all customers — getCustomer only looks up ONE customer by name or email.
- If asked to do something outside your tools' capability, say so plainly AND briefly state what you can do instead (e.g. "I can't list all customers, but I can look up a specific one if you give me a name or email"). Never just refuse with no explanation.
- DO answer conversational/status questions directly from conversation history — that's recall, not fabrication.`;

export type PlannerOutput =
    | {
        type: "tool_call";
        toolName: ToolName;
        args: Record<string, unknown>;
        traceLatency: number;
    }
    | {
        type: "direct_response";
        content: string;
        traceLatency: number;
    };

async function callGroqWithTools(
    messages: Groq.Chat.ChatCompletionMessageParam[],
    toolChoice: "auto" | "required"
) {
    return groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages,
        tools: getGroqTools(),
        tool_choice: toolChoice,
        max_tokens: 1024,
        include_reasoning: false,
    });
}



function extractToolCall(choice: Groq.Chat.ChatCompletion.Choice) {
    if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.[0]) {
        return null;
    }

    const toolCall = choice.message.tool_calls[0];

    try {
        return {
            toolName: toolCall.function.name as ToolName,
            args: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
        };
    } catch {
        // Malformed JSON in the function arguments — treat as no tool call,
        // not a crash.
        return null;
    }
}

function looksLikeRawToolCall(content: string): boolean {
    return (
        content.includes("<function") ||
        content.includes('{"to":') ||
        content.includes('{"query":') ||
        content.includes('{"name":') ||
        content.includes('{"title":')
    );
}

export async function runPlanner(
    userMessage: string,
    history: Message[],
    trace_id: string,
    priorSteps: PlannerStep[] = []
): Promise<PlannerOutput> {
    const start = Date.now();

    const memories = await recallLongTermMemory(userMessage);

    const memoryBlock =
        memories.length > 0
            ? `\n\nRelevant memory from past conversations:\n${memories.map((m) => `- ${m}`).join("\n")}`
            : "";

    // Prior steps from THIS turn become real tool_call / tool result message
    // pairs, exactly like a completed turn would look — so the model reasons
    // over actual returned data, not a description of it.
    const priorStepMessages: Groq.Chat.ChatCompletionMessageParam[] = priorSteps.flatMap(
        (step, i) => {
            const callId = `step_${i}`;
            return [
                {
                    role: "assistant" as const,
                    content: null,
                    tool_calls: [
                        {
                            id: callId,
                            type: "function" as const,
                            function: {
                                name: step.toolName,
                                arguments: JSON.stringify(step.args),
                            },
                        },
                    ],
                },
                {
                    role: "tool" as const,
                    tool_call_id: callId,
                    content: JSON.stringify(
                        step.result.success
                            ? step.result.data
                            : { error: step.result.error }
                    ),
                },
            ];
        }
    );

    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM_PROMPT + memoryBlock },
        ...history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
        })),
        { role: "user", content: userMessage },
        ...priorStepMessages,
    ];

    // Every exit funnels through here — writes the trace and returns.
    // The function is structurally incapable of returning undefined.
    const finish = async (output: PlannerOutput, extra?: Record<string, unknown>) => {
        await writeTrace({
            trace_id,
            step: "plan",
            tool_name: output.type === "tool_call" ? output.toolName : undefined,
            input: { userMessage, memoryCount: memories.length, stepIndex: priorSteps.length, ...extra },
            output:
                output.type === "tool_call"
                    ? { toolName: output.toolName, args: output.args }
                    : { direct_response: true },
            status: "success",
            latency_ms: Date.now() - start,
        });
        return output;
    };

    // ── Attempt 1 — normal tool-enabled call ──
    let firstChoice: Groq.Chat.ChatCompletion.Choice;

    try {
        const response = await callGroqWithTools(messages, "auto");
        firstChoice = response.choices[0];
    } catch (err) {
        // Groq's function-calling layer failed at the API level. Retry once —
        // this class of failure is often transient — before giving up honestly.
        console.warn("[planner] tool-enabled call failed, retrying once:", err);

        try {
            const retryResponse = await callGroqWithTools(messages, "auto");
            firstChoice = retryResponse.choices[0];
        } catch (retryErr) {
            // Do NOT fall back to a tools-free completion here — without tools,
            // the model has no way to ground an answer in real data, and will
            // confidently fabricate figures instead. A visible error is safer
            // than a silent wrong answer.
            console.error("[planner] tool-enabled call failed twice, giving up honestly:", retryErr);
            return finish(
                {
                    type: "direct_response",
                    content: "I ran into a technical issue processing that — could you try asking again?",
                    traceLatency: Date.now() - start,
                },
                { recoveredFromApiError: true, retriedAndFailed: true }
            );
        }
    }

    const tool = extractToolCall(firstChoice);

    if (tool) {
        return finish({
            type: "tool_call",
            toolName: tool.toolName,
            args: tool.args,
            traceLatency: Date.now() - start,
        });
    }

    const content = firstChoice.message.content ?? "";

    // ── Attempt 2 — content looked like a leaked/malformed tool call ──
    if (looksLikeRawToolCall(content)) {
        console.warn("[planner] raw tool call in text — retrying with clarified auto choice");

        const clarifiedMessages: Groq.Chat.ChatCompletionMessageParam[] = [
            ...messages,
            {
                role: "system",
                content:
                    "Your previous response looked like a malformed or accidental tool call. Reconsider: does this message actually require a NEW action, or is it a question about something already known/done? If no action is needed, respond in plain text.",
            },
        ];

        try {
            const retryResponse = await callGroqWithTools(clarifiedMessages, "auto");
            const retryChoice = retryResponse.choices[0];
            const retryTool = extractToolCall(retryChoice);

            if (retryTool) {
                return finish(
                    {
                        type: "tool_call",
                        toolName: retryTool.toolName,
                        args: retryTool.args,
                        traceLatency: Date.now() - start,
                    },
                    { retried: true }
                );
            }

            const retryContent = retryChoice.message.content ?? content;
            return finish(
                { type: "direct_response", content: retryContent, traceLatency: Date.now() - start },
                { retried: true, correctedFromFalseToolCall: true }
            );
        } catch (retryErr) {
            // Retry also failed at the API level — fall back to the original
            // text content rather than crashing the turn.
            console.warn("[planner] retry call failed at the API level:", retryErr);
            return finish(
                { type: "direct_response", content, traceLatency: Date.now() - start },
                { retried: true, retryApiError: true }
            );
        }
    }

    return finish({ type: "direct_response", content, traceLatency: Date.now() - start });
}