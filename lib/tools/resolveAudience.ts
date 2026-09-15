import { supabase } from "@/lib/supabase";
import { ToolResult, BroadcastRecipient } from "@/types";

export async function resolveAudience(args: {
    targetType: "employees" | "customers";
    includeRoles?: string[] | null;
    excludeNames?: string[] | null;
    query?: string | null;
}): Promise<ToolResult> {

    try {
        // Some models pass explicit null for an omitted optional param instead
        // of leaving the key out (openai/gpt-oss-120b does this sometimes,
        // which previously caused a Groq schema-validation 400 before this
        // was normalized here and loosened in the tool's registered schema).
        // Normalize defensively so a schema quirk from any future model
        // doesn't turn into a runtime crash here either.
        const includeRoles = args.includeRoles ?? undefined;
        const excludeNames = args.excludeNames ?? undefined;
        const query = args.query ?? undefined;

        const isEmployees = args.targetType === "employees";
        const table = isEmployees ? "employees" : "customers";
        const groupColumn = isEmployees ? "role" : "company";

        let queryBuilder = supabase.from(table).select(`name, email, ${groupColumn}`);

        if (isEmployees && includeRoles && includeRoles.length > 0) {
            queryBuilder = queryBuilder.in("role", includeRoles);
        }

        if (query) {
            queryBuilder = queryBuilder.ilike("name", `%${query}%`);
        }

        const { data, error } = await queryBuilder;

        if (error) throw new Error(error.message);

        let recipients = (data ?? []).map((row) => {
            const record = row as Record<string, unknown>;
            return {
                name: record.name as string,
                email: record.email as string,
                role: (isEmployees ? record.role : record.company) as string | undefined,
            };
        }) as BroadcastRecipient[];

        if (excludeNames && excludeNames.length > 0) {
            const excluded = excludeNames.map((n) => n.toLowerCase().trim());
            recipients = recipients.filter((r) => {
                const name = r.name.toLowerCase();
                // Substring match first (handles first-name-only exclusions like
                // "Steven" matching "Steven Ulich"), which also covers exact
                // equality as a special case — a full match is just a substring
                // that happens to span the whole string.
                return !excluded.some((ex) => name.includes(ex) || ex.includes(name));
            });
        }

        if (recipients.length === 0) {
            return {
                success: true,
                data: {
                    recipients: [],
                    count: 0,
                    message: `No ${args.targetType} matched those filters.`,
                },
            };
        }

        return {
            success: true,
            data: {
                recipients,
                count: recipients.length,
            },
        };
    } catch (err) {
        return {
            success: false,
            error: `resolveAudience failed: ${String(err)}`,
        };
    }
}