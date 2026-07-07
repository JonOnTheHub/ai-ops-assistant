import { supabase } from "@/lib/supabase";
import { writeTrace } from "@/lib/tracing";
import { getToolTier } from "@/lib/tools";
import { searchKnowledgeBase } from "@/lib/tools/searchKnowledgeBase";
import { getCustomer } from "@/lib/tools/getCustomer";
import { createTask } from "@/lib/tools/createTask";
import { createLead } from "@/lib/tools/createLead";
import { sendEmail } from "@/lib/tools/sendEmail";
import { validateToolResult } from "./validator";
import { ToolName, ToolResult } from "@/types";

type ToolFn = (args: Record<string, unknown>) => Promise<ToolResult>;

const TOOL_IMPLEMENTATIONS: Record<ToolName, ToolFn> = {
  searchKnowledgeBase: (args) =>
    searchKnowledgeBase(args as { query: string }),
  getCustomer: (args) =>
    getCustomer(args as { query: string }),
  createTask: (args) =>
    createTask(args as { title: string; description: string; customer_name?: string }),
  createLead: (args) =>
    createLead(args as { name: string; email: string; company?: string; source?: "inbound" | "cold-outreach" | "referral" | "other" }),
  sendEmail: (args) =>
    sendEmail(args as { to: string; subject: string; body: string }),
};

export type ExecutorResult =
  | { type: "result"; toolName: ToolName; result: ToolResult; latency_ms: number }
  | { type: "pending"; pendingActionId: string; toolName: ToolName; args: Record<string, unknown> };

export async function executeTool(
  toolName: ToolName,
  args: Record<string, unknown>,
  trace_id: string
): Promise<ExecutorResult> {
  const tier = getToolTier(toolName);
  const permStart = Date.now();

  await writeTrace({
    trace_id,
    step: "permission_check",
    tool_name: toolName,
    input: { args, tier },
    status: "success",
    latency_ms: Date.now() - permStart,
  });

  if (tier === "needs-approval") {
    const { data: pending, error } = await supabase
      .from("pending_actions")
      .insert({
        trace_id,
        tool_name: toolName,
        proposed_args: args,
        status: "pending",
      })
      .select()
      .single();

    if (error) {
      console.error("[executor] failed to create pending action:", error);
    }

    await writeTrace({
      trace_id,
      step: "tool_call",
      tool_name: toolName,
      input: args,
      status: "pending_approval",
      latency_ms: 0,
    });

    return {
      type: "pending",
      pendingActionId: pending?.id ?? "unknown",
      toolName,
      args,
    };
  }

  const toolStart = Date.now();
  const rawResult = await TOOL_IMPLEMENTATIONS[toolName](args);
  const latency_ms = Date.now() - toolStart;

  const result = validateToolResult(toolName, rawResult);

  await writeTrace({
    trace_id,
    step: "tool_call",
    tool_name: toolName,
    input: args,
    output: result as unknown as Record<string, unknown>,
    status: result.success ? "success" : "error",
    latency_ms,
  });

  return { type: "result", toolName, result, latency_ms };
}