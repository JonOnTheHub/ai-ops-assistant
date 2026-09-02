import { supabase } from "@/lib/supabase";
import { ToolResult, BroadcastRecipient } from "@/types";

export async function resolveAudience(args: {
    targetType: "employees" | "customers";
    includeRoles?: string[];
    excludeNames?: string[];
    query?: string;
}): Promise<ToolResult> {
    try {
        const isEmployees = args.targetType === "employees";
        const table = isEmployees ? "employees" : "customers";
        const groupColumn = isEmployees ? "role" : "company";

        let queryBuilder = supabase.from(table).select(`name, email, ${groupColumn}`);

        if (isEmployees && args.includeRoles && args.includeRoles.length > 0) {
            queryBuilder = queryBuilder.in("role", args.includeRoles);
        }

        if (args.query) {
            queryBuilder = queryBuilder.ilike("name", `%${args.query}%`);
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

        if (args.excludeNames && args.excludeNames.length > 0) {
            const excluded = args.excludeNames.map((n) => n.toLowerCase().trim());
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