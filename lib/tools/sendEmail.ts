import { Resend } from "resend";
import { ToolResult } from "@/types";

const resend = new Resend(process.env.RESEND_API_KEY!);

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
// Read per call, not at import, so the mode is whatever the environment says now.
const isSandbox = () => process.env.EMAIL_SANDBOX_MODE === "true";

export async function sendEmail(args: {
  to: string;
  subject: string;
  body: string;
}): Promise<ToolResult> {
  try {
    const sandbox = isSandbox();
    const to = sandbox ? process.env.RESEND_DEV_EMAIL! : args.to;

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: sandbox ? `[SANDBOX → ${args.to}] ${args.subject}` : args.subject,
      text: args.body,
    });

    if (error) throw new Error(error.message);

    return {
      success: true,
      data: {
        email_id: data?.id,
        to: args.to,
        delivered_to: to,
        sandbox,
        subject: args.subject,
        // Say where it REALLY went. In sandbox mode every send is rerouted, and
        // "Email sent to <the address>" would be a false report.
        message: sandbox
          ? `Sandbox mode: this email was addressed to ${args.to} but delivered to the dev inbox instead.`
          : `Email sent to ${args.to}.`,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `sendEmail failed: ${String(err)}`,
    };
  }
}