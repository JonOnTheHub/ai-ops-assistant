import { supabase } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { ToolResult } from "@/types";

// A single, permissive threshold — not a cascade. The earlier cascade
// (try 0.7, then 0.5, then 0.35, stopping at the first tier with ANY
// results) had a real bug: a mediocre, broadly-relevant document could
// satisfy a mid-tier threshold on its own and cause the function to
// return immediately, silently starving out a more specific, more
// useful document that would have cleared the next looser tier
// alongside it. Concretely: agency-identity.md (broad, generic) scored
// just high enough to stop the cascade at 0.5, so retainer-policy.md
// (short, specific, the one with the actual pricing figure) never got
// a chance to appear — even though it clears 0.35 easily and had shown
// up fine in searches where agency-identity.md happened to score lower.
// One call at the loosest reasonable threshold, with match_count
// capping and similarity-ordering already doing the real quality
// control, means every genuinely relevant document gets a chance to
// surface together instead of the first lucky match blocking the rest.
const MATCH_THRESHOLD = 0.35;
const MATCH_COUNT = 5;

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