import Groq from "groq-sdk";
import { writeTrace } from "@/lib/tracing";
import { getGroqTools } from "@/lib/tools";
import { recallLongTermMemory } from "./memory";
import { Message, ToolName } from "@/types";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const SYSTEM_PROMPT = `You are Warrant, the AI operations assistant for Solmara Studio — a Lagos-based hospitality and events design studio serving high-end clients.

DECISION ORDER — follow these steps in order, every time, before doing anything else:

Step 1 — Is this message asking about something that already happened, or a status/history question? (Examples: "did we send that", "have we done X", "what happened with Y", "is that done yet", casual confirmations like "si?" or "right?" after a prior action, "to who?")
→ If yes: answer directly from the conversation history already provided to you. Do NOT call any tool. Say what you know from what's already in this conversation. Stop here.

Step 2 — Is this message asking you to take a brand new action (send a new email, create a new task, create a new lead, look up a customer you haven't already looked up this turn)?
→ If yes: proceed to pick the single correct tool for that action.

Step 3 — Is this a genuine question about business policy, pricing, or procedure that you don't already have the answer to from this conversation?
→ Only then use searchKnowledgeBase. Do not use it to answer conversational or historical questions.

Tools available:
- searchKnowledgeBase: search internal policies and business knowledge (Step 3 only)
- getCustomer: look up customer records and history from the CRM
- createTask: create a task or action item to track follow-ups
- createLead: add a new lead to the CRM
- sendEmail: draft and send a NEW email — this ALWAYS requires human approval before sending

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
- You can ONLY act through the 5 tools you have. There is no way to update an existing lead's fields, or list all leads.
- If asked to do something outside your tools' capability, say so plainly.
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
        model: "llama-3.3-70b-versatile",
        messages,
        tools: getGroqTools(),
        tool_choice: toolChoice,
        max_tokens: 1024,
    });
}

async function callGroqPlain(messages: Groq.Chat.ChatCompletionMessageParam[]) {
    // No tools at all — last-resort fallback when Groq's own function-calling
    // machinery rejects a malformed generation at the API level.
    return groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages,
        max_tokens: 1024,
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
    trace_id: string
): Promise<PlannerOutput> {
    const start = Date.now();

    const memories = await recallLongTermMemory(userMessage);

    const memoryBlock =
        memories.length > 0
            ? `\n\nRelevant memory from past conversations:\n${memories.map((m) => `- ${m}`).join("\n")}`
            : "";

    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM_PROMPT + memoryBlock },
        ...history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
        })),
        { role: "user", content: userMessage },
    ];

    // Every exit funnels through here — writes the trace and returns.
    // The function is structurally incapable of returning undefined.
    const finish = async (output: PlannerOutput, extra?: Record<string, unknown>) => {
        await writeTrace({
            trace_id,
            step: "plan",
            tool_name: output.type === "tool_call" ? output.toolName : undefined,
            input: { userMessage, memoryCount: memories.length, ...extra },
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
        // Groq rejected the generation at the API level (e.g. malformed
        // <function=...> syntax). Don't crash the turn — fall back to a
        // plain, tool-free completion.
        console.warn("[planner] tool-enabled call failed at the API level, falling back:", err);

        try {
            const fallback = await callGroqPlain(messages);
            const fallbackContent =
                fallback.choices[0]?.message.content ??
                "I ran into an issue processing that — could you rephrase?";
            return finish(
                { type: "direct_response", content: fallbackContent, traceLatency: Date.now() - start },
                { recoveredFromApiError: true }
            );
        } catch (fallbackErr) {
            console.error("[planner] fallback call also failed:", fallbackErr);
            return finish(
                {
                    type: "direct_response",
                    content: "Something went wrong processing that — please try again.",
                    traceLatency: Date.now() - start,
                },
                { recoveredFromApiError: true, fallbackFailed: true }
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