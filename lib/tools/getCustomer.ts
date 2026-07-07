import { supabase } from "@/lib/supabase";
import { ToolResult } from "@/types";

export async function getCustomer(args: {
    query: string;
}): Promise<ToolResult> {
    try {
        // Search by name or email — ilike for case-insensitive partial match
        const { data: customers, error } = await supabase
            .from("customers")
            .select("*, leads(*), tasks(*)")
            .or(`name.ilike.%${args.query}%,email.ilike.%${args.query}%`)
            .limit(3);

        if (error) throw new Error(error.message);

        if (!customers || customers.length === 0) {
            return {
                success: true,
                data: {
                    customers: [],
                    message: `No customers found matching "${args.query}".`,
                },
            };
        }

        return {
            success: true,
            data: { customers },
        };
    } catch (err) {
        return {
            success: false,
            error: `getCustomer failed: ${String(err)}`,
        };
    }
}