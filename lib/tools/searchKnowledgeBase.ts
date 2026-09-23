import { supabase } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { ToolResult } from "@/types";

const MATCH_THRESHOLD = 0.35;
const MATCH_COUNT = 5;
const CONFIDENCE_THRESHOLD = 0.40;

function confidenceFor(similarity: number): "confident" | "weak" {
    return similarity >= CONFIDENCE_THRESHOLD ? "confident" : "weak";
}

export async function searchKnowledgeBase(args: {
    query: string;
}): Promise<ToolResult> {
    try {
        const embedding = await embed(args.query);

        const { data, error } = await supabase.rpc("match_kb_documents", {
            query_embedding: embedding,
            match_threshold: MATCH_THRESHOLD,
            match_count: MATCH_COUNT,
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
                            confidence: confidenceFor(doc.similarity),
                        })
                    ),
                },
            };
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