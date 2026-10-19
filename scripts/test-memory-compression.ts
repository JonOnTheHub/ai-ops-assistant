// Real manageShortTermMemory. Only the network is stubbed (Groq + an in-memory
// conversation_summaries table). No env file, no real calls. Run:
//   npx tsx scripts/test-memory-compression.ts
//
// It replays a conversation the way the browser sends it (the FULL history on
// every request), checks the new incremental behavior, and prints a
// before/after comparison against the old compress-every-turn behavior.

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
        if (detail !== undefined) console.log("      got:", typeof detail === "string" ? detail : JSON.stringify(detail));
    }
}

interface Row {
    conversation_id: string;
    summary: string;
    turns_covered: number;
}

const stub = {
    rows: [] as Row[],
    groqCalls: 0,
    groqInputs: [] as string[],
    requests: 0,
    groqContent: null as string | null,
    failInsert: false,
    failSelect: false,
};

function resetStub() {
    stub.rows = [];
    stub.groqCalls = 0;
    stub.groqInputs = [];
    stub.requests = 0;
    stub.groqContent = null;
    stub.failInsert = false;
    stub.failSelect = false;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    stub.requests++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url));
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.hostname.includes("groq.com")) {
        stub.groqCalls++;
        const body = JSON.parse(String(init?.body));
        stub.groqInputs.push(String(body.messages?.[1]?.content ?? ""));
        const content = stub.groqContent ?? `• summary number ${stub.groqCalls}`;
        return json(200, {
            id: "x",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
            usage: {},
        });
    }

    if (url.pathname.endsWith("/rest/v1/conversation_summaries")) {
        if (method === "POST") {
            if (stub.failInsert) return json(500, { message: "insert failed" });
            stub.rows.push(JSON.parse(String(init?.body)));
            return json(201, []);
        }
        if (stub.failSelect) return json(500, { message: "select failed" });
        const id = (url.searchParams.get("conversation_id") ?? "").replace("eq.", "");
        const newest = stub.rows
            .filter((r) => r.conversation_id === id)
            .sort((a, b) => b.turns_covered - a.turns_covered)
            .slice(0, 1);
        return json(200, newest);
    }

    return json(500, { message: `unstubbed ${method} ${url.pathname}` });
}) as typeof fetch;

interface Msg {
    role: "user" | "assistant";
    content: string;
}

const msg = (i: number): Msg => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${i % 2 === 0 ? "Question" : "Answer"} ${Math.floor(i / 2) + 1}: ${"details ".repeat(i % 2 === 0 ? 25 : 50).trim()}`,
});

const historyOf = (n: number): Msg[] => Array.from({ length: n }, (_, i) => msg(i));

async function main() {
    const { manageShortTermMemory } = await import("@/lib/agent/memory");
    const run = (convo: string, history: Msg[]) => manageShortTermMemory(convo, history as never);

    // ── 1. A 20-turn conversation, full history sent every turn ──────────────
    const TURNS = 20;
    let events = 0;
    let maxWindow = 0;
    let invariantBroken: string | null = null;
    let noticeBroken = false;

    for (let t = 1; t <= TURNS; t++) {
        const history = historyOf(2 * (t - 1));
        const out = await run("convo-a", history);
        const summarized = out.compression !== null;
        const live = summarized ? out.history.slice(1) : out.history;
        const covered = out.compression?.turnsCovered ?? 0;

        if (out.compression?.newlyCompressed) events++;
        maxWindow = Math.max(maxWindow, live.length);

        // Nothing lost, nothing duplicated: the summary covers [0, covered) and
        // the model sees [covered, n) verbatim.
        if (covered + live.length !== history.length || (live.length > 0 && live[0].content !== history[covered].content)) {
            invariantBroken = `turn ${t}: covered ${covered} + live ${live.length} vs ${history.length} messages`;
        }
        if (summarized && !String(out.history[0].content).startsWith("[Summary of earlier conversation")) noticeBroken = true;
    }

    const after = { calls: stub.groqCalls, rows: stub.rows.length, chars: stub.groqInputs.reduce((s, x) => s + x.length, 0) };

    check("every turn: summary + live window cover the history exactly, with no gap or overlap", invariantBroken === null, invariantBroken ?? undefined);
    check("the model never sees more than 10 raw messages (the old code reached 19)", maxWindow <= 10, maxWindow);
    check("20 turns -> 5 summarizer calls (the old code made 14)", after.calls === 5, after.calls);
    check("20 turns -> 5 summary rows written (the old code wrote 14)", after.rows === 5, after.rows);
    check("a new-summary event fires exactly once per real compression", events === 5, events);
    check("stored coverage grows in clean steps", JSON.stringify(stub.rows.map((r) => r.turns_covered)) === JSON.stringify([6, 12, 18, 24, 30]), stub.rows.map((r) => r.turns_covered));
    check("the notice keeps the prefix the planner prompt relies on", !noticeBroken);
    check("later summaries are built from the earlier one, not from scratch", stub.groqInputs[1].includes("[Summary of even earlier conversation]: • summary number 1"), stub.groqInputs[1]?.slice(0, 120));

    // ── 2. Before/after, against the old behavior ────────────────────────────
    // The old code summarized whenever the history passed 10 messages, from
    // scratch, and kept the newer half of whatever it was sent. (Verified
    // against the previous implementation: 14 calls, 14 rows, max window 19.)
    let legacyCalls = 0;
    let legacyMaxWindow = 0;
    for (let t = 1; t <= TURNS; t++) {
        const n = 2 * (t - 1);
        if (n > 10) {
            legacyCalls++;
            legacyMaxWindow = Math.max(legacyMaxWindow, n - Math.floor(n / 2));
        } else {
            legacyMaxWindow = Math.max(legacyMaxWindow, n);
        }
    }
    console.log("\n      20-turn conversation, full history sent every turn:");
    console.log("                                   before    after");
    console.log(`      summarizer LLM calls         ${String(legacyCalls).padStart(6)}   ${String(after.calls).padStart(6)}`);
    console.log(`      summary rows written         ${String(legacyCalls).padStart(6)}   ${String(after.rows).padStart(6)}`);
    console.log(`      peak raw messages to model   ${String(legacyMaxWindow).padStart(6)}   ${String(maxWindow).padStart(6)}\n`);
    check("comparison: fewer summarizer calls than before", after.calls < legacyCalls);

    // ── 3. Retry sends the same history again and must not re-summarize ──────
    resetStub();
    const sameHistory = historyOf(12);
    const first = await run("convo-retry", sameHistory);
    const callsAfterFirst = stub.groqCalls;
    const second = await run("convo-retry", sameHistory);
    check("first request writes the summary", first.compression?.newlyCompressed === true && callsAfterFirst === 1, first.compression);
    check("an identical second request (a Retry) reuses it: no new LLM call", stub.groqCalls === callsAfterFirst, stub.groqCalls);
    check("...and does not announce a new summary", second.compression?.newlyCompressed === false, second.compression);
    check("...and the model sees the same context both times", JSON.stringify(first.history) === JSON.stringify(second.history));

    // ── 4. Short conversations cost nothing ──────────────────────────────────
    resetStub();
    const short = historyOf(10);
    const shortOut = await run("convo-short", short);
    check("10 messages or fewer: no DB read and no LLM call", stub.requests === 0, stub.requests);
    check("10 messages or fewer: history passes through untouched, no summary", shortOut.history === (short as unknown) && shortOut.compression === null);

    // ── 5. Rows written by the old every-turn version carry over ─────────────
    resetStub();
    stub.rows.push(
        { conversation_id: "convo-legacy", summary: "LEGACY-SUMMARY", turns_covered: 6 },
        { conversation_id: "convo-legacy", summary: "LEGACY-SUMMARY", turns_covered: 8 },
        { conversation_id: "convo-legacy", summary: "LEGACY-SUMMARY", turns_covered: 20 }
    );
    const legacyOut = await run("convo-legacy", historyOf(40));
    check("legacy rows: the newest (largest coverage) row is picked up", legacyOut.compression?.turnsCovered === 30, legacyOut.compression);
    check("legacy rows: the old summary is folded into the new one", stub.groqInputs[0]?.includes("LEGACY-SUMMARY") === true, stub.groqInputs[0]?.slice(0, 80));

    // ── 6. A summary that can't match the history is ignored, not trusted ────
    resetStub();
    stub.rows.push({ conversation_id: "convo-odd", summary: "STALE-SUMMARY", turns_covered: 50 });
    const oddOut = await run("convo-odd", historyOf(30));
    check("coverage larger than the history: stale summary ignored", !stub.groqInputs[0]?.includes("STALE-SUMMARY"), stub.groqInputs[0]?.slice(0, 80));
    check("...and it still compresses from what it was actually sent", oddOut.compression?.turnsCovered === 15, oddOut.compression);

    // ── 7. Infrastructure failures degrade, never crash the turn ─────────────
    resetStub();
    stub.failInsert = true;
    let threw = false;
    let insertFailOut: Awaited<ReturnType<typeof run>> | null = null;
    try {
        insertFailOut = await run("convo-f1", historyOf(14));
    } catch {
        threw = true;
    }
    check("saving the summary fails: the turn still works", !threw && insertFailOut?.compression?.newlyCompressed === true);

    resetStub();
    stub.failSelect = true;
    threw = false;
    let selectFailOut: Awaited<ReturnType<typeof run>> | null = null;
    try {
        selectFailOut = await run("convo-f2", historyOf(14));
    } catch {
        threw = true;
    }
    check("reading the stored summary fails: the turn still works, from the history it was sent", !threw && selectFailOut !== null && selectFailOut.history.length > 0);

    // ── 8. Empty summarizer output keeps both the old summary and new messages ─
    resetStub();
    stub.rows.push({ conversation_id: "convo-empty", summary: "OLDSUMMARY-MARKER", turns_covered: 6 });
    stub.groqContent = "";
    const emptyOut = await run("convo-empty", historyOf(24));
    const fallback = emptyOut.compression?.summary ?? "";
    check("empty summarizer output: the fallback still carries the old summary", fallback.includes("OLDSUMMARY-MARKER"), fallback.slice(0, 120));
    check("empty summarizer output: ...and the new messages", fallback.includes("Question"), fallback.slice(0, 120));
    check("empty summarizer output: ...within the 1000 character cap", fallback.length <= 1000, fallback.length);

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});