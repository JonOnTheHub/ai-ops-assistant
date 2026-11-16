import Groq from "groq-sdk";
import { toPlainText } from "./draftText";

// Selection actions on an email draft: the person highlights a passage and asks
// for a rewrite. This file holds everything about that call that can be tested
// without a model: the allowed actions, the request rules, the prompt, cleanup
// of what comes back, and a check that the rewrite didn't quietly change a fact.
//
// What it will never do is apply anything. A rewrite is only ever a SUGGESTION
// the person can Replace or Dismiss, and it only becomes part of the draft
// through the normal Save, which goes through lib/agent/draftEdit.ts.

import {
    REFINE_ACTIONS,
    SELECTION_MAX,
    CONTEXT_MAX,
    SUGGESTION_MAX,
    type RefineAction,
    type FactCheck,
} from "./refineShared";

// The constants and types live in refineShared.ts so the browser can use them
// without pulling in the Groq SDK. Re-exported here so server code and tests
// keep importing everything from one place.
export { REFINE_ACTIONS, SELECTION_MAX, CONTEXT_MAX, SUGGESTION_MAX };
export type { RefineAction, FactCheck };

const INSTRUCTIONS: Record<RefineAction, string> = {
    improve: "Improve the clarity and flow of the passage. Keep the meaning, every fact, and roughly the same length.",
    shorten: "Make the passage shorter and tighter without losing any fact, number, name, date or request. Cut filler, not substance.",
    grammar: "Fix spelling, grammar and punctuation only. Do not change wording, tone or meaning beyond what those fixes require.",
    formal: "Rewrite the passage in a more formal, professional tone. Keep every fact.",
    friendly: "Rewrite the passage in a warmer, friendlier tone while staying professional. Keep every fact.",
};

export const REFINE_SYSTEM_PROMPT =
    "You edit one passage inside an email draft for a hospitality and events design studio. You are given an instruction, optional surrounding text for context only, and the passage. Rewrite ONLY the passage. " +
    "Rules: keep every name, number, date, amount, email address and link exactly as written. Never add new facts, promises or deadlines. " +
    "Plain text only: no markdown, no quotation marks around the result. Return ONLY the rewritten passage, with no preamble, no explanation and no delimiters. " +
    "Write in the same language as the passage.";

export type RefineRequest =
    | { ok: true; action: RefineAction; selection: string; before: string; after: string }
    | { ok: false; error: string };

const ALLOWED_KEYS = new Set(["action", "selection", "before", "after"]);

export function validateRefineRequest(payload: unknown): RefineRequest {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return { ok: false, error: "The request must be an object with an action and a selection." };
    }

    const input = payload as Record<string, unknown>;

    for (const key of Object.keys(input)) {
        if (!ALLOWED_KEYS.has(key)) return { ok: false, error: `"${key}" isn't accepted here.` };
    }

    if (typeof input.action !== "string" || !(REFINE_ACTIONS as readonly string[]).includes(input.action)) {
        return { ok: false, error: `The action must be one of: ${REFINE_ACTIONS.join(", ")}.` };
    }

    if (typeof input.selection !== "string" || input.selection.trim().length === 0) {
        return { ok: false, error: "Select some text first." };
    }
    const selection = input.selection.trim();
    if (selection.length > SELECTION_MAX) {
        return { ok: false, error: `The selection is too long (${selection.length} characters; the limit is ${SELECTION_MAX}). Select a shorter passage.` };
    }

    if ((input.before !== undefined && typeof input.before !== "string") || (input.after !== undefined && typeof input.after !== "string")) {
        return { ok: false, error: "The surrounding text must be text." };
    }

    return {
        ok: true,
        action: input.action as RefineAction,
        selection,
        // Context only, trimmed to the stretch nearest the selection.
        before: (input.before as string | undefined)?.slice(-CONTEXT_MAX) ?? "",
        after: (input.after as string | undefined)?.slice(0, CONTEXT_MAX) ?? "",
    };
}

export function buildRefineMessages(action: RefineAction, selection: string, before: string, after: string) {
    return [
        { role: "system" as const, content: REFINE_SYSTEM_PROMPT },
        {
            role: "user" as const,
            content:
                `Instruction: ${INSTRUCTIONS[action]}\n\n` +
                `Context before (do not rewrite): ${before.trim() || "(none)"}\n` +
                `Context after (do not rewrite): ${after.trim() || "(none)"}\n\n` +
                `Passage to rewrite:\n<<<\n${selection}\n>>>`,
        },
    ];
}

// Models add things despite instructions. Strip the usual ones, deterministically.
export function cleanSuggestion(raw: string, original: string): string {
    let text = toPlainText(raw).trim();

    text = text.replace(/^<<<\s*/, "").replace(/\s*>>>$/, "").trim();

    // "Here's the improved version:" on its own first line
    if (!/^here/i.test(original)) {
        text = text.replace(/^here(?:'s| is)[^\n:]{0,80}:\s*\n?/i, "").trim();
    }

    // Quotes wrapped around the whole result, when the original had none
    const quoted = /^["\u201c]([\s\S]*)["\u201d]$/.exec(text);
    if (quoted && !/^["\u201c]/.test(original.trim())) text = quoted[1].trim();

    return text;
}

// ── Did the rewrite change a fact? ───────────────────────────────────────────
// A rewrite that shortens "within 48 hours" to "within 24 hours" is the
// dangerous kind: it reads fine. So amounts, numbers, dates, days, addresses
// and links are pulled out of both versions and compared. A difference is a
// WARNING for the person to look at, never a block: "forty-eight hours" for
// "48 hours" is harmless but also shows up here, and a person can judge that.

const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";

export function extractFacts(text: string): string[] {
    const facts: string[] = [];
    for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi)) facts.push(m[0].toLowerCase());
    for (const m of text.matchAll(/https?:\/\/[^\s)]+/gi)) facts.push(m[0].toLowerCase().replace(/[.,;]+$/, ""));
    for (const m of text.matchAll(/[₦$€£]?\d[\d,]*(?:\.\d+)?%?/g)) facts.push(m[0].replace(/,/g, ""));
    for (const m of text.matchAll(new RegExp(`\\b(?:${DAYS}|${MONTHS})\\b`, "gi"))) facts.push(m[0].toLowerCase());
    return facts;
}

export function compareFacts(original: string, suggestion: string): FactCheck {
    const remaining = extractFacts(suggestion);
    const removed: string[] = [];

    for (const fact of extractFacts(original)) {
        const index = remaining.indexOf(fact);
        if (index === -1) removed.push(fact);
        else remaining.splice(index, 1);
    }

    const unique = (list: string[]) => [...new Set(list)];
    return { changed: removed.length > 0 || remaining.length > 0, removed: unique(removed), added: unique(remaining) };
}

// ── The model call ───────────────────────────────────────────────────────────

// Raised when the model answered but gave us nothing usable. The route turns it
// into a plain "try again" message; anything else thrown is a real failure and
// goes through the same error classification as the rest of the app.
export class RefineError extends Error {}

// No hidden retries: a retry inside the SDK would quietly spend more of the
// per-minute token budget the planner shares. The person can press Try again.
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY!, timeout: 30000, maxRetries: 0 });

export async function refineSelection(request: { action: RefineAction; selection: string; before: string; after: string }) {
    const response = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: buildRefineMessages(request.action, request.selection, request.before, request.after),
        max_tokens: 1200,
        reasoning_effort: "low",
        include_reasoning: false,
    });

    const suggestion = cleanSuggestion(response.choices[0]?.message?.content ?? "", request.selection);

    if (!suggestion) {
        throw new RefineError("The model returned nothing, so there's no suggestion. Try again.");
    }
    if (suggestion.length > SUGGESTION_MAX) {
        throw new RefineError("The model's rewrite came back far too long, so I've discarded it. Try again, or select a shorter passage.");
    }

    return { suggestion, facts: compareFacts(request.selection, suggestion) };
}