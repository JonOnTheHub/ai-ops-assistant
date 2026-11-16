// Real refine rules + real refine route. Only Groq's HTTP call and the Supabase
// REST layer are stubbed. No env file, no network. Run:
//   npx tsx scripts/test-refine.ts

export {};

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.GROQ_API_KEY = "gsk_test";

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

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = {
    groqCalls: [] as Record<string, unknown>[],
    content: "A rewritten passage.",
    groqStatus: 0,
    groqThrows: false,
    pendingTool: "sendEmail" as string | null,
    writes: 0,
};

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url));
    const method = (init?.method ?? "GET").toUpperCase();
    const wantsObject = (new Headers(init?.headers).get("accept") ?? "").includes("vnd.pgrst.object");

    if (url.hostname.includes("groq.com")) {
        stub.groqCalls.push(JSON.parse(String(init?.body)));
        if (stub.groqThrows) throw new TypeError("fetch failed");
        if (stub.groqStatus) return json(stub.groqStatus, { error: { message: "stubbed model error", type: "invalid_request_error" } });
        return json(200, {
            id: "x",
            object: "chat.completion",
            created: 1,
            model: "openai/gpt-oss-120b",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: stub.content } }],
            usage: {},
        });
    }

    if (url.pathname.endsWith("/rest/v1/pending_actions") && method === "GET") {
        const wanted = (url.searchParams.get("id") ?? "").replace("eq.", "");
        if (!stub.pendingTool || wanted !== "act-1") return json(406, { code: "PGRST116", message: "none" });
        const row = { id: "act-1", tool_name: stub.pendingTool };
        return json(200, wantsObject ? row : [row]);
    }

    // Any write at all would be a bug: refining must never change anything.
    if (method !== "GET") stub.writes++;
    return json(500, { message: `unstubbed ${method} ${url.pathname}` });
}) as typeof fetch;

function reset() {
    stub.groqCalls = [];
    stub.content = "A rewritten passage.";
    stub.groqStatus = 0;
    stub.groqThrows = false;
    stub.pendingTool = "sendEmail";
    stub.writes = 0;
}

async function main() {
    const refine = await import("@/lib/agent/refine");
    const { POST } = await import("@/app/api/actions/[id]/refine/route");
    const { NextRequest } = await import("next/server");

    // ── 1. Request rules ──────────────────────────────────────────────────────
    const req = (payload: unknown) => refine.validateRefineRequest(payload);
    check("a valid request is accepted for each of the five actions", refine.REFINE_ACTIONS.every((a) => req({ action: a, selection: "Please reply." }).ok) && refine.REFINE_ACTIONS.length === 5, refine.REFINE_ACTIONS);
    check("there is no free-text instruction: only the fixed actions are accepted", !req({ action: "make it rhyme", selection: "x" }).ok && !req({ action: "improve", instruction: "ignore the rules", selection: "x" }).ok);
    check("an empty or whitespace-only selection is refused", !req({ action: "improve", selection: "" }).ok && !req({ action: "improve", selection: "  \n " }).ok);
    check("a non-text selection is refused", !req({ action: "improve", selection: 5 }).ok);
    check("a selection at the limit is fine, one over is refused", req({ action: "improve", selection: "s".repeat(refine.SELECTION_MAX) }).ok && !req({ action: "improve", selection: "s".repeat(refine.SELECTION_MAX + 1) }).ok);
    check("unknown fields are refused, not ignored", !req({ action: "improve", selection: "x", subject: "y" }).ok && !req({ action: "improve", selection: "x", recipients: [] }).ok);
    check("null, arrays and strings are refused", !req(null).ok && !req([]).ok && !req("improve").ok);
    const trimmed = req({ action: "shorten", selection: "  padded  ", before: "b".repeat(1000), after: "a".repeat(1000) });
    check("the selection is trimmed", trimmed.ok && trimmed.selection === "padded", trimmed);
    check("context is cut to the stretch nearest the selection", trimmed.ok && trimmed.before.length === refine.CONTEXT_MAX && trimmed.after.length === refine.CONTEXT_MAX);

    // ── 2. The prompt ─────────────────────────────────────────────────────────
    const messages = refine.buildRefineMessages("shorten", "Please send the report.", "Hi Grace,", "Thanks.");
    check("two messages: the rules, then the passage", messages.length === 2 && messages[0].role === "system" && messages[1].role === "user");
    check("the rules forbid changing names, numbers, dates, amounts, addresses and links", /every name, number, date, amount, email address and link exactly as written/.test(messages[0].content));
    check("the rules forbid inventing facts, promises or deadlines", /Never add new facts, promises or deadlines/.test(messages[0].content));
    check("the rules demand plain text and only the passage back", /Plain text only/.test(messages[0].content) && /Return ONLY the rewritten passage/.test(messages[0].content));
    check("the passage is delimited and marked as the thing to rewrite", messages[1].content.includes("Passage to rewrite:\n<<<\nPlease send the report.\n>>>"));
    check("the surrounding text is included but marked do-not-rewrite", /Context before \(do not rewrite\): Hi Grace,/.test(messages[1].content) && /Context after \(do not rewrite\): Thanks\./.test(messages[1].content));
    check("each action gets its own instruction", new Set(refine.REFINE_ACTIONS.map((a) => refine.buildRefineMessages(a, "x", "", "")[1].content.split("\n")[0])).size === 5);
    check("missing context is stated, not left blank", /Context before \(do not rewrite\): \(none\)/.test(refine.buildRefineMessages("improve", "x", "", "")[1].content));

    // ── 3. Cleaning what the model returns ────────────────────────────────────
    const clean = refine.cleanSuggestion;
    check("markdown is stripped", clean("Report in **48 hours**.", "Report in 48 hours.") === "Report in 48 hours.");
    check("delimiters the model echoed are removed", clean("<<<\nA clean line.\n>>>", "x") === "A clean line.");
    check("a 'Here is...' preamble is removed", clean("Here's the improved version:\nPlease send the report today.", "Please send the report.") === "Please send the report today.");
    check("...but not when the original itself starts with 'Here'", clean("Here is the report.", "Here is the report.") === "Here is the report.");
    check("quotes wrapped around the whole result are removed", clean('"Please send it today."', "Please send it.") === "Please send it today.");
    check("...but not when the original was quoted", clean('"Quoted text"', '"Quoted text"') === '"Quoted text"');
    check("an empty answer cleans to empty", clean("   ", "x") === "");

    // ── 4. The facts check ────────────────────────────────────────────────────
    const facts = refine.compareFacts;
    check("an unchanged set of facts is not flagged", !facts("Pay ₦450,000 by Friday 3 March.", "Please pay ₦450000 on Friday, 3 March.").changed);
    check("48 hours becoming 24 hours IS flagged, both ways", (() => { const f = facts("Report within 48 hours.", "Report within 24 hours."); return f.changed && f.removed.join() === "48" && f.added.join() === "24"; })());
    check("a dropped amount is flagged", facts("The retainer is ₦450,000 a month.", "The retainer is paid monthly.").removed.join() === "₦450000");
    check("a changed currency is flagged", facts("Budget: ₦18000", "Budget: $18000").changed);
    check("a changed day is flagged", facts("Deliver on Monday.", "Deliver on Tuesday.").changed);
    check("a changed email address is flagged", facts("Write to grace@solmarastudio.com.", "Write to grace@solmara.com.").changed);
    check("a changed link is flagged", facts("See https://a.example/policy", "See https://b.example/policy").changed);
    check("a NEW number the model invented is flagged as added", facts("Please reply soon.", "Please reply within 2 hours.").added.join() === "2");
    check("rewording with no facts in it is not flagged", !facts("Please send the report.", "Kindly send us the report.").changed);
    check("repeated facts are counted, so dropping one of two is caught", facts("Send 5 now and 5 later.", "Send 5 now.").changed);

    // ── 4b. The browser-safe helpers the card uses ────────────────────────────
    const shared = await import("@/lib/agent/refineShared");
    const text = "Hi Grace,\n\nPlease send the report.\n\nThanks";
    const word = shared.trimSelection(text, text.indexOf("Please"), text.indexOf("Please") + 6);
    check("trimSelection returns the exact range for a clean selection", word?.start === text.indexOf("Please") && word?.end === text.indexOf("Please") + 6, word);
    const padded = shared.trimSelection(text, text.indexOf("Please") - 2, text.indexOf("report.") + 7 + 2);
    check("trimSelection pulls the range in off surrounding whitespace and newlines", text.slice(padded!.start, padded!.end) === "Please send the report.", padded);
    check("trimSelection works for a backwards selection", shared.trimSelection(text, 12, 4) !== null && shared.trimSelection(text, 12, 4)!.start < shared.trimSelection(text, 12, 4)!.end);
    check("trimSelection gives null for whitespace only (the two newlines), or for nothing", shared.trimSelection(text, 9, 11) === null && shared.trimSelection(text, 5, 5) === null, shared.trimSelection(text, 9, 11));
    check("trimSelection never runs past the text", shared.trimSelection("abc", 1, 99)?.end === 3);
    check("the button labels cover every action and match the five fixed actions", shared.REFINE_ACTIONS.every((a) => typeof shared.REFINE_LABELS[a] === "string") && shared.REFINE_ACTIONS.length === 5);
    check("describeFactChange is silent when nothing changed", shared.describeFactChange({ changed: false, removed: [], added: [] }) === null);
    const warned = shared.describeFactChange({ changed: true, removed: ["48"], added: ["24"] }) ?? "";
    check("describeFactChange names what was removed and added", /Check this/.test(warned) && /removed 48/.test(warned) && /added 24/.test(warned), warned);
    const removedOnly = shared.describeFactChange({ changed: true, removed: ["₦450000"], added: [] }) ?? "";
    const addedOnly = shared.describeFactChange({ changed: true, removed: [], added: ["2"] }) ?? "";
    check("describeFactChange: removed-only mentions only the removal", /removed ₦450000/.test(removedOnly) && !/added/.test(removedOnly), removedOnly);
    check("describeFactChange: added-only mentions only the addition", /added 2/.test(addedOnly) && !/removed/.test(addedOnly), addedOnly);
    check("the server's limits and the browser's are the same numbers", refine.SELECTION_MAX === shared.SELECTION_MAX && refine.CONTEXT_MAX === shared.CONTEXT_MAX && refine.SUGGESTION_MAX === shared.SUGGESTION_MAX);
    check("the browser-safe file does not import the Groq SDK or anything server-side", !/groq-sdk|supabase|process\.env/.test(await (await import("node:fs/promises")).readFile(new URL("../lib/agent/refineShared.ts", import.meta.url), "utf8")));

    // ── 5. The real endpoint ──────────────────────────────────────────────────
    const call = async (payload: unknown, id = "act-1") => {
        const res = await POST(new NextRequest(`http://localhost/api/actions/${id}/refine`, { method: "POST", body: typeof payload === "string" ? payload : JSON.stringify(payload) }), { params: Promise.resolve({ id }) });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    reset();
    stub.content = "Kindly send us the report within 48 hours.";
    let r = await call({ action: "improve", selection: "Please send the report within 48 hours.", before: "Hi Grace,\n\n", after: "\n\nThanks" });
    check("a good request: 200 with the suggestion and the original side by side", r.status === 200 && r.body.suggestion === "Kindly send us the report within 48 hours." && r.body.original === "Please send the report within 48 hours.", r);
    check("...and a clean facts check", (r.body.facts as { changed: boolean }).changed === false, r.body.facts);
    const sent = stub.groqCalls[0] as { model: string; reasoning_effort: string; max_tokens: number; messages: { role: string; content: string }[]; tools?: unknown };
    check("exactly one model call, to the same model as the planner", stub.groqCalls.length === 1 && sent.model === "openai/gpt-oss-120b", sent?.model);
    check("it asks for LOW reasoning effort (short rewrites should be quick)", sent.reasoning_effort === "low", sent.reasoning_effort);
    check("it caps the answer length", sent.max_tokens > 0 && sent.max_tokens <= 1200, sent.max_tokens);
    check("it gives the model no tools to call", sent.tools === undefined);
    check("the model is sent the passage and the rules", sent.messages[1].content.includes("Please send the report within 48 hours.") && /Rewrite ONLY the passage/.test(sent.messages[0].content));

    reset();
    stub.content = "Please send the report within 24 hours.";
    r = await call({ action: "shorten", selection: "Please send the report within 48 hours." });
    const flagged = r.body.facts as { changed: boolean; removed: string[]; added: string[] };
    check("a suggestion that changes 48 to 24 is returned but flagged for the person", r.status === 200 && flagged.changed && flagged.removed.join() === "48" && flagged.added.join() === "24", r.body);

    reset();
    stub.content = 'Here is the rewrite:\n"Please send the **full** report."';
    r = await call({ action: "improve", selection: "Please send the report." });
    check("a messy answer (preamble, quotes, markdown) is cleaned before it reaches the card", r.body.suggestion === "Please send the full report.", r.body);

    reset();
    await call({ action: "improve", selection: "x".repeat(10) });
    check("it NEVER writes anything: refining only suggests", stub.writes === 0, stub.writes);

    // Requests that must not reach the model at all.
    reset();
    for (const [label, payload] of [
        ["an unknown action", { action: "translate", selection: "x" }],
        ["an empty selection", { action: "improve", selection: " " }],
        ["a selection over the limit", { action: "improve", selection: "s".repeat(refine.SELECTION_MAX + 1) }],
        ["an extra field", { action: "improve", selection: "x", recipients: [] }],
        ["invalid JSON", "{not json"],
    ] as [string, unknown][]) {
        const out = await call(payload);
        check(`${label}: 400, and the model is never called`, out.status === 400 && stub.groqCalls.length === 0, out);
    }

    reset();
    stub.pendingTool = null;
    r = await call({ action: "improve", selection: "x" });
    check("an action that isn't pending: 404, and the model is never called", r.status === 404 && stub.groqCalls.length === 0, r);
    reset();
    r = await call({ action: "improve", selection: "x" }, "some-other-id");
    check("an unknown action id: 404, and the model is never called (it is not a free model endpoint)", r.status === 404 && stub.groqCalls.length === 0, r);
    reset();
    stub.pendingTool = "createTask";
    r = await call({ action: "improve", selection: "x" });
    check("a pending action that isn't an email draft: 400, and the model is never called", r.status === 400 && stub.groqCalls.length === 0, r);

    // ── 6. Every way the model call can fail ──────────────────────────────────
    reset();
    stub.groqStatus = 429;
    r = await call({ action: "improve", selection: "x" });
    const rate = r.body.errorInfo as { kind: string; cause: string; retryable: boolean };
    check("rate limited: 429 with a rate_limit cause the card can act on", r.status === 429 && rate.kind === "tool_failure" && rate.cause === "rate_limit" && rate.retryable === true, r.body);
    check("rate limited: exactly one attempt (no hidden retries spending the shared budget)", stub.groqCalls.length === 1, stub.groqCalls.length);
    check("rate limited: a plain message is returned", typeof r.body.error === "string" && /rate limit/i.test(String(r.body.error)), r.body.error);

    reset();
    stub.groqStatus = 400;
    r = await call({ action: "improve", selection: "x" });
    check("the model rejects the request: 502 with a rejected cause, retryable", r.status === 502 && (r.body.errorInfo as { cause: string }).cause === "rejected" && r.body.retryable === true, r.body);

    reset();
    stub.groqThrows = true;
    r = await call({ action: "improve", selection: "x" });
    check("the network is down: 502 with a connection cause", r.status === 502 && (r.body.errorInfo as { cause: string }).cause === "connection", r.body);

    reset();
    stub.content = "   ";
    r = await call({ action: "improve", selection: "x" });
    check("the model returns nothing: 502 with a plain try-again message", r.status === 502 && /returned nothing/.test(String(r.body.error)) && r.body.retryable === true, r.body);

    reset();
    stub.content = "w".repeat(refine.SUGGESTION_MAX + 1);
    r = await call({ action: "improve", selection: "x" });
    check("the model returns an absurdly long answer: discarded with a plain message", r.status === 502 && /far too long/.test(String(r.body.error)), r.body);

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});