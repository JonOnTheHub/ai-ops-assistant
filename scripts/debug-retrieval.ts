import { createClient } from "@supabase/supabase-js";
import { embed } from "@/lib/embeddings";

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Self-serve retrieval diagnostic. Bypasses match_threshold entirely —
// shows the raw similarity score for EVERY chunk in kb_documents against
// a test query, ranked, so you can see exactly what's close-but-under
// threshold versus genuinely far off, without needing to hand-craft SQL
// with a pasted embedding vector.
//
// Usage:
//   npx dotenv -e .env.local -- npx tsx scripts/debug-retrieval.ts "your query here"

async function debugRetrieval() {
    const query = process.argv[2];

    if (!query) {
        console.error('Usage: npx tsx scripts/debug-retrieval.ts "your query here"');
        process.exit(1);
    }

    console.log(`Query: "${query}"`);
    console.log("Embedding...");

    const queryEmbedding = await embed(query);

    // match_threshold: 0 and a generous match_count means this returns
    // every chunk, ranked by raw similarity, regardless of your app's
    // actual CONFIDENCE_THRESHOLD or MATCH_THRESHOLD.
    const { data, error } = await supabase.rpc("match_kb_documents", {
        query_embedding: queryEmbedding,
        match_threshold: 0,
        match_count: 50,
    });

    if (error) {
        console.error("Query failed:", error.message);
        return;
    }

    if (!data || data.length === 0) {
        console.log("No chunks in kb_documents at all — table may be empty.");
        return;
    }

    console.log(`\n${data.length} chunk(s), ranked by raw similarity:\n`);

    for (const doc of data as {
        source: string;
        content: string;
        similarity: number;
    }[]) {
        const band =
            doc.similarity >= 0.45
                ? "CONFIDENT"
                : doc.similarity >= 0.35
                    ? "WEAK (shown)"
                    : "below floor (never shown)";

        console.log(
            `${doc.similarity.toFixed(4)}  [${band}]  ${doc.source}`
        );
        console.log(`         "${doc.content.slice(0, 100).trim()}${doc.content.length > 100 ? "…" : ""}"`);
        console.log("");
    }
}

debugRetrieval();