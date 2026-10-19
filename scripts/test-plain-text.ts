// Real toPlainText + real executeTool. Only the Supabase REST layer is stubbed
// for the executor check. No env file, no network. Run:
//   npx tsx scripts/test-plain-text.ts

export { };

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.RESEND_API_KEY = "re_test";
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

const inserted: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url));
    const method = (init?.method ?? "GET").toUpperCase();
    const wantsObject = (new Headers(init?.headers).get("accept") ?? "").includes("vnd.pgrst.object");
    const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.pathname.endsWith("/rest/v1/pending_actions") && method === "POST") {
        const row = { id: "pending-1", ...JSON.parse(String(init?.body)) };
        inserted.push(row);
        return respond(201, wantsObject ? row : [row]);
    }
    if (url.pathname.endsWith("/rest/v1/trace_logs") && method === "POST") return respond(201, []);
    return respond(500, { message: `unstubbed ${method} ${url.pathname}` });
}) as typeof fetch;

async function main() {
    const { toPlainText, cleanDraftArgs } = await import("@/lib/agent/draftText");
    const { executeTool } = await import("@/lib/agent/executor");

    // ── 1. The real draft from the Oct 10 trace ───────────────────────────────
    const realBody =
        "Hi team,\n\nA task has been created for Logistics to investigate the missing fuel card receipts (Task ID: 643c7d66-c928-4dd1-a3b8-ccb1c9cced21). Please follow the fuel and vehicle-use procedure outlined in our logistics policy, ensuring all receipts are reconciled and any discrepancies are escalated.\n\nKindly provide a detailed report of your findings and corrective actions within **48 hours**.\n\nThank you for your prompt attention.\n\nThe Solmara Studio Team";
    const cleaned = toPlainText(realBody);

    console.log("\n      BEFORE (what recipients would have received):");
    console.log("      " + realBody.split("\n").find((l) => l.includes("48 hours")));
    console.log("      AFTER:");
    console.log("      " + cleaned.split("\n").find((l) => l.includes("48 hours")) + "\n");

    check("real draft: the literal asterisks are gone", !cleaned.includes("**"));
    check("real draft: the words around them are untouched", cleaned.includes("corrective actions within 48 hours."));
    check("real draft: only the 4 asterisks were removed, nothing else changed", realBody.length - cleaned.length === 4, realBody.length - cleaned.length);
    check("real draft: paragraphs and line breaks preserved", cleaned.split("\n").length === realBody.split("\n").length);
    check("real draft: the task id and the sign-off are intact", cleaned.includes("643c7d66-c928-4dd1-a3b8-ccb1c9cced21") && cleaned.endsWith("The Solmara Studio Team"));

    // ── 2. What it strips ─────────────────────────────────────────────────────
    check("bold with underscores", toPlainText("Please reply __today__ by noon") === "Please reply today by noon");
    check("header marker removed, text kept", toPlainText("## Action required\nPlease confirm") === "Action required\nPlease confirm");
    check("inline code", toPlainText("Use the `fuel-card` form") === "Use the fuel-card form");
    check("asterisk bullets become hyphen bullets", toPlainText("* first\n* second") === "- first\n- second");
    check("italics", toPlainText("This is *very* important") === "This is very important");
    check("markdown link keeps its destination visible", toPlainText("See [the policy](https://example.com/p) first") === "See the policy (https://example.com/p) first");
    check("bold wrapped around several words", toPlainText("**Detailed report in 48 hours**") === "Detailed report in 48 hours");
    check("triple asterisks", toPlainText("***urgent***") === "urgent");

    // ── 3. What it must NOT touch ─────────────────────────────────────────────
    const untouched: [string, string][] = [
        ["arithmetic with spaces", "Total: 5 * 3 * 2 units"],
        ["arithmetic without spaces", "Compute 2*3*4 first"],
        ["snake_case names", "Use the fuel_card_receipts table"],
        ["a url with underscores", "https://example.com/a__b__c/file_name"],
        ["naira amounts", "Retainer is ₦450,000/month"],
        ["numbered list", "1. First\n2. Second"],
        ["hyphen bullets", "- First\n- Second"],
        ["a lone asterisk", "Note* see below"],
        ["an unmatched bold marker", "Total **pending"],
        ["a hash inside a sentence", "Task #42 is open"],
        ["an email address", "Write to grace.adebayo@solmarastudio.com"],
        ["plain text with a colon list", "Items: gloves, masks, aprons"],
    ];
    for (const [label, text] of untouched) {
        check(`unchanged: ${label}`, toPlainText(text) === text, toPlainText(text));
    }

    check("cleaning twice changes nothing more", toPlainText(toPlainText(realBody)) === toPlainText(realBody));
    check("an empty string stays empty", toPlainText("") === "");

    // ── 4. Only the email tools, only subject and body ────────────────────────
    const broadcastArgs = {
        recipients: [{ name: "Grace *Adebayo*", email: "grace_@x.com" }],
        subject: "**Task** assigned",
        body: "Within **48 hours**",
    };
    const cleanedArgs = cleanDraftArgs("sendBroadcast", broadcastArgs) as typeof broadcastArgs;
    check("broadcast subject cleaned", cleanedArgs.subject === "Task assigned");
    check("broadcast body cleaned", cleanedArgs.body === "Within 48 hours");
    check("recipients are never read or modified", JSON.stringify(cleanedArgs.recipients) === JSON.stringify(broadcastArgs.recipients));
    check("the original args object is not mutated", broadcastArgs.body === "Within **48 hours**");
    check("sendEmail is covered too", (cleanDraftArgs("sendEmail", { to: "a@b.com", subject: "s", body: "**x**" }) as { body: string }).body === "x");
    const taskArgs = { title: "**keep**", description: "**keep**" };
    check("other tools are returned untouched", cleanDraftArgs("createTask", taskArgs) === taskArgs);

    // ── 5. End to end: the approval card gets the cleaned draft ───────────────
    const result = await executeTool(
        "sendBroadcast",
        { recipients: [{ name: "Grace Adebayo", email: "grace.adebayo@solmarastudio.com" }], subject: "Task Assigned", body: realBody },
        "trace-test"
    );
    const pendingBody = result.type === "pending" ? String(result.args.body) : "";
    const storedBody = String((inserted[0]?.proposed_args as { body?: string } | undefined)?.body ?? "");

    check("executor: a needs-approval tool still halts for approval", result.type === "pending", result.type);
    check("executor: the args the approval card shows are cleaned", pendingBody === cleaned, pendingBody.slice(0, 80));
    check("executor: the action stored for approval is the cleaned draft", storedBody === cleaned, storedBody.slice(0, 80));
    check("executor: so what is approved is exactly what the approve route will send", storedBody === pendingBody);

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});