import Groq from "groq-sdk";
import { writeTrace } from "@/lib/tracing";
import { getGroqTools } from "@/lib/tools";
import { recallLongTermMemory } from "./memory";
import { Message, ToolName } from "@/types";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const SYSTEM_PROMPT = `You are Warrant, the AI operations assistant for Solmara Studio — a Lagos-based hospitality and events design studio serving high-end clients like bridal couture houses, event planning firms, and enterprise hospitality brands.

You have access to the following tools:
- searchKnowledgeBase: search internal policies and business knowledge
- getCustomer: look up customer records and history from the CRM
- createTask: create a task or action item to track follow-ups
- createLead: add a new lead to the CRM
- sendEmail: draft and send an email — this ALWAYS requires human approval before sending

Rules:
- Always use searchKnowledgeBase before answering policy or procedure questions
- Always use getCustomer before discussing or emailing a specific client — pull their real notes, company, and history into what you write
- Use createTask when the user wants to track something
- Use sendEmail when the user wants to send a NEW message to a client

When NOT to call a tool:
- If the user is asking a question about something that already happened in this conversation (e.g. "did we send that?", "how many emails went out?", "what happened with X?"), answer directly from the conversation history you were given. Do not call sendEmail, createTask, or createLead to answer a question about the past — those tools only take new actions, they don't look up what you already did.
- Treat phrasing like "yes?", "did we", "have we", "was that", "is that done" as a request for information, not a request for a new action, even if the sentence mentions an email, task, or lead.
- If genuinely unsure whether the user wants a new action or an answer about a past one, default to answering conversationally and ask a brief clarifying question rather than taking an action.

Email drafting standards:
- Every email is sent on behalf of Solmara Studio. Sign off as "The Solmara Studio Team" unless told otherwise.
- Reference real, specific details about the client when available (their company, prior notes, context from getCustomer) — never write a generic template.
- Structure: a warm greeting using the client's name, a short context paragraph grounded in real details, a clear next step or ask, a professional sign-off.
- Match tone to a boutique hospitality studio: warm, precise, professional — not corporate-stiff, not casual.
- CRITICAL: The email body is read by the client. NEVER mention approval, review, internal workflow, drafts, or that a human needs to sign off on it. That is an internal system detail — the client must never see it. Write the email as if it will be sent exactly as drafted.

Formatting:
- Use markdown for structure in your own chat responses — bullet points for distinct fields, bold for labels
- Keep paragraphs short and scannable
- Never return a wall of text when the content has distinct fields or items

Honesty constraint:
- You can ONLY act through the 5 tools you have. There is no way to update an existing lead's fields, or list all leads.
- If asked to do something outside your tools' capability, say so plainly — never claim an action succeeded, or that you "checked" something, unless a tool was actually called this turn.
- Never answer from memory of what you said earlier in the conversation as if it were freshly verified data.`;

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

async function callGroq(
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

function extractToolCall(choice: Groq.Chat.ChatCompletion.Choice) {
    if (
        choice.finish_reason === "tool_calls" &&
        choice.message.tool_calls?.[0]
    ) {
        const toolCall = choice.message.tool_calls[0];
        return {
            toolName: toolCall.function.name as ToolName,
            args: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
        };
    }
    return null;
}

function looksLikeRawToolCall(content: string): boolean {
    return (
        content.includes("<function(") ||
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
            ? `\n\nRelevant memory from past conversations:\n${memories
                .map((m) => `- ${m}`)
                .join("\n")}`
            : "";

    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM_PROMPT + memoryBlock },
        ...history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
        })),
        { role: "user", content: userMessage },
    ];

    // First pass — auto tool choice
    const response = await callGroq(messages, "auto");
    const choice = response.choices[0];
    const tool = extractToolCall(choice);

    if (tool) {
        await writeTrace({
            trace_id,
            step: "plan",
            tool_name: tool.toolName,
            input: { userMessage, memoryCount: memories.length },
            output: { toolName: tool.toolName, args: tool.args },
            status: "success",
            latency_ms: Date.now() - start,
        });

        return {
            type: "tool_call",
            toolName: tool.toolName,
            args: tool.args,
            traceLatency: Date.now() - start,
        };
    }

    const content = choice.message.content ?? "";

    // Second pass — model leaked tool JSON as text, force it properly
    if (looksLikeRawToolCall(content)) {
        console.warn("[planner] raw tool call in text — retrying with tool_choice: required");

        const retryResponse = await callGroq(messages, "required");
        const retryChoice = retryResponse.choices[0];
        const retryTool = extractToolCall(retryChoice);

        if (retryTool) {
            await writeTrace({
                trace_id,
                step: "plan",
                tool_name: retryTool.toolName,
                input: { userMessage, memoryCount: memories.length, retried: true },
                output: { toolName: retryTool.toolName, args: retryTool.args },
                status: "success",
                latency_ms: Date.now() - start,
            });

            return {
                type: "tool_call",
                toolName: retryTool.toolName,
                args: retryTool.args,
                traceLatency: Date.now() - start,
            };
        }
    }

    // Direct response — model has no tool to call
    await writeTrace({
        trace_id,
        step: "plan",
        input: { userMessage, memoryCount: memories.length },
        output: { direct_response: true },
        status: "success",
        latency_ms: Date.now() - start,
    });

    return {
        type: "direct_response",
        content,
        traceLatency: Date.now() - start,
    };
}