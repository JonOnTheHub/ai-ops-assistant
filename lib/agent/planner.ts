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
- Be concise and professional`;

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

export async function runPlanner(
    userMessage: string,
    history: Message[],
    trace_id: string
): Promise<PlannerOutput> {
    const start = Date.now();

    // Recall relevant long-term memory for this query
    const memories = await recallLongTermMemory(userMessage);

    const memoryBlock =
        memories.length > 0
            ? `\n\nRelevant memory from past conversations:\n${memories.map((m) => `- ${m}`).join("\n")}`
            : "";

    // Build message list for Groq
    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
        {
            role: "system",
            content: SYSTEM_PROMPT + memoryBlock,
        },
        ...history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
        })),
        {
            role: "user",
            content: userMessage,
        },
    ];

    const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages,
        tools: getGroqTools(),
        tool_choice: "auto",
        max_tokens: 1024,
    });

    const latency_ms = Date.now() - start;
    const choice = response.choices[0];

    // Model decided to call a tool
    if (
        choice.finish_reason === "tool_calls" &&
        choice.message.tool_calls?.[0]
    ) {
        const toolCall = choice.message.tool_calls[0];
        const toolName = toolCall.function.name as ToolName;
        const args = JSON.parse(toolCall.function.arguments);

        await writeTrace({
            trace_id,
            step: "plan",
            tool_name: toolName,
            input: { userMessage, memoryCount: memories.length },
            output: { toolName, args },
            status: "success",
            latency_ms,
        });

        return { type: "tool_call", toolName, args, traceLatency: latency_ms };
    }

    // Model decided to respond directly (no tool needed)
    const content = choice.message.content ?? "";

    await writeTrace({
        trace_id,
        step: "plan",
        input: { userMessage, memoryCount: memories.length },
        output: { direct_response: true },
        status: "success",
        latency_ms,
    });

    return { type: "direct_response", content, traceLatency: latency_ms };
}