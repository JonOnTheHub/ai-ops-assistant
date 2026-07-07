import { supabase } from "@/lib/supabase";
import { ToolResult } from "@/types";

export async function createLead(args: {
    name: string;
    email: string;
    company?: string;
    source?: "inbound" | "cold-outreach" | "referral" | "other";
}): Promise<ToolResult> {
    try {
        // Check if lead already exists by email
        const { data: existing } = await supabase
            .from("leads")
            .select("id, status")
            .eq("email", args.email)
            .single();

        if (existing) {
            return {
                success: true,
                data: {
                    lead: existing,
                    message: `Lead with email ${args.email} already exists (status: ${existing.status}). Returning existing record.`,
                },
            };
        }

        const { data: lead, error } = await supabase
            .from("leads")
            .insert({
                name: args.name,
                email: args.email,
                company: args.company ?? null,
                source: args.source ?? "inbound",
                status: "new",
            })
            .select()
            .single();

        if (error) throw new Error(error.message);

        return {
            success: true,
            data: { lead },
        };
    } catch (err) {
        return {
            success: false,
            error: `createLead failed: ${String(err)}`,
        };
    }
}