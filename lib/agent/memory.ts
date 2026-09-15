import Groq from "groq-sdk";
import { supabase } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { Message } from "@/types";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const MAX_SHORT_TERM_TURNS = 10;

// Compresses a segment of older messages into a short, factual summary.
// This is NOT model-invoked infrastructure (same principle as the rest of
// memory management) — it always runs, and it must never lose concrete
// details. If the summarization call itself fails OR returns empty content
// (GPT-OSS reasoning models can exhaust max_tokens on hidden reasoning
// before writing any answer — a documented Groq failure mode, silent, no
// exception), fall back to truncated raw text rather than an empty/generic
// placeholder — a degraded-but-real summary beats a silent gap in recall.
async function summarizeSegment(rawText: string): Promise<string> {
    try {
        const response = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [
                {
                    role: "system",
                    content:
                        "Summarize this conversation segment in 2-4 short factual bullet points. Preserve every concrete detail that matters for later recall: names of people/recipients, exact counts, what actions were taken and their outcomes (sent/failed/rejected). Never generalize a specific name or number into a vague phrase like 'the team' or 'several people' — list them. No preamble, just the bullets.",
                },
                { role: "user", content: rawText },
            ],
            max_tokens: 600,
            reasoning_effort: "low",
            include_reasoning: false,
        });

        const choice = response.choices[0];
        const summary = choice?.message?.content?.trim();

        if (!summary) {
            // Distinguish this from an actual API failure — the call
            // succeeded, it just came back empty (often finish_reason:
            // "length" from reasoning-token exhaustion). Logging this
            // specifically so it's diagnosable next time, instead of
            // silently blending into the same fallback as a real error.
            console.warn(
                `[memory] summarization returned empty content (finish_reason: ${choice?.finish_reason}) — falling back to raw truncation`
            );
            return rawText.slice(0, 1000);
        }

        return summary;
    } catch (err) {
        console.error("[memory] summarization call failed, falling back to raw truncation:", err);
        return rawText.slice(0, 1000);
    }
}

// Short-term: if conversation exceeds MAX_SHORT_TERM_TURNS pairs,
// compress the oldest half into a REAL summary (not a placeholder) and
// persist it. The active window always stays <= MAX_SHORT_TERM_TURNS turns.
export async function manageShortTermMemory(
    conversation_id: string,
    history: Message[]
): Promise<Message[]> {
    if (history.length <= MAX_SHORT_TERM_TURNS) return history;

    const half = Math.floor(history.length / 2);
    const toCompress = history.slice(0, half);
    const toKeep = history.slice(half);

    const rawText = toCompress
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

    const summaryText = await summarizeSegment(rawText);

    // Persistence failures here must never crash the turn — same convention
    // as trace logging elsewhere in this codebase. The compressed context
    // still needs to reach the model this turn even if the durable copy
    // fails to save.
    try {
        await supabase.from("conversation_summaries").insert({
            conversation_id,
            summary: summaryText,
            turns_covered: toCompress.length,
        });
    } catch (err) {
        console.error("[memory] failed to persist conversation summary (continuing anyway):", err);
    }

    // The notice injected into context now carries the REAL summary content,
    // not just a description that compression happened.
    const compressionNotice: Message = {
        role: "assistant",
        content: `[Summary of earlier conversation — ${toCompress.length} turns compressed]:\n${summaryText}`,
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