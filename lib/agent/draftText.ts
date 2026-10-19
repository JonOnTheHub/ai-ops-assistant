// Emails here go out as plain text (sendEmail and sendBroadcast both send
// `text:`), so markdown never renders. The tool descriptions already ask for
// plain text and the model still writes things like **48 hours**, which then
// reaches the recipient as literal asterisks. Asking harder isn't a fix, so
// this cleans the draft deterministically BEFORE the approval card exists:
// what the person approves is exactly what gets sent.
//
// Deliberately conservative. It only removes formatting markers and leaves
// every word, number, link target and line break alone, so it can't change
// what a message says. Cleaning an already-clean draft is a no-op.

export function toPlainText(text: string): string {
    return (
        text
            // "## Heading" -> "Heading"
            .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
            // **bold** and __bold__ -> bold (markers must hug the text)
            .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "$1")
            .replace(/(?<!\w)__(?=\S)([^_\n]+?)(?<=\S)__(?!\w)/g, "$1")
            // `code` -> code
            .replace(/`([^`\n]+)`/g, "$1")
            // [label](https://url) -> label (https://url): a plain-text email
            // can't make a link, so keep the destination visible
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
            // "* item" bullets -> "- item" (hyphen bullets read fine as text)
            .replace(/^([ \t]*)\*[ \t]+/gm, "$1- ")
            // *italic* -> italic. Never touches "5 * 3 * 2" (spaces inside) or
            // "2*3*4" (word characters on both sides).
            .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1")
    );
}

const DRAFT_TOOLS = new Set(["sendEmail", "sendBroadcast"]);

// Returns the args with subject and body cleaned for the email tools, and the
// args untouched for every other tool. Recipients and addresses are never read
// or modified here.
export function cleanDraftArgs(
    toolName: string,
    args: Record<string, unknown>
): Record<string, unknown> {
    if (!DRAFT_TOOLS.has(toolName)) return args;

    const cleaned: Record<string, unknown> = { ...args };
    if (typeof args.subject === "string") cleaned.subject = toPlainText(args.subject);
    if (typeof args.body === "string") cleaned.body = toPlainText(args.body);
    return cleaned;
}