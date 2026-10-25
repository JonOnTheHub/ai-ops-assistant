import { Resend } from "resend";
import { ToolResult, BroadcastRecipient } from "@/types";

const resend = new Resend(process.env.RESEND_API_KEY!);

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
// Read per call, not at import, so the mode is whatever the environment says now.
const isSandbox = () => process.env.EMAIL_SANDBOX_MODE === "true";

interface RecipientResult {
    name: string;
    email: string;
    success: boolean;
    error?: string;
}

export async function sendBroadcast(args: {
    recipients: BroadcastRecipient[];
    subject: string;
    body: string;
}): Promise<ToolResult> {
    try {
        if (!args.recipients || args.recipients.length === 0) {
            return {
                success: false,
                error: "sendBroadcast failed: no recipients provided.",
            };
        }

        const sandbox = isSandbox();
        const results: RecipientResult[] = [];

        for (const recipient of args.recipients) {
            const to = sandbox ? process.env.RESEND_DEV_EMAIL! : recipient.email;

            try {
                const { error } = await resend.emails.send({
                    from: FROM_EMAIL,
                    to,
                    subject: sandbox
                        ? `[SANDBOX → ${recipient.email}] ${args.subject}`
                        : args.subject,
                    text: args.body,
                });

                if (error) throw new Error(error.message);

                results.push({ name: recipient.name, email: recipient.email, success: true });
            } catch (err) {
                results.push({
                    name: recipient.name,
                    email: recipient.email,
                    success: false,
                    error: String(err),
                });
            }
        }

        const sentCount = results.filter((r) => r.success).length;
        const failedCount = results.length - sentCount;

        const sentNames = results.filter((r) => r.success).map((r) => r.name);
        const failedNames = results.filter((r) => !r.success).map((r) => r.name);

        // Include real names, not just counts — this is what actually persists
        // into conversation history once the turn ends, so "who did we send
        // to" needs a real answer available here, not just a tally.
        let message = `${sentCount}/${results.length} sent (${sentNames.join(", ")})`;
        if (failedCount > 0) {
            message += ` — ${failedCount} failed (${failedNames.join(", ")})`;
        }
        message += ".";
        // Say where they REALLY went: in sandbox mode every send is rerouted.
        if (sandbox) {
            message += " Sandbox mode: every message was delivered to the dev inbox, not to these recipients.";
        }

        return {
            success: true,
            data: {
                results,
                sent_count: sentCount,
                failed_count: failedCount,
                total: results.length,
                sandbox,
                message,
            },
        };
    } catch (err) {
        return {
            success: false,
            error: `sendBroadcast failed: ${String(err)}`,
        };
    }
}