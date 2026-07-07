import { Resend } from "resend";
import { ToolResult } from "@/types";

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function sendEmail(args: {
    to: string;
    subject: string;
    body: string;
}): Promise<ToolResult> {
    try {
        const isDev = process.env.NODE_ENV === "development";
        const to = isDev ? process.env.RESEND_DEV_EMAIL! : args.to;

        const { data, error } = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL!,
            to,
            subject: isDev ? `[DEV → ${args.to}] ${args.subject}` : args.subject,
            text: args.body,
        });

        if (error) throw new Error(error.message);

        return {
            success: true,
            data: {
                email_id: data?.id,
                to: args.to,
                subject: args.subject,
                message: "Email sent successfully.",
            },
        };
    } catch (err) {
        return {
            success: false,
            error: `sendEmail failed: ${String(err)}`,
        };
    }
}