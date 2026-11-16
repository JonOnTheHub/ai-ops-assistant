// The browser-safe half of the refine feature. DraftEditor (a client component)
// imports from HERE, never from refine.ts: refine.ts pulls in the Groq SDK and
// builds an API client at import, which must never end up in the browser bundle.
// Everything in this file is pure.

export const REFINE_ACTIONS = ["improve", "shorten", "grammar", "formal", "friendly"] as const;
export type RefineAction = (typeof REFINE_ACTIONS)[number];

export const REFINE_LABELS: Record<RefineAction, string> = {
    improve: "Improve",
    shorten: "Shorten",
    grammar: "Fix grammar",
    formal: "Formal",
    friendly: "Friendly",
};

export const SELECTION_MAX = 2000;
export const CONTEXT_MAX = 400;
export const SUGGESTION_MAX = 4000;

export interface FactCheck {
    changed: boolean;
    removed: string[];
    added: string[];
}

// A highlighted range, pulled in off any leading or trailing whitespace so a
// replacement can't glue two words together. Null when nothing but whitespace
// (or nothing) is selected.
export function trimSelection(text: string, start: number, end: number): { start: number; end: number } | null {
    let from = Math.max(0, Math.min(start, end));
    let to = Math.min(text.length, Math.max(start, end));

    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;

    return to > from ? { start: from, end: to } : null;
}

// The warning shown beside a suggestion that changed a number, amount, day,
// date or address. Null when nothing changed.
export function describeFactChange(facts: FactCheck): string | null {
    if (!facts.changed) return null;

    const parts: string[] = [];
    if (facts.removed.length > 0) parts.push(`removed ${facts.removed.join(", ")}`);
    if (facts.added.length > 0) parts.push(`added ${facts.added.join(", ")}`);

    return `Check this: the rewrite ${parts.join(" and ")}. Numbers, amounts, days, dates and addresses should stay exactly as you wrote them.`;
}