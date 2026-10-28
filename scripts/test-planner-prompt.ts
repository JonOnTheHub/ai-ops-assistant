// The planner prompt is the one place behavior can't be unit-tested offline
// (it needs the live model), so this guards the RULES from being silently lost
// in a later edit. It cannot prove the model obeys them: that is a live check.
//   npx tsx scripts/test-planner-prompt.ts

export {};

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.GROQ_API_KEY = "gsk_test";
process.env.VOYAGE_API_KEY = "test-key";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
    if (condition) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}`);
        if (detail !== undefined) console.log("      got:", String(detail).slice(0, 300));
    }
}

async function main() {
    const { SYSTEM_PROMPT: prompt } = await import("@/lib/agent/planner");

    // Search first, ask later (Oct 27: a bare "fuel" got a clarifying question
    // instead of a search, which is a worse answer than just searching).
    check("a bare topic or keyword is treated as a knowledge-base lookup", /short topic or keyword with no action attached/.test(prompt));
    check("the examples include a single word like fuel", /"fuel"/.test(prompt));
    check("it says to search FIRST", /use searchKnowledgeBase, and do it FIRST/.test(prompt));
    check("it says never to ask what they mean before searching", /never ask the person what they mean before searching/.test(prompt));
    check("it only allows a follow-up question after weak or off-topic results", /Only if the results come back weak or off-topic/.test(prompt));
    check("greetings and thanks are explicitly not topics", /Greetings and thanks are not topics/.test(prompt));

    // The rules around it must still be there.
    check("step 1 (history questions answered without a tool) is intact", /Step 1 — Is this message asking about something that already happened/.test(prompt));
    check("step 2 (new actions) is intact", /Step 2 — Is this message asking you to take a brand new action/.test(prompt));
    check("search-once rule is intact: no reworded retries", /call it ONCE per user question/.test(prompt));
    check("the broadcast sequence rule is intact", /resolveAudience to find out who matches, THEN/.test(prompt));
    check("the old 'only then' restriction that blocked bare-topic searches is gone", !/Only then use searchKnowledgeBase/.test(prompt));

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});