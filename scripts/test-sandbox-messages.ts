// Real sendEmail + real sendBroadcast. Only Resend's HTTP layer is stubbed, so
// nothing is sent. The sandbox flag is read on every call, so this flips it
// between calls. Run:
//   npx tsx scripts/test-sandbox-messages.ts

export {};

process.env.RESEND_API_KEY = "re_test_key";
process.env.RESEND_DEV_EMAIL = "dev-inbox@example.com";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
    if (condition) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}`);
        if (detail !== undefined) console.log("      got:", typeof detail === "string" ? detail : JSON.stringify(detail));
    }
}

const sent: { to: string; subject: string }[] = [];

globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string };
    sent.push({ to: Array.isArray(body.to) ? String(body.to[0]) : String(body.to), subject: String(body.subject) });
    return new Response(JSON.stringify({ id: "stub-id" }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function main() {
    const { sendEmail } = await import("@/lib/tools/sendEmail");
    const { sendBroadcast } = await import("@/lib/tools/sendBroadcast");

    const email = { to: "grace.adebayo@solmarastudio.com", subject: "Fuel receipts", body: "Please report in 48 hours." };
    const broadcast = {
        recipients: [
            { name: "Amina Bello", email: "amina.bello@solmarastudio.com" },
            { name: "Chidi Okonkwo", email: "chidi.okonkwo@solmarastudio.com" },
        ],
        subject: "Policy update",
        body: "Gloves are mandatory.",
    };

    // ── sandbox ON ────────────────────────────────────────────────────────────
    process.env.EMAIL_SANDBOX_MODE = "true";

    sent.length = 0;
    const sandboxEmail = await sendEmail(email);
    const sandboxEmailMessage = String(sandboxEmail.data?.message);
    console.log(`\n      sendEmail, sandbox ON, what the chat now says:\n      "${sandboxEmailMessage}"\n`);

    check("sendEmail (sandbox): the mail really went to the dev inbox", sent[0]?.to === "dev-inbox@example.com", sent[0]);
    check("sendEmail (sandbox): the message no longer claims it was sent to the real address", !sandboxEmailMessage.startsWith("Email sent to"), sandboxEmailMessage);
    check("sendEmail (sandbox): it names the address it was addressed to", sandboxEmailMessage.includes("grace.adebayo@solmarastudio.com"), sandboxEmailMessage);
    check("sendEmail (sandbox): it says it went to the dev inbox instead", /dev inbox/i.test(sandboxEmailMessage), sandboxEmailMessage);
    check("sendEmail (sandbox): the data records both addresses and the mode", sandboxEmail.data?.delivered_to === "dev-inbox@example.com" && sandboxEmail.data?.to === email.to && sandboxEmail.data?.sandbox === true, sandboxEmail.data);

    sent.length = 0;
    const sandboxBroadcast = await sendBroadcast(broadcast);
    const sandboxBroadcastMessage = String(sandboxBroadcast.data?.message);
    console.log(`      sendBroadcast, sandbox ON, what the chat now says:\n      "${sandboxBroadcastMessage}"\n`);

    check("sendBroadcast (sandbox): every send really went to the dev inbox", sent.length === 2 && sent.every((s) => s.to === "dev-inbox@example.com"), sent);
    check("sendBroadcast (sandbox): the message says so", /Sandbox mode: every message was delivered to the dev inbox/.test(sandboxBroadcastMessage), sandboxBroadcastMessage);
    check("sendBroadcast (sandbox): the exact counts and names are still reported", sandboxBroadcastMessage.startsWith("2/2 sent (Amina Bello, Chidi Okonkwo)"), sandboxBroadcastMessage);
    check("sendBroadcast (sandbox): per-recipient results keep their shape (retry depends on it)", JSON.stringify((sandboxBroadcast.data?.results as { name: string; email: string; success: boolean }[]).map((r) => [r.name, r.email, r.success])) === JSON.stringify([["Amina Bello", "amina.bello@solmarastudio.com", true], ["Chidi Okonkwo", "chidi.okonkwo@solmarastudio.com", true]]), sandboxBroadcast.data?.results);
    check("sendBroadcast (sandbox): the data records the mode", sandboxBroadcast.data?.sandbox === true);

    // ── sandbox OFF: nothing about live behavior changes ──────────────────────
    process.env.EMAIL_SANDBOX_MODE = "false";

    sent.length = 0;
    const liveEmail = await sendEmail(email);
    check("sendEmail (live): goes to the real address", sent[0]?.to === email.to, sent[0]);
    check("sendEmail (live): the message is unchanged", liveEmail.data?.message === "Email sent to grace.adebayo@solmarastudio.com.", liveEmail.data?.message);
    check("sendEmail (live): the subject has no sandbox prefix", sent[0]?.subject === "Fuel receipts", sent[0]?.subject);

    sent.length = 0;
    const liveBroadcast = await sendBroadcast(broadcast);
    const liveMessage = String(liveBroadcast.data?.message);
    check("sendBroadcast (live): goes to the real addresses", sent.map((s) => s.to).join() === "amina.bello@solmarastudio.com,chidi.okonkwo@solmarastudio.com", sent);
    check("sendBroadcast (live): the message is unchanged, no sandbox note", liveMessage === "2/2 sent (Amina Bello, Chidi Okonkwo).", liveMessage);
    check("sendBroadcast (live): the data says it was not sandboxed", liveBroadcast.data?.sandbox === false);

    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("test crashed:", err);
    process.exit(2);
});