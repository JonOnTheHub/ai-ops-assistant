import { supabase } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { ToolResult } from "@/types";

// Candidate fetch, per leg — deliberately tight. This is a candidate pool
// for fusion, not a final answer set; there's no reason to pull more rows
// (or more content) than fusion actually needs to reason about.
export const CANDIDATES_PER_LEG = 10;

// Final result count returned to the model/UI after fusion.
export const FINAL_COUNT = 5;

// Standard RRF constant — dampens the impact of exact rank position so a
// #1-vs-#2 difference doesn't swing the fused score wildly.
export const RRF_K = 60;

// A lead this much bigger than the runner-up counts as "clearly ahead,"
// not just "technically ahead." Starting heuristic — needs validating
// against real hybrid-search data, not a derived constant.
export const MARGIN_MULTIPLIER = 1.3;

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
// Dual-leg confidence: a chunk both legs found is "confident" only if its raw
// vector similarity is within this fraction of the best vector match. Chosen
// from a 21-query labeled calibration run (scripts/calibrate-confidence.ts):
// on 101 scored results the old rule (either leg >= 50% of its own #1) called
// 56 irrelevant results confident, 31% precision. The full-text ratio is left
// out on purpose: ts_rank scores tie at 100% for many unrelated chunks on short
// queries, so it inflated "strength". Vector >= 90% and found by both legs
// reached 95% precision at 84% recall; 80% gives 83% / 96%. Precision wins
// here: a solid dot on an irrelevant card is a false claim, while a hollow dot
// on a relevant card only understates.
export const DUAL_LEG_VECTOR_RATIO = 0.9;

// Absolute floors on the BEST raw vector similarity. Ratios are relative to the
// pool's own #1, so the top result is always 100% of itself and the ratio rule
// can never say "nothing here is any good". Raw scores can, but no single
// number separates everything. Measured on 23 labeled queries (Oct 26):
//   unanswerable: 0.169 and 0.191 (off-topic), 0.337 (on-topic but absent)
//   answerable:   0.312 ("fuel") and 0.317 ("imported ingredients approval"),
//                 then 0.404 and up
// Terse answerable queries score BELOW the on-topic-but-absent one, so the two
// tiers exist because the errors are not equally costly:
//   below MIN (0.30)       "poor": nothing here is a match. Every result is
//                          weak and the model is told so. Below every answerable
//                          query measured, so it never wrongly denies one.
//   MIN to DOUBTFUL (0.35) "doubtful": every result is weak, but the model is NOT
//                          told to deny anything. A hollow dot on a good result
//                          only understates; a solid dot on an irrelevant one is
//                          a false claim; and forcing "the KB doesn't cover it"
//                          onto a terse answerable query would be a wrong answer.
// Re-check both with scripts/calibrate-confidence.ts, which prints the raw best
// score of every query and what each band would do.
export const MIN_VECTOR_TOP_SCORE = 0.3;
export const DOUBTFUL_VECTOR_TOP_SCORE = 0.35;

// Terms that carry zero discriminating signal in THIS corpus specifically
// — nearly every document opens with a "Solmara Studio ..." framing
// sentence, so when a query contains the studio's own name, every
// document's generic opener scores well on both legs purely from that
// shared boilerplate, crowding out whichever chunk is actually relevant.
// Stripped only from what gets SEARCHED on, never from what the model
// sees or drafts with — this is a retrieval-quality fix, not a rewording
// of the query itself.
const KB_STOPWORDS = ["solmara", "studio"];

export function stripKbStopwords(query: string): string {
    const words = query.split(/\s+/);
    const filtered = words.filter((w) => {
        // "studio's" and "Solmara’s" are the same boilerplate word with a possessive
        // on the end; dropping the apostrophe alone would leave "studios".
        const bare = w.toLowerCase().replace(/['’]s$/, "").replace(/[^a-z0-9]/gi, "");
        return !KB_STOPWORDS.includes(bare);
    });
    // Never search on nothing — if stripping would leave the query empty
    // (e.g. someone literally just asks "Solmara Studio"), fall back to
    // the original text rather than sending an empty search.
    return filtered.length > 0 ? filtered.join(" ") : query;
}

export interface CandidateRank {
    id: string;
    vectorRank: number | null;
    vectorScore: number | null;
    fulltextRank: number | null;
    fulltextScore: number | null;
}

function rrfScore(rank: number | null): number {
    return rank === null ? 0 : 1 / (RRF_K + rank);
}

export function fuse(
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

// How much to trust the best match at all. Only judged when the vector leg
// actually ran: with it down there is no raw similarity to judge, and "no
// information" must not read as "no match".
export function retrievalQuality(vectorRowCount: number, vectorTopScore: number): "poor" | "doubtful" | "ok" {
    if (vectorRowCount === 0) return "ok";
    if (vectorTopScore < MIN_VECTOR_TOP_SCORE) return "poor";
    if (vectorTopScore < DOUBTFUL_VECTOR_TOP_SCORE) return "doubtful";
    return "ok";
}

// Per-item confidence label, shown as a dot on every context card.
//
// Found by both legs: confident only if its vector similarity is within
// DUAL_LEG_VECTOR_RATIO of the best vector match. A dual-leg item that fails
// is weak, full stop: its fused RRF score always beats every single-leg item
// (two terms against one), so letting it fall through to the margin check
// would reward that structural cliff as if it were quality.
//
// Found by one leg only: confident only with a clear fused-score margin over
// the next result. That comparison is clean here because it only ever looks
// within the single-leg cluster. In degraded single-leg mode (one retrieval
// method down) nothing can be found by both legs, so this never produces a
// false "confident" from the both-legs branch.
export function confidenceForIndex(
    ranked: CandidateRank[],
    index: number,
    vectorTopScore: number
): "confident" | "weak" {
    const item = ranked[index];
    const foundByBoth = item.vectorRank !== null && item.fulltextRank !== null;

    if (foundByBoth) {
        const strongOnVector =
            item.vectorScore !== null &&
            vectorTopScore > 0 &&
            item.vectorScore >= vectorTopScore * DUAL_LEG_VECTOR_RATIO;
        return strongOnVector ? "confident" : "weak";
    }

    const next = ranked[index + 1];
    if (!next) return "weak";

    const itemScore = rrfScore(item.vectorRank) + rrfScore(item.fulltextRank);
    const nextScore = rrfScore(next.vectorRank) + rrfScore(next.fulltextRank);

    return itemScore >= nextScore * MARGIN_MULTIPLIER ? "confident" : "weak";
}

export interface CandidatePool {
    // What both legs actually searched on, after stopword stripping.
    searchQuery: string;
    vectorRows: { id: string; similarity: number }[];
    fulltextRows: { id: string; rank: number }[];
    ranked: CandidateRank[];
    // Each leg's own #1 score, used as the denominator for the strength
    // ratio above: deliberately each leg's own top, never compared across
    // legs (vector's cosine similarity and full-text's ts_rank live on
    // completely different, incomparable scales).
    vectorTopScore: number;
    fulltextTopScore: number;
    vectorFailed: boolean;
    fulltextFailed: boolean;
    vectorError: unknown;
    fulltextError: unknown;
}

// The ONE place both retrieval legs are run. searchKnowledgeBase, the debug
// script and the calibration script all go through here, so a diagnostic can
// never again disagree with production: the stopword stripper used to exist
// in the debug script and in this file, but only the debug script called it,
// so it reported healthy retrieval while chat searched on the raw query.
export async function fetchCandidates(query: string): Promise<CandidatePool> {
    const searchQuery = stripKbStopwords(query);

    // Vector and full-text legs run independently and degrade
    // independently: one failing (e.g. Voyage's embedding API down, which
    // has genuinely happened before) doesn't kill search entirely, it just
    // runs on whichever leg is still up.
    const [vectorResult, fulltextResult] = await Promise.allSettled([
        (async () => {
            const embedding = await embed(searchQuery);
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
                    query_text: searchQuery,
                    match_count: CANDIDATES_PER_LEG,
                }
            );
            if (error) throw new Error(error.message);
            return (data ?? []) as { id: string; rank: number }[];
        })(),
    ]);

    const vectorRows = vectorResult.status === "fulfilled" ? vectorResult.value : [];
    const fulltextRows = fulltextResult.status === "fulfilled" ? fulltextResult.value : [];

    return {
        searchQuery,
        vectorRows,
        fulltextRows,
        ranked: fuse(vectorRows, fulltextRows),
        vectorTopScore: vectorRows[0]?.similarity ?? 0,
        fulltextTopScore: fulltextRows[0]?.rank ?? 0,
        vectorFailed: vectorResult.status === "rejected",
        fulltextFailed: fulltextResult.status === "rejected",
        vectorError: vectorResult.status === "rejected" ? vectorResult.reason : null,
        fulltextError: fulltextResult.status === "rejected" ? fulltextResult.reason : null,
    };
}

export async function searchKnowledgeBase(args: {
    query: string;
}): Promise<ToolResult> {
    const pool = await fetchCandidates(args.query);

    if (pool.vectorFailed) {
        console.warn("[searchKnowledgeBase] vector leg failed, degrading to full-text only:", pool.vectorError);
    }
    if (pool.fulltextFailed) {
        console.warn("[searchKnowledgeBase] full-text leg failed, degrading to vector only:", pool.fulltextError);
    }

    if (pool.vectorFailed && pool.fulltextFailed) {
        return {
            success: false,
            error: `searchKnowledgeBase failed: both retrieval methods unavailable (vector: ${pool.vectorError}; full-text: ${pool.fulltextError})`,
        };
    }

    const { ranked, vectorTopScore } = pool;
    const quality = retrievalQuality(pool.vectorRows.length, vectorTopScore);
    const lowConfidence = quality === "poor";

    if (ranked.length === 0) {
        return {
            success: true,
            data: {
                results: [],
                message: "No relevant documents found for that query.",
            },
        };
    }

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
                confidence: quality !== "ok" ? "weak" : confidenceForIndex(winners, i, vectorTopScore),
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
        data: {
            results,
            // The model reads this. Without it, five solid-looking cards for a
            // question the KB doesn't cover invite an answer built from nothing.
            ...(lowConfidence
                ? {
                    lowConfidence: true,
                    note: `The closest matches are weak: the best similarity is ${vectorTopScore.toFixed(2)}, under the ${MIN_VECTOR_TOP_SCORE} floor. They probably don't answer the question. Use one only if it clearly does; otherwise say the knowledge base doesn't appear to cover it.`,
                }
                : {}),
        },
    };
}