import { APIConnectionError, APIConnectionTimeoutError, RateLimitError } from "groq-sdk";
import { classifyToolResult, classifyThrown, anySideEffects } from "@/lib/agent/classifier";
import { ToolResult } from "@/types";
import { ErrorInfo } from "@/types/errors";

// Layer 1 check: pure functions, no env, no network, no DB.
// Run: npx tsx scripts/test-classifier.ts

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
    if (condition) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}`);
        if (detail !== undefined) console.log("      got:", JSON.stringify(detail));
    }
}

function broadcastResult(lines: { name: string; success: boolean; error?: string }[]): ToolResult {
    const sent = lines.filter((l) => l.success).length;
    return {
        success: true,
        data: {
            results: lines.map((l) => ({ ...l, email: `${l.name}@x.com` })),
            sent_count: sent,
            failed_count: lines.length - sent,
            total: lines.length,
            message: "n/a",
        },
    };
}

// ── sendBroadcast ──
const allSent = classifyToolResult("sendBroadcast", broadcastResult([
    { name: "Amina Bello", success: true },
    { name: "Chidi Okonkwo", success: true },
]));
check("broadcast 2/2 sent -> null (clean success)", allSent === null, allSent);

const partial = classifyToolResult("sendBroadcast", broadcastResult([
    { name: "Michael Nwachukwu", success: false, error: "Error: rate limited" },
    { name: "Halima Suleiman", success: true },
]));
check("broadcast 1/2 sent -> partial_success", partial?.kind === "partial_success", partial);
if (partial?.kind === "partial_success") {
    check("partial: failed set is exactly the failed recipient", partial.failed.length === 1 && partial.failed[0].name === "Michael Nwachukwu", partial.failed);
    check("partial: succeeded set is exactly the sent recipient", partial.succeeded.length === 1 && partial.succeeded[0] === "Halima Suleiman", partial.succeeded);
    check("partial: reason has the 'Error: ' prefix stripped", partial.failed[0].reason === "rate limited", partial.failed[0]);
}

const noneSent = classifyToolResult("sendBroadcast", broadcastResult([
    { name: "A", success: false, error: "x" },
    { name: "B", success: false, error: "y" },
    { name: "C", success: false, error: "z" },
]));
check("broadcast 0/3 sent (tool said success:true) -> tool_failure", noneSent?.kind === "tool_failure", noneSent);
check("broadcast 0/3: not retryable", noneSent?.kind === "tool_failure" && noneSent.retryable === false, noneSent);

const emptyResults = classifyToolResult("sendBroadcast", { success: true, data: { results: [] } });
check("broadcast with unreadable/empty results -> null (validator's job, not ours)", emptyResults === null, emptyResults);

// ── resolveAudience ──
const noMatch = classifyToolResult("resolveAudience", {
    success: true,
    data: { recipients: [], count: 0, message: "No employees matched those filters." },
});
check("resolveAudience count 0 -> misunderstood/no_match", noMatch?.kind === "misunderstood" && noMatch.reason === "no_match", noMatch);
check("resolveAudience count 0 uses the tool's own message", noMatch?.summary === "No employees matched those filters.", noMatch);

const someMatch = classifyToolResult("resolveAudience", { success: true, data: { recipients: [{}], count: 1 } });
check("resolveAudience count 1 -> null", someMatch === null, someMatch);

// ── failed results: retryable follows tier ──
const searchFail = classifyToolResult("searchKnowledgeBase", { success: false, error: "searchKnowledgeBase failed: boom" });
check("auto-tier failure (searchKnowledgeBase) -> retryable", searchFail?.kind === "tool_failure" && searchFail.retryable === true, searchFail);

const taskFail = classifyToolResult("createTask", { success: false, error: "createTask failed: boom" });
check("log-and-run failure (createTask) -> NOT retryable", taskFail?.kind === "tool_failure" && taskFail.retryable === false, taskFail);

const emailFail = classifyToolResult("sendEmail", { success: false, error: "sendEmail failed: boom" });
check("needs-approval failure (sendEmail) -> NOT retryable", emailFail?.kind === "tool_failure" && emailFail.retryable === false, emailFail);

const shapeFail = classifyToolResult("getCustomer", { success: false, error: "[validator] getCustomer returned unexpected shape. Missing fields: customers" });
check("validator shape failure -> system source, not retryable", shapeFail?.kind === "tool_failure" && shapeFail.source === "system" && shapeFail.retryable === false, shapeFail);

// ── clean successes that must classify as null ──
check("createTask success -> null", classifyToolResult("createTask", { success: true, data: { task: {} } }) === null);
check("searchKnowledgeBase success (even 0 results) -> null", classifyToolResult("searchKnowledgeBase", { success: true, data: { results: [] } }) === null);

// ── thrown errors ──
function thrown(err: unknown, completed: Parameters<typeof classifyThrown>[1]["completedTools"] = []): ErrorInfo {
    return classifyThrown(err, { completedTools: completed });
}

const rateLimited = thrown(new RateLimitError(429, {}, "rate limited", new Headers()));
check("real groq RateLimitError -> rate_limit", rateLimited.kind === "tool_failure" && rateLimited.cause === "rate_limit", rateLimited);
check("rate_limit with no side effects -> retryable", rateLimited.kind === "tool_failure" && rateLimited.retryable === true, rateLimited);

const dutyTyped = thrown(Object.assign(new Error("x"), { status: 429 }));
check("duck-typed status 429 -> rate_limit", dutyTyped.kind === "tool_failure" && dutyTyped.cause === "rate_limit", dutyTyped);

const timedOut = thrown(new APIConnectionTimeoutError());
check("APIConnectionTimeoutError -> timeout (not plain connection)", timedOut.kind === "tool_failure" && timedOut.cause === "timeout", timedOut);

const noConnection = thrown(new APIConnectionError({}));
check("APIConnectionError -> connection", noConnection.kind === "tool_failure" && noConnection.cause === "connection", noConnection);

const serverErr = thrown(Object.assign(new Error("x"), { status: 503 }));
check("status 503 -> server", serverErr.kind === "tool_failure" && serverErr.cause === "server", serverErr);

const badRequest = thrown(Object.assign(new Error("x"), { status: 400 }));
check("status 400 -> rejected (NOT misunderstood)", badRequest.kind === "tool_failure" && badRequest.cause === "rejected", badRequest);

const mystery = thrown(new Error("something odd"));
check("plain Error -> unknown", mystery.kind === "tool_failure" && mystery.cause === "unknown", mystery);
check("all thrown errors are source=system", mystery.kind === "tool_failure" && mystery.source === "system", mystery);

const afterAuto = thrown(new Error("x"), ["searchKnowledgeBase", "getCustomer", "resolveAudience"]);
check("thrown after only auto-tier tools -> retryable", afterAuto.kind === "tool_failure" && afterAuto.retryable === true, afterAuto);

const afterTask = thrown(new Error("x"), ["searchKnowledgeBase", "createTask"]);
check("thrown after createTask ran -> NOT retryable", afterTask.kind === "tool_failure" && afterTask.retryable === false, afterTask);
check("thrown after createTask ran -> summary says what already went through", afterTask.summary.includes("creating the task"), afterTask.summary);

// ── anySideEffects: gates the client's Retry button ──
check("anySideEffects: no tools -> false", anySideEffects([]) === false);
check("anySideEffects: only auto-tier reads -> false", anySideEffects(["searchKnowledgeBase", "getCustomer", "resolveAudience"]) === false);
check("anySideEffects: a read then createTask -> true", anySideEffects(["searchKnowledgeBase", "createTask"]) === true);
check("anySideEffects: createLead -> true", anySideEffects(["createLead"]) === true);
check("anySideEffects: needs-approval tool -> true", anySideEffects(["sendEmail"]) === true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);