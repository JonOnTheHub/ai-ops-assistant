import { ToolName, ToolResult } from "@/types";

// Expected fields per tool — validator checks these exist in the result
// before passing the output back to the model.
// A missing field = tool returned unexpected shape = treat as error.

const EXPECTED_FIELDS: Partial<Record<ToolName, string[]>> = {
    searchKnowledgeBase: ["results"],
    getCustomer: ["customers"],
    createTask: ["task"],
    createLead: ["lead"],
    sendEmail: ["email_id", "to", "subject"],
    resolveAudience: ["recipients", "count"],
    sendBroadcast: ["results", "sent_count", "failed_count", "total"],
};

// Exported so other modules (currently lib/agent/classifier.ts) can detect
// a validator-originated failure by prefix instead of duplicating this string.
export const VALIDATOR_ERROR_PREFIX = "[validator]";

export function validateToolResult(
    toolName: ToolName,
    result: ToolResult
): ToolResult {
    // If tool already failed, pass through — nothing to validate
    if (!result.success) return result;

    const expected = EXPECTED_FIELDS[toolName];

    // No schema defined for this tool — pass through
    if (!expected) return result;

    const data = result.data ?? {};
    const missing = expected.filter((field) => !(field in data));

    if (missing.length > 0) {
        return {
            success: false,
            error: `${VALIDATOR_ERROR_PREFIX} ${toolName} returned unexpected shape. Missing fields: ${missing.join(", ")}`,
        };
    }

    return result;
}