import { supabase } from "@/lib/supabase";

// sendEmail goes to exactly one address, and nothing validates it. The model
// has a habit of inventing one for a team ("catering-team@solmara.com", on a
// domain nobody here controls), and the approval card was the only thing
// standing between that and a real send. This is checked BEFORE the approval
// card exists: the address has to be one we actually know, or one the person
// typed themselves.

export type RecipientCheck = { ok: true } | { ok: false; reason: string };

const ADDRESS_PATTERN = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

// Tables that hold addresses we know about. sendEmail's own description says
// customers and leads; employees are known contacts too.
const CONTACT_TABLES = ["employees", "customers", "leads"];

export function normalizeAddress(value: unknown): string | null {
    if (typeof value !== "string") return null;
    // Brackets first: "<mailto:a@b.co>" has the bracket in front of the scheme.
    const cleaned = value.trim().toLowerCase().replace(/^<|>$/g, "").replace(/^mailto:/, "");
    return /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(cleaned) ? cleaned : null;
}

// Whole-address match against addresses the person typed. A plain substring
// test would let "ann@x.com" pass because "joann@x.com" appears in their text.
export function typedByUser(address: string, userTexts: string[]): boolean {
    return userTexts.some((text) => {
        const found: string[] = text.toLowerCase().match(ADDRESS_PATTERN) ?? [];
        return found.includes(address);
    });
}

// LIKE treats % and _ as wildcards, and underscores are common in addresses.
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, "\\$&");
}

async function lookupKnownContact(address: string): Promise<{ found: boolean; lookupFailed: boolean }> {
    let failures = 0;

    for (const table of CONTACT_TABLES) {
        try {
            const { data, error } = await supabase
                .from(table)
                .select("email")
                .ilike("email", escapeLike(address))
                .limit(1);

            if (error) {
                failures++;
                continue;
            }
            if (data && data.length > 0) return { found: true, lookupFailed: false };
        } catch {
            failures++;
        }
    }

    return { found: false, lookupFailed: failures === CONTACT_TABLES.length };
}

export async function checkEmailRecipient(to: unknown, userTexts: string[]): Promise<RecipientCheck> {
    const address = normalizeAddress(to);

    if (!address) {
        return { ok: false, reason: `"${String(to)}" isn't a valid email address, so I haven't drafted anything.` };
    }

    if (typedByUser(address, userTexts)) return { ok: true };

    const known = await lookupKnownContact(address);
    if (known.found) return { ok: true };

    // Fail closed: if we couldn't check at all, don't wave the address through.
    if (known.lookupFailed) {
        return {
            ok: false,
            reason: `I couldn't check whether ${address} is a known contact right now, so I haven't drafted anything. Try again in a moment.`,
        };
    }

    return {
        ok: false,
        reason: `I don't have an email address for ${address}: it isn't a known employee, customer or lead, and you didn't type it. To email a team or department, ask me to broadcast to that role instead; otherwise give me the exact address.`,
    };
}