import { supabase } from "@/lib/supabase";
import { ToolResult } from "@/types";

export async function createTask(args: {
    title: string;
    description: string;
    customer_name?: string;
}): Promise<ToolResult> {
    try {
        let related_customer_id: string | null = null;

        // If a customer name was provided, try to resolve it to an ID
        if (args.customer_name) {
            const { data: customer } = await supabase
                .from("customers")
                .select("id")
                .ilike("name", `%${args.customer_name}%`)
                .single();

            if (customer) {
                related_customer_id = customer.id;
            }
        }

        const { data: task, error } = await supabase
            .from("tasks")
            .insert({
                title: args.title,
                description: args.description,
                related_customer_id,
                status: "open",
            })
            .select()
            .single();

        if (error) throw new Error(error.message);

        return {
            success: true,
            data: { task },
        };
    } catch (err) {
        return {
            success: false,
            error: `createTask failed: ${String(err)}`,
        };
    }
}