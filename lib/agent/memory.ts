import { supabase } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { Message } from "@/types";

const MAX_SHORT_TERM_TURNS = 10;

// Short-term: if conversation exceeds MAX_SHORT_TERM_TURNS pairs,
// compress the oldest half into a summary and persist it.
// The active window always stays <= MAX_SHORT_TERM_TURNS turns.
export async function manageShortTermMemory(
    conversation_id: string,
    history: Message[]
): Promise<Message[]> {
    if (history.length <= MAX_SHORT_TERM_TURNS) return history;

    const half = Math.floor(history.length / 2);
    const toCompress = history.slice(0, half);
    const toKeep = history.slice(half);

    const summaryText = toCompress
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

    await supabase.from("conversation_summaries").insert({
        conversation_id,
        summary: summaryText,
        turns_covered: toCompress.length,
    });

    // Prepend a synthetic system message so the model knows context was compressed
    const compressionNotice: Message = {
        role: "assistant",
        content: `[Earlier conversation compressed. Summary: ${toCompress.length} turns covering earlier context.]`,
    };

    return [compressionNotice, ...toKeep];
}

// Long-term: write a durable fact learned from this conversation
export async function writeLongTermMemory(
    fact: string,
    customer_id?: string
): Promise<void> {
    try {
        const embedding = await embed(fact);

        await supabase.from("long_term_memory").insert({
            fact,
            embedding,
            customer_id: customer_id ?? null,
        });
    } catch (err) {
        console.error("[memory] long-term write failed:", err);
    }
}

// Long-term: retrieve relevant facts for the current user message
export async function recallLongTermMemory(
    query: string
): Promise<string[]> {
    try {
        const embedding = await embed(query);

        const { data, error } = await supabase.rpc("match_long_term_memory", {
            query_embedding: embedding,
            match_threshold: 0.6,
            match_count: 5,
        });

        if (error || !data) return [];

        return data.map((row: { fact: string }) => row.fact);
    } catch (err) {
        console.error("[memory] long-term recall failed:", err);
        return [];
    }
}