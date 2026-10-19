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
async function summarizeSegment(rawText: string, fallbackText: string = rawText): Promise<string> {
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
            return fallbackText.slice(0, 1000);
        }

        return summary;
    } catch (err) {
        console.error("[memory] summarization call failed, falling back to raw truncation:", err);
        return fallbackText.slice(0, 1000);
    }
}

// Short-term memory, incremental.
//
// The browser sends the WHOLE conversation on every request, and the compressed
// version only ever goes to the model, never back to the browser. So this has
// to remember how much of the conversation is already summarized, or it
// re-summarizes the same messages on every single turn (it used to: one extra
// LLM call and one new conversation_summaries row per turn, and a window that
// grew without bound).
//
// conversation_summaries is that memory. A row's summary covers the first
// `turns_covered` messages of the conversation, and the newest row is the one
// with the largest turns_covered. Rows written by the older version mean the
// same thing, so they carry over.
//
// Per request:
//   - messages [0, covered) are represented by the stored summary,
//   - messages [covered, n) are the live window, sent to the model verbatim,
//   - only when the live window grows past MAX_SHORT_TERM_TURNS is its oldest
//     half folded into the summary: one LLM call, one new row.
export interface CompressionState {
    summary: string;
    turnsCovered: number;
    // True only on the request that actually wrote a new summary.
    newlyCompressed: boolean;
}

export interface ShortTermMemory {
    // What the model sees: the summary notice (if any) plus the live window.
    history: Message[];
    compression: CompressionState | null;
}

function summaryNotice(summary: string, covered: number): Message {
    return {
        role: "assistant",
        content: `[Summary of earlier conversation — ${covered} turns compressed]:\n${summary}`,
    };
}

// The newest stored summary for this conversation, or null. A failed read
// degrades to "no summary yet" (the history we were sent is still complete),
// never to a crashed turn.
async function loadLatestSummary(
    conversation_id: string
): Promise<{ summary: string; covered: number } | null> {
    try {
        const { data, error } = await supabase
            .from("conversation_summaries")
            .select("summary, turns_covered")
            .eq("conversation_id", conversation_id)
            .order("turns_covered", { ascending: false })
            .limit(1);

        if (error) {
            console.error("[memory] failed to load stored summary (continuing without it):", error);
            return null;
        }

        const row = data?.[0] as { summary?: unknown; turns_covered?: unknown } | undefined;
        if (!row || typeof row.summary !== "string" || typeof row.turns_covered !== "number") {
            return null;
        }

        return { summary: row.summary, covered: row.turns_covered };
    } catch (err) {
        console.error("[memory] failed to load stored summary (continuing without it):", err);
        return null;
    }
}

export async function manageShortTermMemory(
    conversation_id: string,
    history: Message[]
): Promise<ShortTermMemory> {
    // Short enough that nothing needs summarizing, and skips the DB read.
    if (history.length <= MAX_SHORT_TERM_TURNS) {
        return { history, compression: null };
    }

    const stored = await loadLatestSummary(conversation_id);
    let covered = stored?.covered ?? 0;
    let summary = stored?.summary ?? null;

    // A summary that claims to cover more messages than we were sent can't be
    // matched to this history, so don't use it.
    if (covered > history.length) {
        console.warn(
            `[memory] stored summary covers ${covered} messages but only ${history.length} were sent — ignoring it`
        );
        covered = 0;
        summary = null;
    }

    const live = history.slice(covered);

    if (live.length <= MAX_SHORT_TERM_TURNS) {
        if (!summary) return { history: live, compression: null };
        return {
            history: [summaryNotice(summary, covered), ...live],
            compression: { summary, turnsCovered: covered, newlyCompressed: false },
        };
    }

    // The live window overflowed: fold its oldest half into the summary.
    const half = Math.floor(live.length / 2);
    const segment = live.slice(0, half);
    const keep = live.slice(half);

    const segmentText = segment.map((m) => `${m.role}: ${m.content}`).join("\n");
    const rawText = summary
        ? `[Summary of even earlier conversation]: ${summary}\n${segmentText}`
        : segmentText;

    // If summarization degrades to raw truncation, keep a slice of BOTH the old
    // summary and the new segment, so neither silently disappears.
    const fallbackText = summary ? `${summary.slice(0, 400)}\n${segmentText}` : segmentText;

    const newSummary = await summarizeSegment(rawText, fallbackText);
    const newCovered = covered + half;

    // Persistence failures here must never crash the turn — same convention
    // as trace logging elsewhere in this codebase. The compressed context
    // still reaches the model this turn even if the durable copy fails to save
    // (the next turn will simply redo the work).
    try {
        const { error } = await supabase.from("conversation_summaries").insert({
            conversation_id,
            summary: newSummary,
            turns_covered: newCovered,
        });
        if (error) {
            console.error("[memory] failed to persist conversation summary (continuing anyway):", error);
        }
    } catch (err) {
        console.error("[memory] failed to persist conversation summary (continuing anyway):", err);
    }

    return {
        history: [summaryNotice(newSummary, newCovered), ...keep],
        compression: { summary: newSummary, turnsCovered: newCovered, newlyCompressed: true },
    };
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