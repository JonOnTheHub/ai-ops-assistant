import Groq from "groq-sdk";
import { writeTrace } from "@/lib/tracing";
import { getGroqTools } from "@/lib/tools";
import { recallLongTermMemory } from "./memory";
import { Message, ToolName } from "@/types";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const SYSTEM_PROMPT = `You are an AI Operations Assistant for a Lagos-based business agency.

You have access to the following tools:
- searchKnowledgeBase: search internal policies and business knowledge
- getCustomer: look up customer records and history from the CRM
- createTask: create a task or action item to track follow-ups
- createLead: add a new lead to the CRM
- sendEmail: draft and send an email — this ALWAYS requires human approval before sending

Rules:
- Always use searchKnowledgeBase before answering policy or procedure questions
- Always use getCustomer before discussing a specific client
- Use createTask when the user wants to track something
- Use sendEmail when the user wants to send a message to a client — remind the user it will require their approval
- Do not hallucinate customer data — always retrieve it
- Be concise and professional

Formatting:
- Use markdown for structure — bullet points for lists of fields (email, phone, status, etc.), bold for labels or key terms
- Keep paragraphs short — break up dense information into scannable lines
- Never return a wall of text when the content has distinct fields or items`;

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