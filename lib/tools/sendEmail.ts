import { Resend } from "resend";
import { ToolResult } from "@/types";

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function sendEmail(args: {
    to: string;
    subject: string;
    body: string;
}): Promise<ToolResult> {
    try {
        const { data, error } = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL!,
            to: args.to,
            subject: args.subject,
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