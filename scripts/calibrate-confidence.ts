import { supabase } from "@/lib/supabase";
import { fetchCandidates, confidenceForIndex, FINAL_COUNT, DUAL_LEG_VECTOR_RATIO, MIN_VECTOR_TOP_SCORE } from "@/lib/tools/searchKnowledgeBase";
import { scoreAll, recommend, pct, analyzeFloor, floorOutcome, type CalItem, type QueryTop } from "./calibration-core";

// Calibrates the retrieval confidence rule against real queries with known
// answers. It runs the REAL pipeline (the same fetchCandidates and
// confidenceForIndex the app uses), so what it measures is what chat does.
//
// For each query it records which of the app's top results are actually
// relevant (matched by the patterns below) and what each leg's score was as a
// percentage of that leg's own #1. Then it asks: at what dual-leg strength
// threshold do "confident" and "relevant" line up best?
//
// Usage (needs your .env.local):
//   npx dotenv -e .env.local -- npx tsx scripts/calibrate-confidence.ts
//   npx dotenv -e .env.local -- npx tsx scripts/calibrate-confidence.ts --delay=3000
//
// The delay (default 1500ms) spaces the queries out so a free-tier embedding
// limit doesn't skew the run. A rate-limited query is retried, and skipped
// (and said so) rather than scored on one leg.

interface LabeledQuery {
    query: string;
    // A result counts as relevant if its text matches ANY of these. An empty
    // list means "nothing in the KB should answer this".
    relevant: RegExp[];
}

const QUERIES: LabeledQuery[] = [
    { query: "fuel card receipts missing investigation procedure", relevant: [/fuel and vehicle-use procedure/i] },
    { query: "what's our retainer pricing", relevant: [/standard retainer agreement/i] },
    { query: "retainer pricing", relevant: [/standard retainer agreement/i] },
    { query: "Solmara Studio retainer pricing", relevant: [/standard retainer agreement/i] },
    { query: "how much should we charge a small business each month for ongoing support", relevant: [/standard retainer agreement/i] },
    { query: "how many security guards do we need for 200 guests", relevant: [/security staff member per|staffing ratios/i] },
    { query: "what is the cocktail catering budget per head", relevant: [/budget bands/i] },
    { query: "who can approve a goodwill gesture for an unhappy client", relevant: [/goodwill/i] },
    { query: "what do vendors need on file before we can book them", relevant: [/new vendor onboarding/i] },
    { query: "when do vendors get paid", relevant: [/payment terms/i] },
    { query: "what do we do if a vehicle breaks down on event day", relevant: [/emergency breakdown/i] },
    { query: "how much food waste is acceptable", relevant: [/waste/i] },
    { query: "rules for photographing and posting client events on social media", relevant: [/photography and social media/i] },
    { query: "do staff need badges at large events", relevant: [/credentialing/i] },
    { query: "how do we handle a complaint during the client's event", relevant: [/tier 3/i] },
    { query: "imported ingredients approval", relevant: [/international and specialty sourcing/i] },
    { query: "what happens when a vendor misses a delivery", relevant: [/dispute resolution|vendor delivery coordination|tier 2/i] },
    { query: "do guests with allergies need special menus", relevant: [/dietary accommodation|allergy/i] },
    { query: "how long does a vehicle service take", relevant: [/maintenance scheduling/i] },
    { query: "fuel", relevant: [/fuel and vehicle-use procedure/i] },
    { query: "visa requirements for staff travelling abroad", relevant: [] },
    { query: "what is the company pension plan", relevant: [] },
    { query: "what is the capital of france", relevant: [] },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poolWithRetry(query: string) {
    for (let attempt = 0; attempt < 4; attempt++) {
        const pool = await fetchCandidates(query);
        if (!pool.vectorFailed && !pool.fulltextFailed) return pool;

        const message = `${pool.vectorError} ${pool.fulltextError}`;
        if (attempt < 3 && /429|rate/i.test(message)) {
            console.log("   rate limited, waiting 25s and retrying...");
            await sleep(25000);
            continue;
        }
        return pool;
    }
    return fetchCandidates(query);
}

async function main() {
    const delayArg = process.argv.find((a) => a.startsWith("--delay="));
    const delayMs = delayArg ? Number(delayArg.split("=")[1]) : 1500;

    const items: CalItem[] = [];
    const misses: string[] = [];
    const skipped: string[] = [];
    const tops: QueryTop[] = [];

    console.log(`Calibrating against ${QUERIES.length} labeled queries (dual-leg vector ratio ${Math.round(DUAL_LEG_VECTOR_RATIO * 100)}%, absolute floor ${MIN_VECTOR_TOP_SCORE})\n`);

    for (const [index, labeled] of QUERIES.entries()) {
        if (index > 0) await sleep(delayMs);

        const pool = await poolWithRetry(labeled.query);
        console.log(`[${index + 1}/${QUERIES.length}] "${labeled.query}"`);
        if (pool.searchQuery !== labeled.query) console.log(`   searched as: "${pool.searchQuery}"`);

        if (pool.vectorFailed || pool.fulltextFailed) {
            console.log("   SKIPPED: a retrieval leg failed, so the ratios would be misleading\n");
            skipped.push(labeled.query);
            continue;
        }

        tops.push({ query: labeled.query, answerable: labeled.relevant.length > 0, vectorTop: pool.vectorTopScore });
        console.log(`   raw #1 scores: vector ${pool.vectorTopScore.toFixed(4)}  full-text ${pool.fulltextTopScore.toFixed(4)}`);

        const winners = pool.ranked.slice(0, FINAL_COUNT);
        if (winners.length === 0) {
            console.log("   no results\n");
            if (labeled.relevant.length > 0) misses.push(labeled.query);
            continue;
        }

        const { data: rows, error } = await supabase
            .from("kb_documents")
            .select("id, source, content")
            .in("id", winners.map((w) => w.id));

        if (error) {
            console.log(`   SKIPPED: couldn't read chunk text (${error.message})\n`);
            skipped.push(labeled.query);
            continue;
        }

        const byId = new Map((rows ?? []).map((r) => [r.id as string, r]));
        let anyRelevant = false;

        winners.forEach((winner, i) => {
            const row = byId.get(winner.id);
            const content = String(row?.content ?? "");
            const source = String(row?.source ?? "?");
            const relevant = labeled.relevant.some((pattern) => pattern.test(content));
            if (relevant) anyRelevant = true;

            const vectorRatio = winner.vectorScore !== null && pool.vectorTopScore > 0 ? winner.vectorScore / pool.vectorTopScore : null;
            const fulltextRatio = winner.fulltextScore !== null && pool.fulltextTopScore > 0 ? winner.fulltextScore / pool.fulltextTopScore : null;
            const foundBy = winner.vectorRank !== null && winner.fulltextRank !== null ? "both" : winner.vectorRank !== null ? "vector" : "fulltext";
            const currentConfident = confidenceForIndex(winners, i, pool.vectorTopScore) === "confident";

            items.push({ query: labeled.query, source, foundBy, vectorRatio, fulltextRatio, currentConfident, relevant });

            const v = vectorRatio === null ? "  - " : `${Math.round(vectorRatio * 100)}%`.padStart(4);
            const f = fulltextRatio === null ? "  - " : `${Math.round(fulltextRatio * 100)}%`.padStart(4);
            console.log(`   ${i + 1}. ${currentConfident ? "CONFIDENT" : "weak     "} ${relevant ? "[relevant]  " : "[not relev.]"} vec ${v}  txt ${f}  ${source}: ${content.slice(0, 55).replace(/\s+/g, " ")}`);
        });

        if (labeled.relevant.length > 0 && !anyRelevant) {
            console.log("   ⚠ NO RELEVANT CHUNK IN THE TOP RESULTS: a retrieval miss, or the pattern needs adjusting");
            misses.push(labeled.query);
        }
        console.log("");
    }

    // ── Results ──────────────────────────────────────────────────────────────
    const relevantCount = items.filter((i) => i.relevant).length;
    const scores = scoreAll(items);
    const rec = recommend(scores);

    console.log("=".repeat(78));
    console.log(`Scored ${items.length} results from ${QUERIES.length - skipped.length} queries (${skipped.length} skipped). ${relevantCount} of them are relevant.\n`);
    console.log("rule                              TP   FP   FN   precision  recall");
    for (const s of scores) {
        const marker = rec && s.rule.name === rec.rule.name ? "  <- recommended" : "";
        console.log(`${s.rule.name.padEnd(32)} ${String(s.tp).padStart(3)}  ${String(s.fp).padStart(3)}  ${String(s.fn).padStart(3)}   ${pct(s.precision)}   ${pct(s.recall)}${marker}`);
    }

    const falseConfident = items.filter((i) => i.currentConfident && !i.relevant);
    console.log(`\nResults the CURRENT rule calls confident but are not relevant: ${falseConfident.length}`);
    for (const item of falseConfident.slice(0, 12)) {
        console.log(`   "${item.query}" -> ${item.source}`);
    }
    if (falseConfident.length > 12) console.log(`   ...and ${falseConfident.length - 12} more`);

    if (misses.length > 0) {
        console.log(`\nRetrieval misses (no relevant chunk in the top ${FINAL_COUNT}): ${misses.length}`);
        for (const m of misses) console.log(`   "${m}"`);
    }

    // The absolute floor: needs the raw best-vector score of every query.
    const floor = analyzeFloor(tops);
    console.log(`\nABSOLUTE FLOOR (shipped at ${MIN_VECTOR_TOP_SCORE})`);
    console.log("best raw vector score per query, answerable vs not:");
    for (const t of [...tops].sort((a, b) => a.vectorTop - b.vectorTop)) {
        console.log(`   ${t.vectorTop.toFixed(4)}  ${t.answerable ? "answerable  " : "UNANSWERABLE"}  "${t.query}"`);
    }
    console.log(`lowest answerable: ${floor.minAnswerable?.toFixed(4)}   highest unanswerable: ${floor.maxAbsent?.toFixed(4)}`);
    console.log(floor.separable ? `separable: a floor anywhere between them works; the midpoint is ${floor.midpoint?.toFixed(3)}` : "NOT separable: some unanswerable query scores at or above an answerable one, so a floor alone can't tell them apart");
    console.log("floor   wrongly gates (answerable)   catches (unanswerable)");
    for (const f of [0.25, 0.3, 0.325, 0.35, 0.375, 0.4, 0.425, 0.45]) {
        const o = floorOutcome(tops, f);
        const nAnswerable = tops.filter((t) => t.answerable).length;
        const nAbsent = tops.filter((t) => !t.answerable).length;
        console.log(`${f.toFixed(3)}   ${String(o.falselyGated.length).padStart(3)} of ${nAnswerable}                    ${String(o.correctlyGated.length).padStart(3)} of ${nAbsent}${f === MIN_VECTOR_TOP_SCORE ? "   <- shipped" : ""}`);
    }
    const shippedOutcome = floorOutcome(tops, MIN_VECTOR_TOP_SCORE);
    if (shippedOutcome.falselyGated.length > 0) {
        console.log(`\n⚠ The shipped floor WRONGLY GATES: ${shippedOutcome.falselyGated.map((q) => `"${q}"`).join(", ")}. Lower MIN_VECTOR_TOP_SCORE.`);
    }

    if (relevantCount < 10) {
        console.log(`\nNote: only ${relevantCount} relevant results were found, which is thin for choosing a threshold. Treat the recommendation as provisional.`);
    }
    if (!rec) {
        console.log("\nNo recommendation: not enough data.");
    } else if (rec.fp === 0) {
        console.log(`\nRecommended: ${rec.rule.name} (the lowest threshold with no false "confident" labels).`);
    } else {
        console.log(`\nBest available: ${rec.rule.name}. No threshold was clean (${rec.fp} false "confident" labels remain), so this is only the best precision/recall balance.`);
    }
    console.log("Paste this whole output back and the threshold can be chosen from it.");
}

main().catch((err) => {
    console.error("calibration crashed:", err);
    process.exit(1);
});