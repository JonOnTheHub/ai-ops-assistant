import { Resend } from "resend";
import { ToolResult } from "@/types";

const resend = new Resend(process.env.RESEND_API_KEY!);

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
const SANDBOX_MODE = process.env.EMAIL_SANDBOX_MODE === "true";

export async function sendEmail(args: {
  to: string;
  subject: string;
  body: string;
}): Promise<ToolResult> {
  try {
    const to = SANDBOX_MODE ? process.env.RESEND_DEV_EMAIL! : args.to;

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: SANDBOX_MODE ? `[SANDBOX → ${args.to}] ${args.subject}` : args.subject,
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