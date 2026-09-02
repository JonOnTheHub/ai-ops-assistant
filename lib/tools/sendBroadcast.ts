import { Resend } from "resend";
import { ToolResult, BroadcastRecipient } from "@/types";

const resend = new Resend(process.env.RESEND_API_KEY!);

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
const SANDBOX_MODE = process.env.EMAIL_SANDBOX_MODE === "true";

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

        const results: RecipientResult[] = [];

        for (const recipient of args.recipients) {
            const to = SANDBOX_MODE ? process.env.RESEND_DEV_EMAIL! : recipient.email;

            try {
                const { error } = await resend.emails.send({
                    from: FROM_EMAIL,
                    to,
                    subject: SANDBOX_MODE
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

        return {
            success: true,
            data: {
                results,
                sent_count: sentCount,
                failed_count: failedCount,
                total: results.length,
                message: `${sentCount}/${results.length} sent${failedCount > 0 ? ` — ${failedCount} failed` : ""}.`,
            },
        };
    } catch (err) {
        return {
            success: false,
            error: `sendBroadcast failed: ${String(err)}`,
        };
    }
}