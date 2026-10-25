// Real recipientCheck + real executeTool. Only the Supabase REST layer is
// stubbed. No env file, no network. Run:
//   npx tsx scripts/test-recipient-check.ts

export {};

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

const stub = {
    contacts: {} as Record<string, string[]>,
    failTables: false,
    likePatterns: [] as string[],
    contactRequests: 0,
    insertedActions: [] as Record<string, unknown>[],
};

function resetStub() {
    stub.contacts = { employees: [], customers: [], leads: [] };
    stub.failTables = false;
    stub.likePatterns = [];
    stub.contactRequests = 0;
    stub.insertedActions = [];
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url));
    const method = (init?.method ?? "GET").toUpperCase();
    const wantsObject = (new Headers(init?.headers).get("accept") ?? "").includes("vnd.pgrst.object");
    const table = url.pathname.split("/").pop() ?? "";

    if (table in stub.contacts && method === "GET") {
        stub.contactRequests++;
        if (stub.failTables) return json(500, { message: "db down" });
        const pattern = (url.searchParams.get("email") ?? "").replace(/^ilike\./, "");
        stub.likePatterns.push(pattern);
        // ilike with backslash escapes: unescape, then compare case-insensitively
        const wanted = pattern.replace(/\\([\\%_])/g, "$1").toLowerCase();
        const rows = stub.contacts[table].filter((e) => e.toLowerCase() === wanted).map((email) => ({ email }));
        return json(200, rows);
    }

    if (table === "pending_actions" && method === "POST") {
        const row = { id: "pending-1", ...JSON.parse(String(init?.body)) };
        stub.insertedActions.push(row);
        return json(201, wantsObject ? row : [row]);
    }
    if (table === "trace_logs" && method === "POST") return json(201, []);

    return json(500, { message: `unstubbed ${method} ${url.pathname}` });
}) as typeof fetch;

async function main() {
    const { normalizeAddress, typedByUser, checkEmailRecipient } = await import("@/lib/agent/recipientCheck");
    const { executeTool } = await import("@/lib/agent/executor");

    // ── 1. Address parsing ────────────────────────────────────────────────────
    check("normalizes case and whitespace", normalizeAddress("  Grace.Adebayo@SolmaraStudio.com ") === "grace.adebayo@solmarastudio.com");
    check("strips mailto: and angle brackets", normalizeAddress("<mailto:a@b.co>") === "a@b.co" && normalizeAddress("<a@b.co>") === "a@b.co");
    check("rejects things that aren't addresses", normalizeAddress("the catering team") === null && normalizeAddress("a@b") === null && normalizeAddress("") === null);
    check("rejects non-strings", normalizeAddress(undefined) === null && normalizeAddress(42) === null);

    // ── 2. What counts as "typed by the user" ─────────────────────────────────
    check("an address the user typed counts", typedByUser("amaka@bridalcouture.ng", ["email amaka@bridalcouture.ng about the fitting"]));
    check("...in any of their messages", typedByUser("a@b.co", ["hello", "use a@b.co please"]));
    check("...case-insensitively", typedByUser("a@b.co", ["Use A@B.CO"]));
    check("...even with punctuation after it", typedByUser("a@b.co", ["send it to a@b.co."]));
    check("a longer address does NOT vouch for a shorter one", !typedByUser("ann@x.com", ["write to joann@x.com"]));
    check("nothing typed -> not vouched for", !typedByUser("a@b.co", ["email the catering team"]));

    // ── 3. Against the known-contact tables ───────────────────────────────────
    resetStub();
    stub.contacts.employees = ["grace.adebayo@solmarastudio.com"];
    stub.contacts.customers = ["amaka@bridalcouture.ng"];
    stub.contacts.leads = ["lead_one@acme.io"];

    check("a known employee passes", (await checkEmailRecipient("grace.adebayo@solmarastudio.com", [])).ok);
    check("a known customer passes", (await checkEmailRecipient("AMAKA@bridalcouture.ng", [])).ok);
    check("a known lead passes", (await checkEmailRecipient("lead_one@acme.io", [])).ok);
    check("underscores are escaped so they aren't treated as wildcards", stub.likePatterns.some((p) => p.includes("lead\\_one")), stub.likePatterns);

    const invented = await checkEmailRecipient("catering-team@solmara.com", ["email the catering team about the menu"]);
    check("THE INCIDENT: an invented team address is refused", !invented.ok, invented);
    check("...and the reason steers to a broadcast, not a crash", !invented.ok && /broadcast/i.test(invented.reason), invented);
    check("...and says why", !invented.ok && invented.reason.includes("catering-team@solmara.com") && /didn't type it/.test(invented.reason), invented);

    check("a near-miss of a real address is refused", !(await checkEmailRecipient("grace.adebayo@solmara.com", [])).ok);
    check("a malformed address is refused", !(await checkEmailRecipient("the catering team", [])).ok);

    // ── 4. Failing closed ─────────────────────────────────────────────────────
    resetStub();
    stub.failTables = true;
    const downCheck = await checkEmailRecipient("someone@example.com", []);
    check("every lookup failing -> refuse, don't wave it through", !downCheck.ok, downCheck);
    check("...and say it was a lookup problem, not a bad address", !downCheck.ok && /couldn't check/.test(downCheck.reason), downCheck);
    stub.contactRequests = 0;
    const typedWhileDown = await checkEmailRecipient("someone@example.com", ["send to someone@example.com"]);
    check("an address the user typed still works when lookups are down", typedWhileDown.ok === true, typedWhileDown);
    check("...without touching the database at all", stub.contactRequests === 0, stub.contactRequests);

    // ── 5. Through the real executor ──────────────────────────────────────────
    resetStub();
    stub.contacts.employees = ["grace.adebayo@solmarastudio.com"];
    const draft = { subject: "Cocktail and menu options", body: "Hi team" };

    const refused = await executeTool("sendEmail", { to: "catering-team@solmara.com", ...draft }, "trace-1", ["draft a mail to the catering team"]);
    check("executor: an invented address does not produce an approval card", refused.type === "result", refused.type);
    check("executor: nothing was stored for approval", stub.insertedActions.length === 0, stub.insertedActions);
    if (refused.type === "result") {
        check("executor: reported as a failed result", refused.result.success === false);
        check("executor: classified as misunderstood/invalid_input (nothing broke)", refused.errorInfo?.kind === "misunderstood" && refused.errorInfo.reason === "invalid_input", refused.errorInfo);
        check("executor: the summary is the readable reason, without the internal prefix", refused.errorInfo?.summary.startsWith("I don't have an email address") === true, refused.errorInfo?.summary);
    }

    const known = await executeTool("sendEmail", { to: "grace.adebayo@solmarastudio.com", ...draft }, "trace-2", []);
    check("executor: a known employee still gets an approval card", known.type === "pending" && stub.insertedActions.length === 1, known.type);

    stub.contactRequests = 0;
    const typed = await executeTool("sendEmail", { to: "friend@example.org", ...draft }, "trace-3", ["send it to friend@example.org"]);
    check("executor: an address the user typed gets an approval card", typed.type === "pending", typed.type);
    check("executor: ...without a database lookup", stub.contactRequests === 0, stub.contactRequests);

    const before = stub.insertedActions.length;
    const broadcast = await executeTool("sendBroadcast", { recipients: [{ name: "X", email: "x@nowhere.test" }], ...draft }, "trace-4", []);
    check("executor: sendBroadcast is not subject to this check", broadcast.type === "pending" && stub.insertedActions.length === before + 1, broadcast.type);

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});