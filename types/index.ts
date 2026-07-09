export type ToolTier = "auto" | "log-and-run" | "needs-approval";

export type ToolName =
    | "searchKnowledgeBase"
    | "sendEmail"
    | "createLead"
    | "createTask"
    | "getCustomer";

export type TraceStep =
    | "plan"
    | "permission_check"
    | "tool_call"
    | "validation"
    | "memory_write"
    | "final_response";

export type TraceStatus = "success" | "error" | "pending_approval";


export interface TraceEntry {
    trace_id: string;
    step: TraceStep;
    tool_name?: ToolName;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    status: TraceStatus;
    latency_ms: number;
}

export interface TraceLogRow {
    id: string;
    trace_id: string;
    step: TraceStep;
    tool_name: ToolName | null;
    input: Record<string, unknown> | null;
    output: Record<string, unknown> | null;
    status: TraceStatus;
    latency_ms: number;
    created_at: string;
}

export interface ToolDefinition {
    name: ToolName;
    tier: ToolTier;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema shape for Groq
}

export interface ToolResult {
    success: boolean;
    data?: Record<string, unknown>;
    error?: string;
}

export interface Message {
    role: "user" | "assistant" | "tool";
    content: string;
    tool_call_id?: string;
    tool_name?: string;
}

export interface AgentRequest {
    message: string;
    conversation_id: string;
    conversation_history: Message[];
}

export interface PendingAction {
    id: string;
    trace_id: string;
    tool_name: ToolName;
    proposed_args: Record<string, unknown>;
    status: "pending" | "approved" | "rejected";
    created_at: string;
}

