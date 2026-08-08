import { supabase } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { ToolResult } from "@/types";

// Short questions score lower similarity against longer prose than
// intuition suggests. Rather than guess one magic threshold, cascade
// through looser ones until something relevant turns up.
const THRESHOLDS = [0.7, 0.5, 0.35];

export async function searchKnowledgeBase(args: {
    query: string;
}): Promise<ToolResult> {
    try {
        const embedding = await embed(args.query);

        for (const threshold of THRESHOLDS) {
            const { data, error } = await supabase.rpc("match_kb_documents", {
                query_embedding: embedding,
                match_threshold: threshold,
                match_count: 5,
            });

            if (error) throw new Error(error.message);

            if (data && data.length > 0) {
                return {
                    success: true,
                    data: {
                        results: data.map(
                            (doc: {
                                id: string;
                                content: string;
                                source: string;
                                similarity: number;
                            }) => ({
                                id: doc.id,
                                content: doc.content,
                                source: doc.source,
                                similarity: doc.similarity,
                            })
                        ),
                    },
                };
            }
        }

        return {
            success: true,
            data: {
                results: [],
                message: "No relevant documents found for that query.",
            },
        };
    } catch (err) {
        return {
            success: false,
            error: `searchKnowledgeBase failed: ${String(err)}`,
        };
    }
}