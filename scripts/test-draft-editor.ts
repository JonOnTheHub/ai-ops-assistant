// Real DraftEditor in a real DOM (jsdom + Testing Library). Server responses are
// stubbed per case, and the last case runs against the REAL PATCH handler with
// an in-memory database, so the component and the server are tested against
// each other. No env file, no network. Needs dev dependencies:
//   npm install -D jsdom @testing-library/react @testing-library/dom
// Run:
//   npx tsx scripts/test-draft-editor.ts

import { JSDOM } from "jsdom";
import { createElement } from "react";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
// Importing the real route pulls in the email tools, which build a client at import.
process.env.RESEND_API_KEY = "re_test";
process.env.GROQ_API_KEY = "gsk_test";
process.env.VOYAGE_API_KEY = "test-key";

// ── A DOM, before React or Testing Library are loaded ────────────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (key in g) continue;
    try {
        g[key] = (dom.window as unknown as Record<string, unknown>)[key];
    } catch {
        // a few window properties are getter-only; they are not needed here
    }
}
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.IS_REACT_ACT_ENVIRONMENT = true;

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

// ── Stubbed server ───────────────────────────────────────────────────────────
interface Sent {
    url: string;
    method: string;
    body: Record<string, unknown>;
}

const net = {
    sent: [] as Sent[],
    // What the stubbed save endpoint answers, per case.
    respond: ((): Response => new Response("{}", { status: 200 })) as (sent: Sent) => Response | Promise<Response>,
    throwNetworkError: false,
    // When set, requests to /api/actions/ are routed to the REAL PATCH handler.
    realHandler: null as null | ((url: string, init: RequestInit) => Promise<Response>),
    row: null as null | { id: string; trace_id: string; tool_name: string; status: string; proposed_args: Record<string, unknown> },
};

const jsonResponse = (status: number, body: unknown, type = "application/json") =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url);

    if (url.startsWith("/api/actions/")) {
        const sent: Sent = { url, method: (init?.method ?? "GET").toUpperCase(), body: JSON.parse(String(init?.body ?? "{}")) };
        net.sent.push(sent);
        if (net.throwNetworkError) throw new TypeError("Failed to fetch");
        if (net.realHandler) return net.realHandler(url, init ?? {});
        return net.respond(sent);
    }

    // The real handler's own Supabase calls, answered from the in-memory row.
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const wantsObject = (new Headers(init?.headers).get("accept") ?? "").includes("vnd.pgrst.object");
    if (parsed.pathname.endsWith("/rest/v1/pending_actions") && net.row) {
        const matches = [...parsed.searchParams.entries()].every(([k, v]) => !v.startsWith("eq.") || String((net.row as unknown as Record<string, unknown>)[k]) === v.slice(3));
        if (method === "GET") return matches ? jsonResponse(200, wantsObject ? net.row : [net.row]) : jsonResponse(406, { code: "PGRST116", message: "none" });
        if (method === "PATCH") {
            if (!matches) return jsonResponse(200, []);
            Object.assign(net.row, JSON.parse(String(init?.body)));
            return jsonResponse(200, [{ id: net.row.id }]);
        }
    }
    if (parsed.pathname.endsWith("/rest/v1/trace_logs")) return jsonResponse(201, []);
    return jsonResponse(500, { message: `unstubbed ${method} ${url}` });
}) as typeof fetch;

const ok = (subject: string, body: string) => jsonResponse(200, { success: true, unchanged: false, subject, body });

async function main() {
    const { render, screen, fireEvent, waitFor, cleanup, act } = await import("@testing-library/react");
    const { DraftEditor } = await import("@/components/DraftEditor");
    const { SUBJECT_MAX, BODY_MAX } = await import("@/lib/agent/draftEdit");

    interface MountOptions {
        toolName?: string;
        subject?: string;
        body?: string;
        locked?: boolean;
    }
    const mount = (options: MountOptions = {}) => {
        const states: { editing: boolean; saving: boolean }[] = [];
        const props = {
            actionId: "act-1",
            toolName: options.toolName ?? "sendEmail",
            subject: "subject" in options ? options.subject : "Fuel receipts",
            body: "body" in options ? options.body : "Please send the report.",
            locked: options.locked ?? false,
            onStateChange: (s: { editing: boolean; saving: boolean }) => states.push(s),
        };
        const view = render(createElement(DraftEditor, props));
        return { states, rerender: (next: Partial<typeof props>) => view.rerender(createElement(DraftEditor, { ...props, ...next })) };
    };
    const reset = () => {
        cleanup();
        net.sent = [];
        net.throwNetworkError = false;
        net.realHandler = null;
        net.row = null;
        net.respond = () => jsonResponse(200, {});
    };
    const subjectBox = () => screen.getByRole("textbox", { name: "Subject" }) as HTMLInputElement;
    const bodyBox = () => screen.getByRole("textbox", { name: "Message body" }) as HTMLTextAreaElement;
    const saveButton = () => screen.getByRole("button", { name: /save edits|saving/i }) as HTMLButtonElement;
    const editButton = () => screen.getByRole("button", { name: /edit draft/i });
    const typeBody = (value: string) => fireEvent.change(bodyBox(), { target: { value } });
    const typeSubject = (value: string) => fireEvent.change(subjectBox(), { target: { value } });
    const openEditor = () => fireEvent.click(editButton());

    // ── 1. Read view ──────────────────────────────────────────────────────────
    reset();
    let m = mount();
    check("read view shows the subject and the body", !!screen.getByText("Fuel receipts") && !!screen.getByText("Please send the report."));
    check("read view offers an Edit draft button", !!editButton());
    check("read view has no text boxes", screen.queryAllByRole("textbox").length === 0);
    check("mounting reports nothing to the card", m.states.length === 0, m.states);

    reset();
    mount({ toolName: "createTask" });
    check("a tool that isn't an email or broadcast has no Edit button", screen.queryByRole("button", { name: /edit draft/i }) === null);
    check("...but its text is still shown", !!screen.getByText("Please send the report."));

    reset();
    mount({ subject: undefined });
    check("a draft missing its subject can't be edited", screen.queryByRole("button", { name: /edit draft/i }) === null);

    reset();
    mount({ locked: true });
    check("a locked card (approving, rejecting or done) has no Edit button", screen.queryByRole("button", { name: /edit draft/i }) === null);

    // ── 2. Edit mode ──────────────────────────────────────────────────────────
    reset();
    m = mount();
    openEditor();
    check("Edit shows a subject box and a body box with the current text", subjectBox().value === "Fuel receipts" && bodyBox().value === "Please send the report.");
    check("it tells the card editing started", JSON.stringify(m.states) === JSON.stringify([{ editing: true, saving: false }]), m.states);
    check("Save is off until something changes", saveButton().disabled === true);
    check("it says recipients can't be edited and that Approve is off", /Recipients can.t be edited here/.test(document.body.textContent ?? "") && /Approve is off/.test(document.body.textContent ?? ""));
    check("there is no recipient or address field to edit", screen.queryByRole("textbox", { name: /recipient|to/i }) === null);
    check("the counters start at the current lengths", (document.body.textContent ?? "").includes(`13 / ${SUBJECT_MAX}`) && (document.body.textContent ?? "").includes(`23 / ${BODY_MAX}`));

    // ── 3. Save: only what changed is sent ────────────────────────────────────
    net.respond = (sent) => ok("Fuel receipts", String(sent.body.body));
    typeBody("Please send the report within 48 hours.");
    check("typing enables Save", saveButton().disabled === false);
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByText("Please send the report within 48 hours."));
    check("exactly one PATCH was sent, to this action", net.sent.length === 1 && net.sent[0].method === "PATCH" && net.sent[0].url === "/api/actions/act-1", net.sent);
    check("only the CHANGED field was sent (no subject, no recipients)", JSON.stringify(Object.keys(net.sent[0].body)) === JSON.stringify(["body"]), net.sent[0].body);
    check("after saving it leaves edit mode and shows the new text", screen.queryAllByRole("textbox").length === 0);
    check("it is marked as edited by you", /Edited by you/i.test(document.body.textContent ?? ""));
    check("the card was told: saving, then done", JSON.stringify(m.states) === JSON.stringify([{ editing: true, saving: false }, { editing: true, saving: true }, { editing: false, saving: false }]), m.states);

    // ── 4. What is shown is what the SERVER stored ────────────────────────────
    reset();
    m = mount();
    openEditor();
    net.respond = () => ok("Fuel receipts", "Report due in 48 hours.");
    typeBody("Report due in **48 hours**.");
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByText("Report due in 48 hours."));
    check("the cleaned text the server returned is shown, not the typed markdown", !(document.body.textContent ?? "").includes("Report due in **48 hours**"));
    check("it explains the formatting was removed", /plain text/i.test(document.body.textContent ?? "") && /removed/i.test(document.body.textContent ?? ""));

    // ── 5. Validation happens before any request ──────────────────────────────
    reset();
    mount();
    openEditor();
    typeSubject("   ");
    check("an empty subject is flagged and Save is off", /subject can.t be empty/i.test(document.body.textContent ?? "") && saveButton().disabled);
    typeSubject("Fuel receipts");
    typeBody("");
    check("an empty body is flagged and Save is off", /message can.t be empty/i.test(document.body.textContent ?? "") && saveButton().disabled);
    typeBody("b".repeat(BODY_MAX + 5));
    check("a body over the limit says by how much and Save is off", /5 characters too long/.test(document.body.textContent ?? "") && saveButton().disabled);
    typeBody("b".repeat(BODY_MAX));
    check("exactly at the limit is fine", saveButton().disabled === false);
    typeSubject("s".repeat(SUBJECT_MAX + 1));
    check("a subject over the limit blocks Save too", /too long/.test(document.body.textContent ?? "") && saveButton().disabled);
    check("none of that sent a request", net.sent.length === 0, net.sent);

    // ── 6. Every way a save can fail keeps the draft and says why ─────────────
    const failureCase = async (label: string, arrange: () => void, expected: RegExp) => {
        reset();
        const mounted = mount();
        openEditor();
        arrange();
        typeBody("My careful rewrite");
        fireEvent.click(saveButton());
        await waitFor(() => screen.getByRole("alert"));
        const alertText = screen.getByRole("alert").textContent ?? "";
        check(`${label}: shows a message`, expected.test(alertText), alertText);
        check(`${label}: stays in edit mode with the typed text intact`, bodyBox().value === "My careful rewrite");
        check(`${label}: Save is available again to retry`, saveButton().disabled === false);
        check(`${label}: the card is told saving stopped but editing continues`, JSON.stringify(mounted.states.at(-1)) === JSON.stringify({ editing: true, saving: false }), mounted.states);
        fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
        check(`${label}: Cancel then shows the last SAVED text, not the failed edit`, !!screen.getByText("Please send the report."));
    };
    await failureCase("validation rejected (400)", () => { net.respond = () => jsonResponse(400, { error: "The message is too long (10005 characters; the limit is 10000)." }); }, /too long/);
    await failureCase("approved mid-edit (409)", () => { net.respond = () => jsonResponse(409, { error: "This action was resolved while you were editing, so the edit wasn't saved." }); }, /resolved while you were editing/);
    await failureCase("already resolved (404 JSON)", () => { net.respond = () => jsonResponse(404, { error: "Pending action not found or already resolved" }); }, /already resolved/);
    await failureCase("server error (500)", () => { net.respond = () => jsonResponse(500, { error: "I couldn't save the edit, so the draft is unchanged." }); }, /couldn.t save the edit/);
    await failureCase("framework 404 page (route missing)", () => { net.respond = () => jsonResponse(404, "<html>Not found</html>", "text/html"); }, /endpoint wasn.t found.*nothing was saved/);
    await failureCase("some other non-JSON answer", () => { net.respond = () => jsonResponse(502, "bad gateway", "text/html"); }, /can.t tell whether the edit was saved/);
    await failureCase("network down", () => { net.throwNetworkError = true; }, /Couldn.t reach the server/);

    // ── 7. While saving ───────────────────────────────────────────────────────
    reset();
    m = mount();
    openEditor();
    let release: (r: Response) => void = () => {};
    net.respond = () => new Promise<Response>((resolve) => { release = resolve; });
    typeBody("Slow save");
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByRole("button", { name: /saving/i }));
    check("the button says Saving... and is off", saveButton().disabled && /Saving/.test(saveButton().textContent ?? ""));
    check("Cancel and the text boxes are off while saving", (screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled && bodyBox().disabled && subjectBox().disabled);
    check("the card is told a save is in flight", JSON.stringify(m.states.at(-1)) === JSON.stringify({ editing: true, saving: true }), m.states);
    fireEvent.click(saveButton());
    check("clicking Save again does not send a second request", net.sent.length === 1, net.sent.length);
    await act(async () => { release(ok("Fuel receipts", "Slow save")); });
    await waitFor(() => screen.getByText("Slow save"));
    check("it finishes and leaves edit mode", screen.queryAllByRole("textbox").length === 0);

    // ── 8. Cancel, reset and keyboard ─────────────────────────────────────────
    reset();
    m = mount();
    openEditor();
    typeBody("Something I will throw away");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    check("Cancel discards unsaved typing without any request", net.sent.length === 0 && !!screen.getByText("Please send the report."));
    check("Cancel tells the card editing ended", JSON.stringify(m.states.at(-1)) === JSON.stringify({ editing: false, saving: false }), m.states);
    openEditor();
    check("re-opening starts from the saved text, not the discarded typing", bodyBox().value === "Please send the report.");
    check("no 'Reset to original' while the draft IS the original", screen.queryByRole("button", { name: /reset to original/i }) === null);

    net.respond = (sent) => ok("Fuel receipts", String(sent.body.body));
    typeBody("Edited once");
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByText("Edited once"));
    openEditor();
    check("after an edit, 'Reset to original' appears", !!screen.getByRole("button", { name: /reset to original/i }));
    fireEvent.click(screen.getByRole("button", { name: /reset to original/i }));
    check("Reset puts the MODEL'S original text back in the box", bodyBox().value === "Please send the report.");
    check("...as an unsaved edit, so Save is on and nothing was sent by resetting", saveButton().disabled === false && net.sent.length === 1, net.sent.length);
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByText("Please send the report."));
    check("saving the reset restores the original and clears the 'edited' mark", !/Edited by you/i.test(document.body.textContent ?? ""));

    reset();
    mount();
    openEditor();
    typeBody("escape me");
    fireEvent.keyDown(bodyBox(), { key: "Escape" });
    check("Escape cancels", screen.queryAllByRole("textbox").length === 0 && net.sent.length === 0);
    openEditor();
    net.respond = (sent) => ok("Fuel receipts", String(sent.body.body));
    typeBody("saved by keyboard");
    fireEvent.keyDown(bodyBox(), { key: "Enter", ctrlKey: true });
    await waitFor(() => screen.getByText("saved by keyboard"));
    check("Ctrl+Enter saves", net.sent.length === 1);

    // ── 9. The card locking while the editor is open ──────────────────────────
    reset();
    m = mount();
    openEditor();
    m.rerender({ locked: true });
    check("if the card locks (for example Reject was pressed), the editor closes", screen.queryAllByRole("textbox").length === 0);
    check("...and offers no way to start editing", screen.queryByRole("button", { name: /edit draft/i }) === null);

    // ── 10. Against the REAL server handler ───────────────────────────────────
    reset();
    const { PATCH } = await import("@/app/api/actions/[id]/route");
    const { NextRequest } = await import("next/server");
    const recipients = [{ name: "Grace Adebayo", email: "grace.adebayo@solmarastudio.com" }, { name: "Tunde Fashola", email: "tunde.fashola@solmarastudio.com" }];
    net.row = { id: "act-1", trace_id: "t-1", tool_name: "sendBroadcast", status: "pending", proposed_args: { recipients, subject: "Policy update", body: "Gloves are mandatory." } };
    net.realHandler = async (url, init) => PATCH(new NextRequest(`http://localhost${url}`, { method: "PATCH", body: String(init.body) }), { params: Promise.resolve({ id: "act-1" }) });

    mount({ toolName: "sendBroadcast", subject: "Policy update", body: "Gloves are mandatory." });
    openEditor();
    typeSubject("Gloves: mandatory from Monday");
    typeBody("Gloves are **mandatory** from Monday.");
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByText("Gloves are mandatory from Monday."));
    check("real server: the stored draft is the cleaned edited text", net.row.proposed_args.subject === "Gloves: mandatory from Monday" && net.row.proposed_args.body === "Gloves are mandatory from Monday.", net.row.proposed_args);
    check("real server: the recipients are exactly what they were", JSON.stringify(net.row.proposed_args.recipients) === JSON.stringify(recipients), net.row.proposed_args.recipients);
    check("real server: the action is still pending", net.row.status === "pending");
    check("real server: the card shows what the server stored, not the typed markdown", !!screen.getByText("Gloves: mandatory from Monday") && !(document.body.textContent ?? "").includes("Gloves are **mandatory**"));

    net.row.status = "approved";
    openEditor();
    typeBody("A late edit after approval");
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByRole("alert"));
    check("real server: editing an already-approved action is refused and says so", /already resolved/i.test(screen.getByRole("alert").textContent ?? ""), screen.getByRole("alert").textContent);
    check("real server: ...and the approved draft was not touched", net.row.proposed_args.body === "Gloves are mandatory from Monday.", net.row.proposed_args.body);

    cleanup();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});