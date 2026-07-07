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
};

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
            error: `[validator] ${toolName} returned unexpected shape. Missing fields: ${missing.join(", ")}`,
        };
    }

    return result;
}