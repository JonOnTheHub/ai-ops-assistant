import { ToolDefinition, ToolName, ToolTier } from "@/types";

// Single source of truth for all tools.
// Planner reads `description` + `parameters` to build the Groq tool list.
// Executor reads `tier` to decide whether to run, flag, or hold.
// Adding a new tool = add one entry here + implement the function in its own file.

export const TOOL_REGISTRY: Record<ToolName, ToolDefinition> = {
    searchKnowledgeBase: {
        name: "searchKnowledgeBase",
        tier: "auto",
        description:
            "Search the internal knowledge base for policies, procedures, and business information. Use this when the user asks a question that requires internal knowledge.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The search query to find relevant knowledge base documents",
                },
            },
            required: ["query"],
        },
    },

    getCustomer: {
        name: "getCustomer",
        tier: "auto",
        description:
            "Look up a customer by name or email from the CRM. Returns customer details, notes, and linked leads.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Customer name or email address to search for",
                },
            },
            required: ["query"],
        },
    },

    createTask: {
        name: "createTask",
        tier: "log-and-run",
        description:
            "Create a new task in the system. Use when the user wants to track an action item or follow-up.",
        parameters: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "Short title for the task",
                },
                description: {
                    type: "string",
                    description: "Detailed description of what needs to be done",
                },
                customer_name: {
                    type: "string",
                    description: "Name of the related customer, if applicable",
                },
            },
            required: ["title", "description"],
        },
    },

    createLead: {
        name: "createLead",
        tier: "log-and-run",
        description:
            "Create a new lead record in the CRM. Use when the user mentions a new potential client or business opportunity.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Full name of the lead",
                },
                email: {
                    type: "string",
                    description: "Email address of the lead",
                },
                company: {
                    type: "string",
                    description: "Company the lead works for",
                },
                source: {
                    type: "string",
                    enum: ["inbound", "cold-outreach", "referral", "other"],
                    description: "How this lead was acquired",
                },
            },
            required: ["name", "email"],
        },
    },

    sendEmail: {
        name: "sendEmail",
        tier: "needs-approval",
        description:
            "Draft and send an email to a customer or lead. IMPORTANT: This tool requires human approval before sending. Always use this when the user wants to send an email.",
        parameters: {
            type: "object",
            properties: {
                to: {
                    type: "string",
                    description: "Recipient email address",
                },
                subject: {
                    type: "string",
                    description: "Email subject line",
                },
                body: {
                    type: "string",
                    description: "Full email body in plain text",
                },
            },
            required: ["to", "subject", "body"],
        },
    },
};

// Groq-compatible tool list — fed directly into the planner API call
export function getGroqTools() {
    return Object.values(TOOL_REGISTRY).map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

// Get tier for a given tool name — used by executor
export function getToolTier(name: ToolName): ToolTier {
    return TOOL_REGISTRY[name].tier;
}