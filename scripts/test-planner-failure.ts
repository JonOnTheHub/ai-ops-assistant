// Real runPlanner + real classifier. Only the network is stubbed: Groq returns
// the exact 400 from the real log, everything else (Voyage, Supabase) fails
// with a 500 the way an outage would. No env file, no real calls. Run:
//   npx tsx scripts/test-planner-failure.ts

// Makes this file a module so its top-level names don't collide with other
// standalone scripts (tsc treats import-less files as one shared global scope).
export { };

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

const GROQ_400_BODY = {
    error: {
        message:
            "Tool call validation failed: tool call validation failed: parameters for tool createTask did not match schema: errors: [`/customer_name`: expected string, but got null]",
        type: "invalid_request_error",
        code: "tool_use_failed",
        failed_generation: '{"name": "createTask", "arguments": {"title": "x", "description": "y", "customer_name": null}}',
    },
};

let groqCalls = 0;
const traceRows: Record<string, unknown>[] = [];

function urlOf(input: unknown): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return String((input as { url?: string }).url ?? input);
}

// Installed BEFORE the app modules load, in case an SDK captures fetch at import.
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = urlOf(input);

    if (url.includes("groq.com")) {
        groqCalls++;
        return new Response(JSON.stringify(GROQ_400_BODY), {
            status: 400,
            headers: { "content-type": "application/json" },
        });
    }

    if (url.includes("/rest/v1/trace_logs") && init?.method === "POST") {
        const parsed = JSON.parse(String(init.body));
        for (const row of Array.isArray(parsed) ? parsed : [parsed]) traceRows.push(row as Record<string, unknown>);
        return new Response("[]", { status: 201, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ message: "stub outage" }), {
        status: 500,
        headers: { "content-type": "application/json" },
    });
}) as typeof fetch;

async function main() {
    const { runPlanner } = await import("@/lib/agent/planner");
    const { classifyThrown } = await import("@/lib/agent/classifier");

    let thrown: unknown = null;
    let returned: unknown = null;

    try {
        returned = await runPlanner("create a task for logistics", [], "trace-test-1", []);
    } catch (err) {
        thrown = err;
    }

    check("planner made exactly 2 Groq attempts (first + one retry)", groqCalls === 2, groqCalls);
    check("planner THROWS after the retry fails (does not return a friendly reply)", thrown !== null, returned);

    if (thrown !== null) {
        const status = (thrown as { status?: number }).status;
        check("the thrown error keeps the real HTTP status (400)", status === 400, status);

        const info = classifyThrown(thrown, { completedTools: [] });
        check("route's classifier reads it as a system tool_failure", info.kind === "tool_failure" && info.source === "system", info);
        check("cause is 'rejected', not a vague 'unknown'", info.kind === "tool_failure" && info.cause === "rejected", info);
        check("retryable when nothing with side effects ran", info.kind === "tool_failure" && info.retryable === true, info);

        const afterTask = classifyThrown(thrown, { completedTools: ["createTask"] });
        check("NOT retryable if createTask already ran earlier this turn", afterTask.kind === "tool_failure" && afterTask.retryable === false, afterTask);
    }

    const planRows = traceRows.filter((row) => row.step === "plan");
    check("a plan trace row was written", planRows.length === 1, traceRows);
    check("that row is status 'error', not 'success'", planRows[0]?.status === "error", planRows[0]);
    check(
        "the row records the real error text",
        JSON.stringify(planRows[0]?.output ?? {}).includes("customer_name"),
        planRows[0]?.output
    );

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});