// Real retry route handler. Only the Supabase REST layer is stubbed (an
// in-memory pending_actions + trace_logs). No env file, no network. Run:
//   npx tsx scripts/test-retry-endpoint.ts

export { };

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

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

interface StubDb {
    pending: Record<string, unknown> | null;
    traceRows: { output: unknown }[];
    insertedActions: Record<string, unknown>[];
    insertedTrace: Record<string, unknown>[];
}

let db: StubDb = { pending: null, traceRows: [], insertedActions: [], insertedTrace: [] };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Just enough PostgREST to satisfy supabase-js for the calls the route makes.
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url));
    const method = (init?.method ?? "GET").toUpperCase();
    const wantsObject = (new Headers(init?.headers).get("accept") ?? "").includes("vnd.pgrst.object");

    if (url.pathname.endsWith("/rest/v1/pending_actions") && method === "GET") {
        if (!db.pending) {
            return json(406, { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "JSON object requested, multiple (or no) rows returned" });
        }
        return json(200, wantsObject ? db.pending : [db.pending]);
    }

    if (url.pathname.endsWith("/rest/v1/trace_logs") && method === "GET") {
        return json(200, db.traceRows);
    }

    if (url.pathname.endsWith("/rest/v1/pending_actions") && method === "POST") {
        const row = { id: "new-action-id", ...JSON.parse(String(init?.body)) };
        db.insertedActions.push(row);
        return json(201, wantsObject ? row : [row]);
    }

    if (url.pathname.endsWith("/rest/v1/trace_logs") && method === "POST") {
        const parsed = JSON.parse(String(init?.body));
        for (const row of Array.isArray(parsed) ? parsed : [parsed]) db.insertedTrace.push(row);
        return json(201, []);
    }

    return json(500, { message: `unstubbed ${method} ${url.pathname}` });
}) as typeof fetch;

const RECIPIENTS = [
    { name: "Steven Ulich", email: "steven.ulich@solmarastudio.com" },
    { name: "Amina Bello", email: "amina.bello@solmarastudio.com" },
    { name: "Chidi Okonkwo", email: "chidi.okonkwo@solmarastudio.com" },
];

function approvedBroadcast(extra: Record<string, unknown> = {}) {
    return {
        id: "orig-action",
        trace_id: "orig-trace",
        tool_name: "sendBroadcast",
        status: "approved",
        proposed_args: { recipients: RECIPIENTS, subject: "Policy update", body: "Gloves are mandatory." },
        ...extra,
    };
}

function sendRecord(flags: boolean[]) {
    return {
        output: {
            success: true,
            data: {
                results: RECIPIENTS.map((r, i) => ({ name: r.name, email: r.email, success: flags[i] })),
            },
        },
    };
}

function reset(partial: Partial<StubDb>) {
    db = { pending: null, traceRows: [], insertedActions: [], insertedTrace: [], ...partial };
}

async function main() {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/actions/[id]/retry/route");

    const call = async (id = "orig-action") => {
        const res = await POST(new NextRequest(`http://localhost/api/actions/${id}/retry`, { method: "POST", body: "{}" }), { params: Promise.resolve({ id }) });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // 1. Partial: only the failed recipient is retried.
    reset({
        pending: approvedBroadcast(),
        // proposed-row first (no output), then the approve run, newest first
        traceRows: [sendRecord([false, true, true]), { output: null }],
    });
    let r = await call();
    const args = r.body.args as { recipients: { email: string }[]; subject: string; body: string } | undefined;
    check("partial: 200 with a pending action to approve", r.status === 200 && typeof r.body.pendingActionId === "string", r);
    check("partial: retry list is exactly the failed recipient", args?.recipients.length === 1 && args.recipients[0].email === RECIPIENTS[0].email, args?.recipients);
    check("partial: subject and body carried over unchanged", args?.subject === "Policy update" && args?.body === "Gloves are mandatory.", args);
    const inserted = db.insertedActions[0] as { status?: string; tool_name?: string; trace_id?: string } | undefined;
    check("partial: created as status 'pending' (nothing is sent here)", inserted?.status === "pending" && inserted?.tool_name === "sendBroadcast", inserted);
    check("partial: gets its own trace id, not the original's", typeof inserted?.trace_id === "string" && inserted.trace_id !== "orig-trace", inserted);
    check("partial: trace rows written, including a pointer to the original", db.insertedTrace.length === 2 && JSON.stringify(db.insertedTrace[0]).includes("orig-action"), db.insertedTrace);
    check("partial: the proposed-action trace row is pending_approval", db.insertedTrace.some((t) => t.status === "pending_approval"), db.insertedTrace);

    // 2. All failed: everyone is retried.
    reset({ pending: approvedBroadcast(), traceRows: [sendRecord([false, false, false])] });
    r = await call();
    const allArgs = r.body.args as { recipients: unknown[] } | undefined;
    check("all failed: all three original recipients are retried", r.status === 200 && allArgs?.recipients.length === 3, r);

    // 3. Nothing failed: refuse.
    reset({ pending: approvedBroadcast(), traceRows: [sendRecord([true, true, true])] });
    r = await call();
    check("nothing failed: 409, no action created", r.status === 409 && db.insertedActions.length === 0, r);

    // 4. No per-recipient record: refuse, do not guess.
    reset({ pending: approvedBroadcast(), traceRows: [{ output: null }, { output: { error: "boom" } }] });
    r = await call();
    check("no send record: 409, no action created", r.status === 409 && db.insertedActions.length === 0, r);
    check("no send record: says why instead of guessing", String(r.body.error).includes("couldn't find a record"), r.body);

    // 5. Not an approved action: 404.
    reset({ pending: null });
    r = await call("missing");
    check("unknown or not-approved action: JSON 404", r.status === 404 && typeof r.body.error === "string", r);

    // 6. Wrong tool: refuse.
    reset({ pending: approvedBroadcast({ tool_name: "sendEmail" }), traceRows: [sendRecord([false, true, true])] });
    r = await call();
    check("non-broadcast tool: 400, no action created", r.status === 400 && db.insertedActions.length === 0, r);

    // 7. Safety: a failure for an address that was never a recipient is ignored.
    reset({
        pending: approvedBroadcast(),
        traceRows: [
            {
                output: {
                    data: {
                        results: [
                            { name: "Steven Ulich", email: RECIPIENTS[0].email, success: false },
                            { name: "Rogue", email: "attacker@example.com", success: false },
                        ],
                    },
                },
            },
        ],
    });
    r = await call();
    const rogueArgs = r.body.args as { recipients: { email: string }[] } | undefined;
    check("safety: addresses not in the original list never make it in", rogueArgs?.recipients.length === 1 && rogueArgs.recipients[0].email === RECIPIENTS[0].email, rogueArgs?.recipients);
    check("safety: retry list is always a subset of the original recipients", (rogueArgs?.recipients ?? []).every((x) => RECIPIENTS.some((o) => o.email === x.email)), rogueArgs?.recipients);

    // 8. Case differences and duplicate failure entries do not duplicate recipients.
    reset({
        pending: approvedBroadcast(),
        traceRows: [
            {
                output: {
                    data: {
                        results: [
                            { name: "Steven Ulich", email: RECIPIENTS[0].email.toUpperCase(), success: false },
                            { name: "Steven Ulich", email: RECIPIENTS[0].email, success: false },
                        ],
                    },
                },
            },
        ],
    });
    r = await call();
    const dedupeArgs = r.body.args as { recipients: unknown[] } | undefined;
    check("dedupe: email case and repeated entries give one recipient", r.status === 200 && dedupeArgs?.recipients.length === 1, dedupeArgs?.recipients);

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});