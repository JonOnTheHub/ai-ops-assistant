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
    realRefine: null as null | ((url: string, init: RequestInit) => Promise<Response>),
    groqContent: "A rewritten passage.",
    groqRequests: [] as Record<string, unknown>[],
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
        if (url.endsWith("/refine") && net.realRefine) return net.realRefine(url, init ?? {});
        if (net.realHandler && !url.endsWith("/refine")) return net.realHandler(url, init ?? {});
        return net.respond(sent);
    }

    // The real handler's own Supabase calls, answered from the in-memory row.
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (parsed.hostname.includes("groq.com")) {
        net.groqRequests.push(JSON.parse(String(init?.body)));
        return jsonResponse(200, { id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: net.groqContent } }], usage: {} });
    }
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
        net.realRefine = null;
        net.groqRequests = [];
        net.groqContent = "A rewritten passage.";
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
    await waitFor(() => {
        if (screen.queryByRole("textbox")) throw new Error("Save still in progress");
        screen.getByText("Please send the report within 48 hours.");
    });
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


    // ═══════════════════════════════════════════════════════════════════════════
    // 5c: selection actions
    // ═══════════════════════════════════════════════════════════════════════════
    const RICH = "Hi Grace,\n\nPlease send the report within 48 hours.\n\nThanks";
    const PASSAGE = "Please send the report within 48 hours.";
    const PS = RICH.indexOf(PASSAGE);
    const noFacts = { changed: false, removed: [] as string[], added: [] as string[] };

    // React's onSelect doesn't listen for the raw "select" event, so drive it the
    // way a browser does: focus, set the range, then mouse-up.
    const select = (start: number, end: number) => {
        const box = bodyBox();
        box.focus();
        box.setSelectionRange(start, end);
        fireEvent.mouseUp(box);
        fireEvent.select(box);
    };
    const selectPassage = () => select(PS, PS + PASSAGE.length);
    const toolbar = () => screen.queryByRole("toolbar", { name: "Rewrite selected text" });
    const actionButton = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;
    const refineOk = (suggestion: string, facts = noFacts) => jsonResponse(200, { success: true, action: "x", original: PASSAGE, suggestion, facts });
    const refineCalls = () => net.sent.filter((x) => x.url.endsWith("/refine"));
    const patchCalls = () => net.sent.filter((x) => x.method === "PATCH");
    const text = () => document.body.textContent ?? "";
    const mountRich = () => mount({ body: RICH });

    // ── A. When the toolbar appears ───────────────────────────────────────────
    reset();
    mountRich();
    openEditor();
    check("no toolbar until something is selected", toolbar() === null);
    selectPassage();
    check("selecting a passage shows the rewrite toolbar", toolbar() !== null);
    check("it shows how many characters are selected", new RegExp(`${PASSAGE.length} selected`).test(text()), text().slice(0, 200));
    check("it offers exactly the five fixed actions", ["Improve", "Shorten", "Fix grammar", "Formal", "Friendly"].every((l) => !!actionButton(l)) && screen.getByRole("toolbar").querySelectorAll("button").length === 5);
    check("there is no free-text instruction box", screen.queryAllByRole("textbox").length === 2);
    select(4, 4);
    check("collapsing the selection hides the toolbar", toolbar() === null);
    select(RICH.indexOf("\n\n"), RICH.indexOf("\n\n") + 2);
    check("a whitespace-only selection shows no toolbar", toolbar() === null);
    select(PS - 2, PS + PASSAGE.length + 2);
    check("a selection padded with newlines is trimmed to the passage", new RegExp(`${PASSAGE.length} selected`).test(text()), text().slice(0, 200));
    typeBody(RICH + " more");
    check("typing clears the toolbar (the offsets would be stale)", toolbar() === null);

    reset();
    mount({ body: "x".repeat(2100) });
    openEditor();
    select(0, 2100);
    check("an over-long selection says so", /Selection too long \(max 2000\)/.test(text()), text().slice(0, 300));
    check("...and every action button is off", ["Improve", "Shorten", "Fix grammar", "Formal", "Friendly"].every((l) => actionButton(l).disabled));
    fireEvent.click(actionButton("Improve"));
    check("...so clicking one sends nothing", refineCalls().length === 0, net.sent);

    // ── B. The request, and the busy state ────────────────────────────────────
    reset();
    m = mountRich();
    openEditor();
    typeBody(RICH + "\nP.S. see you Monday");
    selectPassage();
    let releaseRefine: (r: Response) => void = () => {};
    net.respond = () => new Promise<Response>((resolve) => { releaseRefine = resolve; });
    fireEvent.click(actionButton("Shorten"));
    await waitFor(() => screen.getByRole("status"));
    const sentRefine = refineCalls()[0];
    check("one POST went to this action's refine endpoint", refineCalls().length === 1 && sentRefine.method === "POST" && sentRefine.url === "/api/actions/act-1/refine", net.sent);
    check("it sent the action and the exact selected text", sentRefine.body.action === "shorten" && sentRefine.body.selection === PASSAGE, sentRefine.body);
    check("it sent the text just before and after, as context only", String(sentRefine.body.before).endsWith("Hi Grace,\n\n") && String(sentRefine.body.after).startsWith("\n\nThanks"), sentRefine.body);
    check("it sent nothing else: no subject, no recipients", JSON.stringify(Object.keys(sentRefine.body).sort()) === JSON.stringify(["action", "after", "before", "selection"]), Object.keys(sentRefine.body));
    check("while waiting it says it is rewriting", /Rewriting \(shorten\)/.test(screen.getByRole("status").textContent ?? ""));
    check("the toolbar is hidden while waiting", toolbar() === null);
    check("the body is read-only while waiting, so the offsets can't go stale", bodyBox().readOnly === true);
    check("Save is off while waiting, even with an unsaved edit", saveButton().disabled === true);
    check("the card is not told anything new: still editing, not saving", JSON.stringify(m.states.at(-1)) === JSON.stringify({ editing: true, saving: false }), m.states.at(-1));
    await act(async () => { releaseRefine(refineOk("Please send the report in 48 hours.")); });
    await waitFor(() => screen.getByRole("region", { name: "Suggested rewrite" }));
    check("refining sent no PATCH: nothing was saved", patchCalls().length === 0, net.sent);

    // ── C. The preview ────────────────────────────────────────────────────────
    const region = () => screen.getByRole("region", { name: "Suggested rewrite" });
    check("the preview shows the original under Before", /Before/.test(region().textContent ?? "") && (region().textContent ?? "").includes(PASSAGE));
    check("...and the suggestion under After", /After/.test(region().textContent ?? "") && (region().textContent ?? "").includes("Please send the report in 48 hours."));
    check("an unchanged-facts suggestion carries no warning", screen.queryByRole("note") === null);
    check("it offers Replace, Dismiss and Try again", !!actionButton("Replace") && !!actionButton("Dismiss") && !!actionButton("Try again"));
    check("the body stays read-only while the choice is open", bodyBox().readOnly === true);
    check("the toolbar stays hidden while the choice is open", toolbar() === null);
    check("the body itself is untouched by the suggestion", bodyBox().value === RICH + "\nP.S. see you Monday", bodyBox().value);

    // Replace
    fireEvent.click(actionButton("Replace"));
    check("Replace swaps ONLY the selected passage", bodyBox().value === RICH.replace(PASSAGE, "Please send the report in 48 hours.") + "\nP.S. see you Monday", bodyBox().value);
    check("...the preview closes and the body is editable again", screen.queryByRole("region", { name: "Suggested rewrite" }) === null && bodyBox().readOnly === false);
    check("...the toolbar is gone (the old selection no longer exists)", toolbar() === null);
    check("Replace itself sent nothing to the server", patchCalls().length === 0 && refineCalls().length === 1, net.sent.length);
    check("...it is an unsaved edit, so Save is on", saveButton().disabled === false);

    // Save keeps it
    net.respond = (sent) => ok("Fuel receipts", String(sent.body.body));
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByText(/report in 48 hours/));
    check("Save then sends the replaced text through the normal PATCH", patchCalls().length === 1 && String(patchCalls()[0].body.body).includes("Please send the report in 48 hours."), patchCalls());

    // Dismiss
    reset();
    mountRich();
    openEditor();
    selectPassage();
    net.respond = () => refineOk("Kindly send the report within 48 hours.");
    fireEvent.click(actionButton("Improve"));
    await waitFor(() => screen.getByRole("region", { name: "Suggested rewrite" }));
    fireEvent.click(actionButton("Dismiss"));
    check("Dismiss closes the preview and leaves the body exactly as it was", screen.queryByRole("region", { name: "Suggested rewrite" }) === null && bodyBox().value === RICH, bodyBox().value);
    check("...and nothing was saved", patchCalls().length === 0);

    // Try again from the preview
    reset();
    mountRich();
    openEditor();
    selectPassage();
    let n = 0;
    net.respond = () => refineOk(n++ === 0 ? "First suggestion." : "Second suggestion.");
    fireEvent.click(actionButton("Formal"));
    await waitFor(() => screen.getByText("First suggestion."));
    fireEvent.click(actionButton("Try again"));
    await waitFor(() => screen.getByText("Second suggestion."));
    check("Try again re-asks with the SAME action and the SAME passage", refineCalls().length === 2 && refineCalls()[1].body.action === "formal" && refineCalls()[1].body.selection === PASSAGE, refineCalls().map((c) => c.body));
    check("...and shows the new suggestion in place of the old one", !text().includes("First suggestion."));

    // Cancel with a preview open
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    check("Cancel with a preview open discards everything and closes the editor", screen.queryAllByRole("textbox").length === 0 && screen.queryByRole("region", { name: "Suggested rewrite" }) === null);
    openEditor();
    check("re-opening starts clean: no preview, no toolbar, the saved text", screen.queryByRole("region", { name: "Suggested rewrite" }) === null && toolbar() === null && bodyBox().value === RICH);

    // ── D. A suggestion that changed a fact ───────────────────────────────────
    reset();
    mountRich();
    openEditor();
    selectPassage();
    net.respond = () => refineOk("Please send the report within 24 hours.", { changed: true, removed: ["48"], added: ["24"] });
    fireEvent.click(actionButton("Shorten"));
    await waitFor(() => screen.getByRole("note"));
    const warning = screen.getByRole("note").textContent ?? "";
    check("a changed number is flagged beside the suggestion", /Check this/.test(warning) && /removed 48/.test(warning) && /added 24/.test(warning), warning);
    check("...as a warning only: Replace is still available", actionButton("Replace").disabled === false);
    fireEvent.click(actionButton("Replace"));
    check("...and the person can still choose to apply it", bodyBox().value.includes("within 24 hours"));

    // ── E. The text changed underneath the suggestion ─────────────────────────
    reset();
    mountRich();
    openEditor();
    selectPassage();
    net.respond = () => refineOk("Kindly send the report within 48 hours.");
    fireEvent.click(actionButton("Improve"));
    await waitFor(() => screen.getByRole("region", { name: "Suggested rewrite" }));
    const drifted = RICH.replace("report", "document");
    fireEvent.change(bodyBox(), { target: { value: drifted } });
    fireEvent.click(actionButton("Replace"));
    check("if the passage changed since the suggestion, Replace refuses and says so", /text changed since this suggestion was made/.test(screen.getByRole("alert").textContent ?? ""), text().slice(0, 300));
    check("...and the changed text is left exactly as it was", bodyBox().value === drifted, bodyBox().value);

    // ── F. Every way a request can fail ───────────────────────────────────────
    const failure = async (label: string, arrange: () => void, expected: RegExp) => {
        reset();
        mountRich();
        openEditor();
        selectPassage();
        arrange();
        fireEvent.click(actionButton("Improve"));
        await waitFor(() => screen.getByRole("alert"));
        check(`${label}: says why`, expected.test(screen.getByRole("alert").textContent ?? ""), screen.getByRole("alert").textContent);
        check(`${label}: the body is untouched`, bodyBox().value === RICH);
        check(`${label}: the selection survives, so the toolbar is back`, toolbar() !== null);
        check(`${label}: there is a Try again`, !!screen.getAllByRole("button", { name: "Try again" })[0]);
    };
    await failure("rate limited (429)", () => { net.respond = () => jsonResponse(429, { error: "I've hit the model's rate limit. Wait a few seconds, then try again.", retryable: true }); }, /rate limit/);
    await failure("model error (502)", () => { net.respond = () => jsonResponse(502, { error: "The model returned nothing, so there's no suggestion. Try again.", retryable: true }); }, /returned nothing/);
    await failure("already resolved (404 JSON)", () => { net.respond = () => jsonResponse(404, { error: "Pending action not found or already resolved" }); }, /already resolved/);
    await failure("framework 404 page", () => { net.respond = () => jsonResponse(404, "<html>nope</html>", "text/html"); }, /wasn.t found|404/i);
    await failure("some other non-JSON answer", () => { net.respond = () => jsonResponse(502, "bad gateway", "text/html"); }, /unexpected response/);
    await failure("network down", () => { net.throwNetworkError = true; }, /Couldn.t reach the server/);

    reset();
    mountRich();
    openEditor();
    selectPassage();
    net.respond = () => jsonResponse(502, { error: "The model returned nothing, so there's no suggestion. Try again.", retryable: true });
    fireEvent.click(actionButton("Improve"));
    await waitFor(() => screen.getByRole("alert"));
    net.respond = () => refineOk("Kindly send the report within 48 hours.");
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    await waitFor(() => screen.getByRole("region", { name: "Suggested rewrite" }));
    check("Try again after an error re-sends the same action and then shows the preview", refineCalls().length === 2 && refineCalls()[1].body.action === "improve", refineCalls().map((c) => c.body));
    check("...and the old error is gone", screen.queryByRole("alert") === null);

    // ── G. Against the REAL refine handler (Groq stubbed) and the REAL PATCH ──
    reset();
    // The Groq SDK refuses to initialise when it sees a browser-like environment,
    // and this test installs a fake browser (jsdom) for the component. The real
    // server never has one, so hide it for the instant the server module loads.
    const fakeWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
    const { POST: refinePost } = await import("@/app/api/actions/[id]/refine/route");
    Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
    net.row = { id: "act-1", trace_id: "t-1", tool_name: "sendBroadcast", status: "pending", proposed_args: { recipients, subject: "Policy update", body: RICH } };
    net.realHandler = async (url, init) => PATCH(new NextRequest(`http://localhost${url}`, { method: "PATCH", body: String(init.body) }), { params: Promise.resolve({ id: "act-1" }) });
    net.realRefine = async (url, init) => refinePost(new NextRequest(`http://localhost${url}`, { method: "POST", body: String(init.body) }), { params: Promise.resolve({ id: "act-1" }) });
    net.groqContent = "Here is the rewrite:\n\"Please send the report within **24 hours**.\"";

    mount({ toolName: "sendBroadcast", subject: "Policy update", body: RICH });
    openEditor();
    selectPassage();
    fireEvent.click(actionButton("Shorten"));
    await waitFor(() => screen.getByRole("region", { name: "Suggested rewrite" }));
    check("real server: the model got the passage, the rules, low reasoning effort and no tools", (() => { const g = net.groqRequests[0] as { reasoning_effort?: string; tools?: unknown; messages?: { content: string }[] }; return g?.reasoning_effort === "low" && g.tools === undefined && !!g.messages?.[1].content.includes(PASSAGE) && /Rewrite ONLY the passage/.test(g.messages?.[0].content ?? ""); })(), net.groqRequests[0]);
    check("real server: a messy answer (preamble, quotes, markdown) arrives cleaned", (region().textContent ?? "").includes("Please send the report within 24 hours.") && !(region().textContent ?? "").includes("**") && !(region().textContent ?? "").includes("Here is the rewrite"), region().textContent);
    check("real server: the changed number is flagged for the person", /removed 48/.test(screen.getByRole("note").textContent ?? "") && /added 24/.test(screen.getByRole("note").textContent ?? ""), screen.queryByRole("note")?.textContent);
    check("real server: a suggestion alone changed NOTHING in the stored draft", net.row.proposed_args.body === RICH, net.row.proposed_args.body);

    fireEvent.click(actionButton("Replace"));
    check("real server: Replace alone still changed nothing in the stored draft", net.row.proposed_args.body === RICH);
    fireEvent.click(saveButton());
    await waitFor(() => screen.getByText(/within 24 hours/));
    check("real server: only Save stores the new text", String(net.row.proposed_args.body).includes("Please send the report within 24 hours.") && String(net.row.proposed_args.body).startsWith("Hi Grace,") && String(net.row.proposed_args.body).endsWith("Thanks"), net.row.proposed_args.body);
    check("real server: the recipients never changed through any of it", JSON.stringify(net.row.proposed_args.recipients) === JSON.stringify(recipients));
    check("real server: the action is still pending, waiting for approval", net.row.status === "pending");

    cleanup();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});