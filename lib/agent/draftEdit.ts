import { toPlainText } from "./draftText";

// Rules for a person editing a PENDING email or broadcast before approving it.
// Pure on purpose, so every rule can be tested exactly. The route calls this and
// writes the result; nothing here touches the database.
//
// The point of the whole feature is "what you approve is what gets sent". Two
// things protect that:
//   1. Only the subject and body can change. Recipients, the `to` address and
//      every other field are rejected outright, not silently ignored, so an
//      edit can never route around the recipient checks made when the action
//      was proposed (resolveAudience for broadcasts, the known-contact check
//      for sendEmail).
//   2. The edit is cleaned with the same plain-text rule as model drafts, so a
//      person pasting markdown gets the same result the model would.

export const SUBJECT_MAX = 200;
export const BODY_MAX = 10000;

const EDITABLE_TOOLS = new Set(["sendEmail", "sendBroadcast"]);
const EDITABLE_FIELDS = new Set(["subject", "body"]);
const RECIPIENT_FIELDS = new Set(["to", "recipients"]);

export type DraftField = "subject" | "body";

export type DraftEdit =
    | { ok: true; subject: string; body: string; changed: DraftField[] }
    | { ok: false; error: string };

function fail(error: string): DraftEdit {
    return { ok: false, error };
}

export function validateDraftEdit(
    toolName: string,
    stored: Record<string, unknown>,
    payload: unknown
): DraftEdit {
    if (!EDITABLE_TOOLS.has(toolName)) {
        return fail("Only email and broadcast drafts can be edited.");
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return fail("The edit must be an object with a subject and/or body.");
    }

    const input = payload as Record<string, unknown>;

    for (const key of Object.keys(input)) {
        if (RECIPIENT_FIELDS.has(key)) {
            return fail("Recipients can't be edited here. Only the subject and body can be changed.");
        }
        if (!EDITABLE_FIELDS.has(key)) {
            return fail(`"${key}" can't be edited. Only the subject and body can be changed.`);
        }
    }

    if (input.subject === undefined && input.body === undefined) {
        return fail("Nothing to edit: send a subject, a body, or both.");
    }

    const storedSubject = stored.subject;
    const storedBody = stored.body;
    if (typeof storedSubject !== "string" || typeof storedBody !== "string") {
        return fail("The stored draft couldn't be read, so it can't be edited.");
    }

    const clean = (field: DraftField, max: number): string | { error: string } | null => {
        const value = input[field];
        if (value === undefined) return null;
        if (typeof value !== "string") return { error: `The ${field} must be text.` };
        const cleaned = toPlainText(value).trim();
        if (cleaned.length === 0) return { error: `The ${field} can't be empty.` };
        if (cleaned.length > max) return { error: `The ${field} is too long (${cleaned.length} characters; the limit is ${max}).` };
        return cleaned;
    };

    const subject = clean("subject", SUBJECT_MAX);
    if (subject !== null && typeof subject === "object") return fail(subject.error);
    const body = clean("body", BODY_MAX);
    if (body !== null && typeof body === "object") return fail(body.error);

    const nextSubject = subject ?? storedSubject;
    const nextBody = body ?? storedBody;

    // Whitespace-only differences aren't edits.
    const changed: DraftField[] = [];
    if (nextSubject.trim() !== storedSubject.trim()) changed.push("subject");
    if (nextBody.trim() !== storedBody.trim()) changed.push("body");

    return { ok: true, subject: nextSubject, body: nextBody, changed };
}