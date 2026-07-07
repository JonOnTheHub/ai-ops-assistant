import { supabase } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { ToolResult } from "@/types";

export async function searchKnowledgeBase(args: {
    query: string;
}): Promise<ToolResult> {
    try {
        const embedding = await embed(args.query);

        const { data, error } = await supabase.rpc("match_kb_documents", {
            query_embedding: embedding,
            match_threshold: 0.7,
            match_count: 5,
        });

        if (error) throw new Error(error.message);

        if (!data || data.length === 0) {
            return {
                success: true,
                data: {
                    results: [],
                    message: "No relevant documents found for that query.",
                },
            };
        }

        return {
            success: true,
            data: {
                results: data.map((doc: {
                    id: string;
                    content: string;
                    source: string;
                    similarity: number;
                }) => ({
                    id: doc.id,
                    content: doc.content,
                    source: doc.source,
                    similarity: doc.similarity,
                })),
            },
        };
    } catch (err) {
        return {
            success: false,
            error: `searchKnowledgeBase failed: ${String(err)}`,
        };
    }
}