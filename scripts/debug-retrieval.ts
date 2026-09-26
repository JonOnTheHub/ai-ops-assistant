import { createClient } from "@supabase/supabase-js";
import { embed } from "@/lib/embeddings";

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CANDIDATES_PER_LEG = 10;
const RRF_K = 60;
const MARGIN_MULTIPLIER = 1.3;
const SCORE_RATIO_THRESHOLD = 0.5;
const KB_STOPWORDS = ["solmara", "studio"];

function stripKbStopwords(query: string): string {
    const words = query.split(/\s+/);
    const filtered = words.filter((w) => {
        const bare = w.toLowerCase().replace(/[^a-z0-9]/gi, "");
        return !KB_STOPWORDS.includes(bare);
    });
    return filtered.length > 0 ? filtered.join(" ") : query;
}

// Self-serve hybrid-search diagnostic. Mirrors the real pipeline in
// searchKnowledgeBase.ts exactly (same constants, same fusion logic, same
// score-ratio confidence rule) — shows the full working: which leg(s)
// found each candidate, their raw score as a percentage of that leg's own
// #1 score, the fused RRF score, and the confidence label that would
// result.
//
// Usage:
//   npx dotenv -e .env.local -- npx tsx scripts/debug-retrieval.ts "your query here"

interface CandidateRank {
    id: string;
    source: string;
    content: string;
    vectorRank: number | null;
    vectorScore: number | null;
    fulltextRank: number | null;
    fulltextScore: number | null;
}

function rrfScore(rank: number | null): number {
    return rank === null ? 0 : 1 / (RRF_K + rank);
}

async function debugRetrieval() {
    const query = process.argv[2];

    if (!query) {
        console.error('Usage: npx tsx scripts/debug-retrieval.ts "your query here"');
        process.exit(1);
    }

    console.log(`Query: "${query}"`);

    const searchQuery = stripKbStopwords(query);
    if (searchQuery !== query) {
        console.log(`Searched as: "${searchQuery}" (KB stopwords stripped)`);
    }
    console.log("Embedding + fetching both legs...\n");

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
                { query_text: searchQuery, match_count: CANDIDATES_PER_LEG }
            );
            if (error) throw new Error(error.message);
            return (data ?? []) as { id: string; rank: number }[];
        })(),
    ]);

    if (vectorResult.status === "rejected") {
        console.log(`⚠ Vector leg FAILED: ${vectorResult.reason}\n`);
    }
    if (fulltextResult.status === "rejected") {
        console.log(`⚠ Full-text leg FAILED: ${fulltextResult.reason}\n`);
    }
    if (vectorResult.status === "rejected" && fulltextResult.status === "rejected") {
        console.log("Both legs failed — nothing to show.");
        return;
    }

    const vectorRows = vectorResult.status === "fulfilled" ? vectorResult.value : [];
    const fulltextRows = fulltextResult.status === "fulfilled" ? fulltextResult.value : [];

    console.log(`Vector leg: ${vectorRows.length} candidate(s)`);
    console.log(`Full-text leg: ${fulltextRows.length} candidate(s)\n`);

    if (vectorRows.length === 0 && fulltextRows.length === 0) {
        console.log("No candidates from either leg.");
        return;
    }

    const vectorTopScore = vectorRows[0]?.similarity ?? 0;
    const fulltextTopScore = fulltextRows[0]?.rank ?? 0;

    console.log(`Vector leg's own #1 score: ${vectorTopScore.toFixed(4)}`);
    console.log(`Full-text leg's own #1 score: ${fulltextTopScore.toFixed(4)}\n`);

    const allIds = Array.from(
        new Set([...vectorRows.map((r) => r.id), ...fulltextRows.map((r) => r.id)])
    );
    const { data: rows, error: contentError } = await supabase
        .from("kb_documents")
        .select("id, content, source")
        .in("id", allIds);

    if (contentError) {
        console.error("Failed to fetch content:", contentError.message);
        return;
    }

    const contentById = new Map((rows ?? []).map((r) => [r.id, r]));

    const merged = new Map<string, CandidateRank>();
    vectorRows.forEach((r, i) => {
        const row = contentById.get(r.id);
        merged.set(r.id, {
            id: r.id,
            source: row?.source ?? "?",
            content: row?.content ?? "",
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
            const row = contentById.get(r.id);
            merged.set(r.id, {
                id: r.id,
                source: row?.source ?? "?",
                content: row?.content ?? "",
                vectorRank: null,
                vectorScore: null,
                fulltextRank: i + 1,
                fulltextScore: r.rank,
            });
        }
    });

    const ranked = Array.from(merged.values()).sort(
        (a, b) =>
            rrfScore(b.vectorRank) + rrfScore(b.fulltextRank) -
            (rrfScore(a.vectorRank) + rrfScore(a.fulltextRank))
    );

    console.log(`${ranked.length} unique candidate(s) after fusion, ranked:\n`);

    ranked.forEach((c, i) => {
        const fused = rrfScore(c.vectorRank) + rrfScore(c.fulltextRank);
        const foundByBoth = c.vectorRank !== null && c.fulltextRank !== null;

        const strongOnVector =
            c.vectorScore !== null &&
            vectorTopScore > 0 &&
            c.vectorScore >= vectorTopScore * SCORE_RATIO_THRESHOLD;
        const strongOnFulltext =
            c.fulltextScore !== null &&
            fulltextTopScore > 0 &&
            c.fulltextScore >= fulltextTopScore * SCORE_RATIO_THRESHOLD;

        // A dual-leg item gets exactly one shot at confidence (the
        // strength test) — it never falls through to the margin check,
        // since dual-leg fused scores structurally always beat single-leg
        // ones regardless of individual leg quality, which would let a
        // failed dual-leg item get rescued by that same structural cliff.
        let confidence: string;
        if (foundByBoth) {
            confidence = strongOnVector || strongOnFulltext
                ? "CONFIDENT (score-ratio agreement)"
                : "WEAK";
        } else {
            const next = ranked[i + 1];
            const nextFused = next ? rrfScore(next.vectorRank) + rrfScore(next.fulltextRank) : 0;
            confidence = next && fused >= nextFused * MARGIN_MULTIPLIER
                ? "CONFIDENT (clear margin)"
                : "WEAK";
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

        console.log(`${fused.toFixed(5)}  [${confidence}]  ${c.source}`);
        console.log(`         ${legs}`);
        console.log(`         "${c.content.slice(0, 100).trim()}${c.content.length > 100 ? "…" : ""}"`);
        console.log("");
    });
}

debugRetrieval();