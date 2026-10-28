// Real draftEdit rules + real PATCH and POST handlers. Only the Supabase REST
// layer and Resend's HTTP call are stubbed. No env file, no network. Run:
//   npx tsx scripts/test-edit-endpoint.ts

export {};

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_SANDBOX_MODE = "false";

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

// ── In-memory stand-in for the pending_actions row and the trace table ───────
interface Row {
    id: string;
    trace_id: string;
    tool_name: string;
    status: string;
    proposed_args: Record<string, unknown>;
}

const db = {
    row: null as Row | null,
    patchCount: 0,
    traceRows: [] as Record<string, unknown>[],
    resendSends: [] as { to: string; subject: string; text: string }[],
    failPatch: false,
    // Flip the status right after the next read, to simulate approval winning a race.
    flipAfterGet: false,
};

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function matches(row: Row, params: URLSearchParams): boolean {
    for (const [key, value] of params.entries()) {
        if (!value.startsWith("eq.")) continue;
        const wanted = value.slice(3);
        if (String((row as unknown as Record<string, unknown>)[key]) !== wanted) return false;
    }
    return true;
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url));
    const method = (init?.method ?? "GET").toUpperCase();
    const wantsObject = (new Headers(init?.headers).get("accept") ?? "").includes("vnd.pgrst.object");

    if (url.hostname.includes("resend.com")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
        db.resendSends.push({ to: Array.isArray(body.to) ? String(body.to[0]) : String(body.to), subject: String(body.subject), text: String(body.text) });
        return json(200, { id: "stub-id" });
    }

    if (url.pathname.endsWith("/rest/v1/pending_actions") && method === "GET") {
        const row = db.row && matches(db.row, url.searchParams) ? db.row : null;
        if (!row) return json(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
        const snapshot = JSON.parse(JSON.stringify(row));
        if (db.flipAfterGet) {
            row.status = "approved";
            db.flipAfterGet = false;
        }
        return json(200, wantsObject ? snapshot : [snapshot]);
    }

    if (url.pathname.endsWith("/rest/v1/pending_actions") && method === "PATCH") {
        if (db.failPatch) return json(500, { message: "write failed" });
        db.patchCount++;
        const changes = JSON.parse(String(init?.body ?? "{}"));
        if (db.row && matches(db.row, url.searchParams)) {
            Object.assign(db.row, changes);
            return json(200, [{ id: db.row.id }]);
        }
        return json(200, []);
    }

    if (url.pathname.endsWith("/rest/v1/trace_logs") && method === "POST") {
        const parsed = JSON.parse(String(init?.body));
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) db.traceRows.push(entry as Record<string, unknown>);
        return json(201, []);
    }

    return json(500, { message: `unstubbed ${method} ${url.pathname}` });
}) as typeof fetch;

const RECIPIENTS = [
    { name: "Grace Adebayo", email: "grace.adebayo@solmarastudio.com" },
    { name: "Tunde Fashola", email: "tunde.fashola@solmarastudio.com" },
];

function seed(tool: string, extra: Record<string, unknown> = {}) {
    db.patchCount = 0;
    db.traceRows = [];
    db.resendSends = [];
    db.failPatch = false;
    db.flipAfterGet = false;
    db.row = {
        id: "act-1",
        trace_id: "trace-1",
        tool_name: tool,
        status: "pending",
        proposed_args:
            tool === "sendEmail"
                ? { to: "grace.adebayo@solmarastudio.com", subject: "Fuel receipts", body: "Please send the report.", ...extra }
                : { recipients: RECIPIENTS, subject: "Policy update", body: "Gloves are mandatory.", ...extra },
    };
}

async function main() {
    const { validateDraftEdit, SUBJECT_MAX, BODY_MAX } = await import("@/lib/agent/draftEdit");
    const { PATCH, POST } = await import("@/app/api/actions/[id]/route");
    const { NextRequest } = await import("next/server");

    // ── 1. The rules, with no database involved ───────────────────────────────
    const stored = { to: "a@b.co", subject: "Old subject", body: "Old body" };
    const rule = (payload: unknown, tool = "sendEmail") => validateDraftEdit(tool, stored, payload);

    check("only email and broadcast drafts are editable", !rule({ body: "x" }, "createTask").ok);
    check("a body-only edit keeps the stored subject", (() => { const r = rule({ body: "New body" }); return r.ok && r.subject === "Old subject" && r.body === "New body" && r.changed.join() === "body"; })());
    check("a subject-only edit keeps the stored body", (() => { const r = rule({ subject: "New subject" }); return r.ok && r.body === "Old body" && r.changed.join() === "subject"; })());
    check("editing both reports both as changed", (() => { const r = rule({ subject: "S", body: "B" }); return r.ok && r.changed.join() === "subject,body"; })());

    for (const key of ["recipients", "to"]) {
        const r = rule({ [key]: "x", body: "ok" });
        check(`"${key}" is rejected outright, even alongside a valid edit`, !r.ok && /Recipients can't be edited/.test(r.error), r);
    }
    for (const key of ["status", "tool_name", "proposed_args", "trace_id", "anything"]) {
        check(`unknown field "${key}" is rejected, not ignored`, !rule({ [key]: "x" }).ok);
    }
    check("an empty edit is rejected", !rule({}).ok);
    check("null, arrays and strings are rejected", !rule(null).ok && !rule([]).ok && !rule("body").ok);
    check("a non-text subject or body is rejected", !rule({ subject: 5 }).ok && !rule({ body: { a: 1 } }).ok);
    check("whitespace-only text counts as empty", !rule({ body: "   \n " }).ok && !rule({ subject: "  " }).ok);
    check("a subject at the limit is fine, one over is not", rule({ subject: "s".repeat(SUBJECT_MAX) }).ok && !rule({ subject: "s".repeat(SUBJECT_MAX + 1) }).ok);
    check("a body at the limit is fine, one over is not", rule({ body: "b".repeat(BODY_MAX) }).ok && !rule({ body: "b".repeat(BODY_MAX + 1) }).ok);
    check("markdown typed by a person is cleaned like a model draft", (() => { const r = rule({ body: "Report in **48 hours**" }); return r.ok && r.body === "Report in 48 hours"; })());
    check("the same text as stored is not a change", (() => { const r = rule({ body: "Old body", subject: "Old subject" }); return r.ok && r.changed.length === 0; })());
    check("a whitespace-only difference is not a change", (() => { const r = rule({ body: "  Old body\n" }); return r.ok && r.changed.length === 0; })());
    check("an unreadable stored draft is refused", !validateDraftEdit("sendEmail", { to: "a@b.co" }, { body: "x" }).ok);

    // ── 2. The real PATCH handler ─────────────────────────────────────────────
    const patch = async (payload: unknown, id = "act-1") => {
        const res = await PATCH(new NextRequest(`http://localhost/api/actions/${id}`, { method: "PATCH", body: typeof payload === "string" ? payload : JSON.stringify(payload) }), { params: Promise.resolve({ id }) });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    seed("sendEmail");
    let r = await patch({ subject: "Fuel receipts: report due", body: "Please send the report in **48 hours**." });
    check("sendEmail: edit saved (200)", r.status === 200 && r.body.success === true, r);
    check("sendEmail: the stored draft now has the cleaned text", db.row?.proposed_args.body === "Please send the report in 48 hours." && db.row?.proposed_args.subject === "Fuel receipts: report due", db.row?.proposed_args);
    check("sendEmail: the response returns the cleaned text so the card can show it", r.body.body === "Please send the report in 48 hours.", r.body);
    check("sendEmail: the recipient address is untouched", db.row?.proposed_args.to === "grace.adebayo@solmarastudio.com");
    check("sendEmail: the action is still pending, not approved by editing", db.row?.status === "pending");

    seed("sendBroadcast");
    r = await patch({ body: "Gloves are mandatory unless clearly unnecessary." });
    check("sendBroadcast: edit saved", r.status === 200 && db.row?.proposed_args.body === "Gloves are mandatory unless clearly unnecessary.", r);
    check("sendBroadcast: the recipient list is exactly what it was", JSON.stringify(db.row?.proposed_args.recipients) === JSON.stringify(RECIPIENTS), db.row?.proposed_args.recipients);
    check("sendBroadcast: the subject, which wasn't sent, is untouched", db.row?.proposed_args.subject === "Policy update");

    seed("sendBroadcast");
    r = await patch({ recipients: [{ name: "Attacker", email: "attacker@example.com" }], body: "ok" });
    check("trying to change recipients: 400 and nothing written", r.status === 400 && db.patchCount === 0, r);
    check("...the stored recipients are exactly as before", JSON.stringify(db.row?.proposed_args.recipients) === JSON.stringify(RECIPIENTS));
    seed("sendEmail");
    r = await patch({ to: "attacker@example.com" });
    check("trying to change `to`: 400 and nothing written", r.status === 400 && db.patchCount === 0 && db.row?.proposed_args.to === "grace.adebayo@solmarastudio.com", r);

    seed("sendEmail");
    r = await patch({ body: "Please send the report." });
    check("no real change: 200 unchanged, nothing written, nothing traced", r.status === 200 && r.body.unchanged === true && db.patchCount === 0 && db.traceRows.length === 0, r);

    seed("sendEmail");
    db.row!.status = "approved";
    r = await patch({ body: "late edit" });
    check("an action that is no longer pending: 404", r.status === 404, r);
    check("...and nothing was written", db.patchCount === 0);

    seed("sendEmail");
    r = await patch({ body: "x" }, "some-other-id");
    check("an unknown action id: 404", r.status === 404, r);

    seed("sendEmail");
    r = await patch("{not json");
    check("invalid JSON: 400, not a crash", r.status === 400, r);

    seed("sendEmail");
    db.flipAfterGet = true;
    r = await patch({ body: "edit that loses the race" });
    check("approved between the read and the write: 409", r.status === 409, r);
    check("...and the edit was NOT applied to the approved action", db.row?.proposed_args.body === "Please send the report.", db.row?.proposed_args);
    check("...and no audit row claims an edit happened", db.traceRows.length === 0, db.traceRows);

    seed("sendEmail");
    db.failPatch = true;
    r = await patch({ body: "will not save" });
    check("a database write failure: 500 with a plain message, draft unchanged", r.status === 500 && typeof r.body.error === "string" && db.row?.proposed_args.body === "Please send the report.", r);

    // ── 3. The audit trail ────────────────────────────────────────────────────
    seed("sendEmail");
    await patch({ body: "First edit" });
    await patch({ body: "Second edit" });
    const edits = db.traceRows.filter((t) => (t.input as { event?: string })?.event === "human_edit");
    check("every saved edit is traced", edits.length === 2, db.traceRows);
    check("the first trace row holds the MODEL'S original text", (edits[0]?.output as { before: { body: string } })?.before.body === "Please send the report.", edits[0]?.output);
    check("...and what the person changed it to", (edits[0]?.output as { after: { body: string } })?.after.body === "First edit");
    check("a second edit's 'before' is the first edit's 'after'", (edits[1]?.output as { before: { body: string } })?.before.body === "First edit", edits[1]?.output);
    check("the trace is attached to the action's own trace id and records which fields changed", edits[0]?.trace_id === "trace-1" && JSON.stringify((edits[0]?.input as { fields: string[] }).fields) === JSON.stringify(["body"]), edits[0]);

    // ── 4. The point of the feature: approve sends what was edited ────────────
    seed("sendBroadcast");
    await patch({ subject: "Gloves: mandatory from Monday", body: "Nitrile gloves are mandatory from Monday." });
    const approve = await POST(new NextRequest("http://localhost/api/actions/act-1", { method: "POST", body: JSON.stringify({ action: "approve" }) }), { params: Promise.resolve({ id: "act-1" }) });
    const approved = (await approve.json()) as Record<string, unknown>;
    check("approving after an edit succeeds", approve.status === 200 && approved.success === true, approved);
    check("every recipient received the EDITED subject and body, not the model's", db.resendSends.length === 2 && db.resendSends.every((s) => s.subject === "Gloves: mandatory from Monday" && s.text === "Nitrile gloves are mandatory from Monday."), db.resendSends);
    check("...at exactly the original recipients' addresses", db.resendSends.map((s) => s.to).join() === RECIPIENTS.map((x) => x.email).join(), db.resendSends.map((s) => s.to));
    check("...and the action is now approved, so it can't be edited again", db.row?.status === "approved");
    const lateEdit = await patch({ body: "edit after sending" });
    check("editing after approval is refused (404)", lateEdit.status === 404, lateEdit);

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});