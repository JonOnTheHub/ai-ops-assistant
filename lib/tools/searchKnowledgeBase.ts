import { supabase } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { ToolResult } from "@/types";

// Candidate fetch, per leg — deliberately tight. This is a candidate pool
// for fusion, not a final answer set; there's no reason to pull more rows
// (or more content) than fusion actually needs to reason about.
const CANDIDATES_PER_LEG = 10;

// Final result count returned to the model/UI after fusion.
const FINAL_COUNT = 5;

// Standard RRF constant — dampens the impact of exact rank position so a
// #1-vs-#2 difference doesn't swing the fused score wildly.
const RRF_K = 60;

// A lead this much bigger than the runner-up counts as "clearly ahead,"
// not just "technically ahead." Starting heuristic — needs validating
// against real hybrid-search data, not a derived constant.
const MARGIN_MULTIPLIER = 1.3;

// "Both legs agree" only counts as strong evidence when at least one leg's
// own raw score is at least this fraction of THAT LEG'S own #1 score — not
// just "ranked in the top N." Rank position alone can't distinguish a
// genuinely strong match from "the least-bad option in a weak field":
// real data showed full-text's own scores cliff-edge hard after rank #1-2
// (ranks 3-9 all landing around 30% of the leg's top score, essentially
// indistinguishable from each other) — a rank-based threshold let clearly
// irrelevant chunks (a waste-tolerance policy showing up "confident" for a
// tilapia-sourcing question) through just because nothing else in that
// leg's weak field matched much either. Score-ratio, not rank, is the
// real signal.
const SCORE_RATIO_THRESHOLD = 0.5;

// Terms that carry zero discriminating signal in THIS corpus specifically
// — nearly every document opens with a "Solmara Studio ..." framing
// sentence, so when a query contains the studio's own name, every
// document's generic opener scores well on both legs purely from that
// shared boilerplate, crowding out whichever chunk is actually relevant.
// Stripped only from what gets SEARCHED on, never from what the model
// sees or drafts with — this is a retrieval-quality fix, not a rewording
// of the query itself.
const KB_STOPWORDS = ["solmara", "studio"];

function stripKbStopwords(query: string): string {
    const words = query.split(/\s+/);
    const filtered = words.filter((w) => {
        const bare = w.toLowerCase().replace(/[^a-z0-9]/gi, "");
        return !KB_STOPWORDS.includes(bare);
    });
    // Never search on nothing — if stripping would leave the query empty
    // (e.g. someone literally just asks "Solmara Studio"), fall back to
    // the original text rather than sending an empty search.
    return filtered.length > 0 ? filtered.join(" ") : query;
}

interface CandidateRank {
    id: string;
    vectorRank: number | null;
    vectorScore: number | null;
    fulltextRank: number | null;
    fulltextScore: number | null;
}

function rrfScore(rank: number | null): number {
    return rank === null ? 0 : 1 / (RRF_K + rank);
}

function fuse(
    vectorRows: { id: string; similarity: number }[],
    fulltextRows: { id: string; rank: number }[]
): CandidateRank[] {
    const merged = new Map<string, CandidateRank>();

    vectorRows.forEach((r, i) => {
        merged.set(r.id, {
            id: r.id,
            vectorRank: i + 1,
            vectorScore: r.similarity,
            fulltextRank: null,
            fulltextScore: null,
        });
    });

    fulltextRows.forEach((r, i) => {
        const existing = merged.get(r.id);
        if (existing) {
            existing.fulltextRank = i + 1;
            existing.fulltextScore = r.rank;
        } else {
            merged.set(r.id, {
                id: r.id,
                vectorRank: null,
                vectorScore: null,
                fulltextRank: i + 1,
                fulltextScore: r.rank,
            });
        }
    });

    return Array.from(merged.values()).sort(
        (a, b) =>
            rrfScore(b.vectorRank) + rrfScore(b.fulltextRank) -
            (rrfScore(a.vectorRank) + rrfScore(a.fulltextRank))
    );
}

// Confidence rule: agreement between both retrieval methods is strong
// evidence ONLY when at least one leg's raw score is genuinely strong
// relative to that same leg's own best match (>= 50% of it) — not just
// "found somewhere in both top-10 lists," and not just "ranked well,"
// since rank position alone hides a flat, low-signal field. Anything
// short of that falls through to the margin check instead, same as a
// single-leg result would.
//
// Applied per-item (each result compared to its own immediate neighbor
// for the margin fallback), not just to the single top result — the
// existing Context Card UI shows a confidence dot on every card, so every
// card needs a real answer, not just the first.
//
// In degraded single-leg mode (one retrieval method unavailable), the
// both-legs-agree shortcut is structurally impossible — nothing can be
// found by both legs when only one ran — so this always falls through to
// the margin check in that case, never a false "confident."
function confidenceForIndex(
    ranked: CandidateRank[],
    index: number,
    vectorTopScore: number,
    fulltextTopScore: number
): "confident" | "weak" {
    const item = ranked[index];
    const foundByBoth = item.vectorRank !== null && item.fulltextRank !== null;

    const strongOnVector =
        item.vectorScore !== null &&
        vectorTopScore > 0 &&
        item.vectorScore >= vectorTopScore * SCORE_RATIO_THRESHOLD;

    const strongOnFulltext =
        item.fulltextScore !== null &&
        fulltextTopScore > 0 &&
        item.fulltextScore >= fulltextTopScore * SCORE_RATIO_THRESHOLD;

    if (foundByBoth) {
        // Already had its shot at strong-agreement confidence above. A
        // dual-leg match's fused RRF score is structurally guaranteed to
        // beat every single-leg match (sum of two terms vs one) —
        // even the weakest possible dual-leg hit outscores the strongest
        // possible single-leg hit. Letting a dual-leg item that FAILED
        // the strength test fall through to the margin-vs-next check
        // would just reward that structural cliff as if it were a real
        // quality signal — reintroducing "found by both" as an automatic
        // confidence booster through a different door, exactly what this
        // rule exists to prevent. Failed strength test, found by both:
        // weak, full stop.
        return strongOnVector || strongOnFulltext ? "confident" : "weak";
    }

    // Single-leg only from here — the margin-vs-next comparison is clean
    // in this branch, since it's only ever comparing within the
    // single-leg cluster, not across the dual/single-leg boundary.
    const next = ranked[index + 1];
    if (!next) return "weak";

    const itemScore = rrfScore(item.vectorRank) + rrfScore(item.fulltextRank);
    const nextScore = rrfScore(next.vectorRank) + rrfScore(next.fulltextRank);

    return itemScore >= nextScore * MARGIN_MULTIPLIER ? "confident" : "weak";
}

export async function searchKnowledgeBase(args: {
    query: string;
}): Promise<ToolResult> {
    // Vector and full-text legs run independently and degrade
    // independently — one failing (e.g. Voyage's embedding API down,
    // which has genuinely happened before) doesn't kill search entirely,
    // it just runs on whichever leg is still up.
    const [vectorResult, fulltextResult] = await Promise.allSettled([
        (async () => {
            const embedding = await embed(args.query);
            const { data, error } = await supabase.rpc("match_kb_documents_ids", {
                query_embedding: embedding,
                match_count: CANDIDATES_PER_LEG,
            });
            if (error) throw new Error(error.message);
            return (data ?? []) as { id: string; similarity: number }[];
        })(),
        (async () => {
            const { data, error } = await supabase.rpc(
                "match_kb_documents_fulltext_ids",
                {
                    query_text: args.query,
                    match_count: CANDIDATES_PER_LEG,
                }
            );
            if (error) throw new Error(error.message);
            return (data ?? []) as { id: string; rank: number }[];
        })(),
    ]);

    if (vectorResult.status === "rejected") {
        console.warn("[searchKnowledgeBase] vector leg failed, degrading to full-text only:", vectorResult.reason);
    }
    if (fulltextResult.status === "rejected") {
        console.warn("[searchKnowledgeBase] full-text leg failed, degrading to vector only:", fulltextResult.reason);
    }

    if (vectorResult.status === "rejected" && fulltextResult.status === "rejected") {
        return {
            success: false,
            error: `searchKnowledgeBase failed: both retrieval methods unavailable (vector: ${vectorResult.reason}; full-text: ${fulltextResult.reason})`,
        };
    }

    const vectorRows = vectorResult.status === "fulfilled" ? vectorResult.value : [];
    const fulltextRows = fulltextResult.status === "fulfilled" ? fulltextResult.value : [];

    const ranked = fuse(vectorRows, fulltextRows);

    if (ranked.length === 0) {
        return {
            success: true,
            data: {
                results: [],
                message: "No relevant documents found for that query.",
            },
        };
    }

    // Each leg's own #1 score, used as the denominator for the strength
    // ratio above — deliberately each leg's own top, not compared across
    // legs (vector's cosine similarity and full-text's ts_rank live on
    // completely different, incomparable scales).
    const vectorTopScore = vectorRows[0]?.similarity ?? 0;
    const fulltextTopScore = fulltextRows[0]?.rank ?? 0;

    const winners = ranked.slice(0, FINAL_COUNT);
    const winnerIds = winners.map((w) => w.id);

    // Content is only ever fetched for the chunks that actually survived
    // fusion — never for every candidate pulled during retrieval.
    const { data: contentRows, error: contentError } = await supabase
        .from("kb_documents")
        .select("id, content, source")
        .in("id", winnerIds);

    if (contentError) {
        return {
            success: false,
            error: `searchKnowledgeBase failed to fetch content for winners: ${contentError.message}`,
        };
    }

    const contentById = new Map(
        (contentRows ?? []).map((row) => [row.id, row])
    );

    const results = winners
        .map((w, i) => {
            const row = contentById.get(w.id);
            if (!row) return null;
            return {
                id: row.id,
                content: row.content,
                source: row.source,
                confidence: confidenceForIndex(winners, i, vectorTopScore, fulltextTopScore),
                foundBy:
                    w.vectorRank !== null && w.fulltextRank !== null
                        ? "both"
                        : w.vectorRank !== null
                            ? "vector"
                            : "fulltext",
            };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

    return {
        success: true,
        data: { results },
    };
}