import { supabase } from "@/lib/supabase";
import {
    fetchCandidates,
    confidenceForIndex,
    FINAL_COUNT,
    isLowConfidence,
    MIN_VECTOR_TOP_SCORE,
    DUAL_LEG_VECTOR_RATIO,
} from "@/lib/tools/searchKnowledgeBase";

// Self-serve hybrid-search diagnostic. It runs the REAL pipeline: it calls the
// same fetchCandidates and confidenceForIndex that searchKnowledgeBase uses, so
// what it prints is what chat does. (It used to keep its own copy of the
// pipeline, and the copy drifted: the copy stripped the corpus stopwords while
// the real search didn't, so this script reported healthy retrieval while chat
// searched on the raw query.)
//
// Shows which leg(s) found each candidate, their raw score as a percentage of
// that leg's own #1 score, the fused RRF score, and the confidence label the
// app would show. Only the top FINAL_COUNT candidates are actually returned to
// the app; the rest are shown for context and marked as not returned.
//
// Usage:
//   npx dotenv -e .env.local -- npx tsx scripts/debug-retrieval.ts "your query here"

function rrfScore(rank: number | null): number {
    return rank === null ? 0 : 1 / (60 + rank);
}

async function debugRetrieval() {
    const query = process.argv[2];

    if (!query) {
        console.error('Usage: npx tsx scripts/debug-retrieval.ts "your query here"');
        process.exit(1);
    }

    console.log(`Query: "${query}"`);
    console.log("Embedding + fetching both legs...\n");

    const pool = await fetchCandidates(query);

    if (pool.searchQuery !== query) {
        console.log(`Searched as: "${pool.searchQuery}" (KB stopwords stripped)\n`);
    }

    if (pool.vectorFailed) console.log(`⚠ Vector leg FAILED: ${pool.vectorError}\n`);
    if (pool.fulltextFailed) console.log(`⚠ Full-text leg FAILED: ${pool.fulltextError}\n`);
    if (pool.vectorFailed && pool.fulltextFailed) {
        console.log("Both legs failed — nothing to show.");
        return;
    }

    const { vectorRows, fulltextRows, ranked, vectorTopScore, fulltextTopScore } = pool;

    console.log(`Vector leg: ${vectorRows.length} candidate(s)`);
    console.log(`Full-text leg: ${fulltextRows.length} candidate(s)\n`);

    if (ranked.length === 0) {
        console.log("No candidates from either leg.");
        return;
    }

    console.log(`Vector leg's own #1 score: ${vectorTopScore.toFixed(4)}`);
    console.log(`Full-text leg's own #1 score: ${fulltextTopScore.toFixed(4)}\n`);

    const { data: rows, error: contentError } = await supabase
        .from("kb_documents")
        .select("id, content, source")
        .in("id", ranked.map((c) => c.id));

    if (contentError) {
        console.error("Failed to fetch content:", contentError.message);
        return;
    }

    const contentById = new Map((rows ?? []).map((r) => [r.id, r]));
    const winners = ranked.slice(0, FINAL_COUNT);
    const lowConfidence = isLowConfidence(vectorRows.length, vectorTopScore);

    if (lowConfidence) {
        console.log(`LOW CONFIDENCE: best vector similarity ${vectorTopScore.toFixed(4)} is under the ${MIN_VECTOR_TOP_SCORE} floor,`);
        console.log("so every returned result is labeled WEAK and the planner is told the matches are poor.\n");
    }

    console.log(`${ranked.length} unique candidate(s) after fusion, ranked (top ${FINAL_COUNT} are returned to the app):\n`);

    ranked.forEach((c, i) => {
        const row = contentById.get(c.id);
        const source = row?.source ?? "?";
        const content: string = row?.content ?? "";
        const fused = rrfScore(c.vectorRank) + rrfScore(c.fulltextRank);
        const foundByBoth = c.vectorRank !== null && c.fulltextRank !== null;

        let label: string;
        if (i >= FINAL_COUNT) {
            label = "not returned";
        } else if (lowConfidence) {
            label = "WEAK (below the absolute floor)";
        } else {
            // Exactly what the app computes: over the winners, per item.
            const confidence = confidenceForIndex(winners, i, vectorTopScore);
            label =
                confidence === "weak"
                    ? "WEAK"
                    : foundByBoth
                        ? `CONFIDENT (both legs, vector within ${Math.round(DUAL_LEG_VECTOR_RATIO * 100)}% of best)`
                        : "CONFIDENT (clear margin)";
        }

        const vectorPct =
            c.vectorScore !== null && vectorTopScore > 0
                ? `${((c.vectorScore / vectorTopScore) * 100).toFixed(0)}% of leg's #1`
                : "—";
        const fulltextPct =
            c.fulltextScore !== null && fulltextTopScore > 0
                ? `${((c.fulltextScore / fulltextTopScore) * 100).toFixed(0)}% of leg's #1`
                : "—";

        const legs =
            c.vectorRank !== null && c.fulltextRank !== null
                ? `vector #${c.vectorRank} (${vectorPct}), fulltext #${c.fulltextRank} (${fulltextPct})`
                : c.vectorRank !== null
                    ? `vector #${c.vectorRank} (${vectorPct}) only`
                    : `fulltext #${c.fulltextRank} (${fulltextPct}) only`;

        console.log(`${fused.toFixed(5)}  [${label}]  ${source}`);
        console.log(`         ${legs}`);
        console.log(`         "${content.slice(0, 100).trim()}${content.length > 100 ? "…" : ""}"`);
        console.log("");
    });
}

debugRetrieval();