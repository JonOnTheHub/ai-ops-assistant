// Real searchKnowledgeBase. Only the network is stubbed (Voyage + Supabase).
// It records what each retrieval leg ACTUALLY searched on, because the bug
// this guards against was invisible from the outside: the stopword stripper
// existed, the debug script used it, and the real search never called it, so
// "Solmara Studio retainer pricing" went to both legs unstripped and the
// shared "Solmara Studio ..." boilerplate crowded the right chunk out.
//
// No env file, no network. Run:
//   npx tsx scripts/test-kb-search.ts

export { };

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.VOYAGE_API_KEY = "test-key";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
    if (condition) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}`);
        if (detail !== undefined) console.log("      got:", typeof detail === "string" ? detail : JSON.stringify(detail));
    }
}

const seen = {
    embedInputs: [] as string[],
    fulltextQueries: [] as string[],
};

// What the stubbed vector leg returns, so each case can set the raw similarities.
const config = { vectorScores: [0.56, 0.39, 0.29], vectorDown: false };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CHUNKS = [
    { id: "c-retainer", source: "retainer-policy.md", content: "Our standard retainer agreement covers 3 months of AI integration support." },
    { id: "c-identity", source: "agency-identity.md", content: "Solmara Studio is a Lagos-based hospitality and events design studio." },
    { id: "c-vendor", source: "vendor-management-policy.md", content: "Contract renewal for any vendor on a standing retainer arrangement." },
];

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url));
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.hostname.includes("voyageai.com") && config.vectorDown) {
        return json(500, { message: "embedding service down" });
    }

    if (url.hostname.includes("voyageai.com")) {
        seen.embedInputs.push(String(JSON.parse(String(init?.body)).input));
        return json(200, {
            object: "list",
            data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
            model: "voyage-3-lite",
            usage: { total_tokens: 3 },
        });
    }

    if (url.pathname.endsWith("/rpc/match_kb_documents_ids")) {
        return json(200, ["c-retainer", "c-vendor", "c-identity"].map((id, i) => ({ id, similarity: config.vectorScores[i] })));
    }

    if (url.pathname.endsWith("/rpc/match_kb_documents_fulltext_ids")) {
        seen.fulltextQueries.push(String(JSON.parse(String(init?.body)).query_text));
        return json(200, [
            { id: "c-retainer", rank: 0.06 },
            { id: "c-identity", rank: 0.04 },
        ]);
    }

    if (url.pathname.endsWith("/rest/v1/kb_documents") && method === "GET") {
        return json(200, CHUNKS);
    }

    return json(500, { message: `unstubbed ${method} ${url.pathname}` });
}) as typeof fetch;

function reset() {
    seen.embedInputs = [];
    seen.fulltextQueries = [];
}

async function main() {
    const { searchKnowledgeBase } = await import("@/lib/tools/searchKnowledgeBase");

    // 1. The real-world failing shape: the planner puts the studio name in the query.
    reset();
    const result = await searchKnowledgeBase({ query: "Solmara Studio retainer pricing" });
    console.log("\n      what each leg actually searched on, for the query \"Solmara Studio retainer pricing\":");
    console.log(`      vector (embedding input): "${seen.embedInputs[0]}"`);
    console.log(`      full-text (query_text):   "${seen.fulltextQueries[0]}"\n`);

    check("search succeeds", result.success === true, result);
    check("vector leg embeds the query WITHOUT the corpus boilerplate words", seen.embedInputs[0] === "retainer pricing", seen.embedInputs[0]);
    check("full-text leg searches WITHOUT the corpus boilerplate words", seen.fulltextQueries[0] === "retainer pricing", seen.fulltextQueries[0]);

    // 2. Variants of the same thing.
    reset();
    await searchKnowledgeBase({ query: "what is the solmara studio's retainer pricing?" });
    check("case and punctuation variants are stripped too (vector)", !/solmara|studio/i.test(seen.embedInputs[0]), seen.embedInputs[0]);
    check("case and punctuation variants are stripped too (full-text)", !/solmara|studio/i.test(seen.fulltextQueries[0]), seen.fulltextQueries[0]);
    check("the other words in the query are kept", seen.fulltextQueries[0].includes("retainer") && seen.fulltextQueries[0].includes("pricing"), seen.fulltextQueries[0]);

    reset();
    await searchKnowledgeBase({ query: "Solmara\u2019s retainer pricing and the Studio's terms" });
    check("possessives with a curly apostrophe are stripped too", !/solmara|studio/i.test(seen.fulltextQueries[0]), seen.fulltextQueries[0]);
    check("...without eating the other words", seen.fulltextQueries[0].includes("retainer") && seen.fulltextQueries[0].includes("terms"), seen.fulltextQueries[0]);

    reset();
    await searchKnowledgeBase({ query: "design studios in lagos" });
    check("a plural that is NOT the boilerplate word is left alone", seen.fulltextQueries[0] === "design studios in lagos", seen.fulltextQueries[0]);

    // 3. A query with nothing to strip is passed through exactly.
    reset();
    await searchKnowledgeBase({ query: "retainer pricing" });
    check("a clean query is searched exactly as given", seen.embedInputs[0] === "retainer pricing" && seen.fulltextQueries[0] === "retainer pricing");

    // 4. Never search on nothing.
    reset();
    await searchKnowledgeBase({ query: "Solmara Studio" });
    check("a query that is ONLY boilerplate falls back to the original text", seen.embedInputs[0] === "Solmara Studio" && seen.fulltextQueries[0] === "Solmara Studio", seen);

    // 5. Results still come back in the shape the rest of the app expects.
    reset();
    const shaped = await searchKnowledgeBase({ query: "Solmara Studio retainer pricing" });
    const results = ((shaped.data as { results?: { source: string; confidence: string; foundBy: string }[] } | undefined)?.results ?? []);
    check("results include the right chunk first", results[0]?.source === "retainer-policy.md", results.map((r) => r.source));
    check("results carry a confidence label and where they were found", results.every((r) => (r.confidence === "confident" || r.confidence === "weak") && ["both", "vector", "fulltext"].includes(r.foundBy)), results);
    check("the chunk found by both legs at the top of each is confident", results[0]?.confidence === "confident" && results[0]?.foundBy === "both", results[0]);


    // 6. The confidence rule. c-identity is found by BOTH legs but its vector
    // similarity is only 52% of the best (0.29 vs 0.56). The old rule called
    // that confident because its full-text score was 67% of the text leg's #1;
    // the new rule looks at the vector similarity and calls it weak.
    type Hit = { id: string; source: string; confidence: string; foundBy: string };
    const labels = (r: Awaited<ReturnType<typeof searchKnowledgeBase>>) => ((r.data as { results: Hit[] }).results);
    const dataOf = (r: Awaited<ReturnType<typeof searchKnowledgeBase>>) => (r.data as Record<string, unknown>);

    config.vectorScores = [0.56, 0.39, 0.29];
    const normal = await searchKnowledgeBase({ query: "retainer pricing" });
    const byId = (id: string) => labels(normal).find((r) => r.id === id);
    check("a dual-leg chunk at the top of the vector leg is confident", byId("c-retainer")?.confidence === "confident", labels(normal));
    check("a dual-leg chunk at only 52% of the best vector score is WEAK (old rule: confident)", byId("c-identity")?.foundBy === "both" && byId("c-identity")?.confidence === "weak", byId("c-identity"));
    check("a normal query carries no low-confidence flag or note", dataOf(normal).lowConfidence === undefined && dataOf(normal).note === undefined, dataOf(normal));

    // 7. The absolute floor: nothing here is any good.
    config.vectorScores = [0.2, 0.15, 0.12];
    const poor = await searchKnowledgeBase({ query: "visa requirements for staff travelling abroad" });
    check("best similarity under the floor: results are still returned", poor.success === true && labels(poor).length > 0, poor);
    check("...but EVERY one is weak, even the one both legs ranked first", labels(poor).every((r) => r.confidence === "weak"), labels(poor));
    check("...and the tool flags it as low confidence", dataOf(poor).lowConfidence === true, dataOf(poor));
    check("...with a note the model will read, naming the score and the floor", /0\.20/.test(String(dataOf(poor).note)) && /0\.35/.test(String(dataOf(poor).note)), dataOf(poor).note);
    check("...that tells it to say so, not to answer from these", /doesn't appear to cover it/.test(String(dataOf(poor).note)), dataOf(poor).note);

    // 8. The boundary.
    config.vectorScores = [0.35, 0.3, 0.2];
    check("exactly at the floor is NOT low confidence", dataOf(await searchKnowledgeBase({ query: "retainer pricing" })).lowConfidence === undefined);
    config.vectorScores = [0.349, 0.3, 0.2];
    check("just under the floor IS low confidence", dataOf(await searchKnowledgeBase({ query: "retainer pricing" })).lowConfidence === true);

    // 9. With the vector leg down there is no raw similarity to judge, so the
    // floor must not fire: "no information" is not "no match".
    config.vectorScores = [0.56, 0.39, 0.29];
    config.vectorDown = true;
    const degraded = await searchKnowledgeBase({ query: "retainer pricing" });
    check("vector leg down: search still succeeds on full-text alone", degraded.success === true && labels(degraded).length > 0, degraded);
    check("vector leg down: the floor does not fire", dataOf(degraded).lowConfidence === undefined, dataOf(degraded));
    check("vector leg down: nothing is labeled confident through the both-legs door", labels(degraded).every((r) => r.foundBy === "fulltext"), labels(degraded));
    config.vectorDown = false;

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});